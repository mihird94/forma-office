#!/usr/bin/env python3
"""
Forma Lab — Persistent JSON-RPC Python Kernel (Zero External Dependencies)
Runs inside Forma Lab.app over stdin/stdout newline-delimited JSON.
Features:
  - Persistent execution namespace across cells (IPython-like last-expr eval)
  - Auto-captures matplotlib figures (Agg backend) as Retina base64 PNGs
  - Rich display protocol (_repr_html_, _repr_png_, _repr_svg_, _repr_latex_)
  - Live variable inspector (types, shapes for numpy/torch/pandas, previews)
  - Clean SIGINT interrupt handling without killing the persistent session
"""
import ast
import base64
import io
import json
import math
import os
import reprlib
import signal
import sqlite3
import sys
import time
import traceback
import types

# Force non-interactive matplotlib backend if installed
os.environ.setdefault("MPLBACKEND", "Agg")

# Global persistent user namespace
NAMESPACE = {"__name__": "__main__", "__doc__": None}

_RPC_STREAM = None

def _init_rpc_stream():
    global _RPC_STREAM
    if _RPC_STREAM is not None:
        return
    try:
        rpc_fd = os.dup(1)
        os.dup2(2, 1)
        _RPC_STREAM = os.fdopen(rpc_fd, "w", encoding="utf-8", buffering=1)
    except Exception:
        _RPC_STREAM = sys.__stdout__
EXEC_COUNT = 0
_ACTIVE_OUTPUTS = None

# O(1) bounded repr so 2M-element lists/arrays format in <0.05ms instead of 100ms+
_FAST_REPR = reprlib.Repr()
_FAST_REPR.maxlist = 6
_FAST_REPR.maxtuple = 6
_FAST_REPR.maxdict = 6
_FAST_REPR.maxset = 6
_FAST_REPR.maxstring = 90
_FAST_REPR.maxother = 90


def _fast_preview(val, tname):
    try:
        preview = _FAST_REPR.repr(val).replace("\n", " ")
        if len(preview) > 90:
            preview = preview[:87] + "…"
        return preview
    except Exception:
        return f"<{tname}>"


class _StreamCapture(io.TextIOBase):
    def __init__(self, buf, stream_name="stdout", req_id=""):
        self._buf = buf
        self._stream_name = stream_name
        self._req_id = req_id
        self._pending = []
        self._pending_len = 0
        self._streamed_total = 0
        self._last_flush = time.monotonic()

    def _emit_pending(self, now=None):
        if not self._req_id or not self._pending:
            return
        if self._streamed_total >= 256000:
            self._pending.clear()
            self._pending_len = 0
            return
        chunk = "".join(self._pending)
        self._pending.clear()
        self._pending_len = 0
        remaining = 256000 - self._streamed_total
        if len(chunk) > remaining:
            chunk = chunk[:remaining]
        self._streamed_total += len(chunk)
        self._last_flush = now if now is not None else time.monotonic()
        if chunk:
            try:
                _send({
                    "type": "stream_chunk",
                    "reqId": self._req_id,
                    "name": self._stream_name,
                    "text": chunk,
                })
            except Exception:
                pass

    def write(self, s):
        if not s:
            return 0
        text = str(s)
        self._buf.append(text)
        if self._req_id:
            self._pending.append(text)
            self._pending_len += len(text)
            now = time.monotonic()
            elapsed = now - self._last_flush
            if elapsed >= 0.06 and ("\n" in text or self._pending_len >= 1024 or elapsed >= 0.12):
                self._emit_pending(now)
        return len(text)

    def flush(self):
        if self._req_id and self._pending:
            now = time.monotonic()
            if now - self._last_flush >= 0.06:
                self._emit_pending(now)


def _flush_matplotlib_figures(outputs):
    """Capture any open matplotlib figures as crisp 150-DPI PNG display_data."""
    if "matplotlib.pyplot" not in sys.modules:
        return
    try:
        plt = sys.modules["matplotlib.pyplot"]
        fig_nums = list(plt.get_fignums())
        for num in fig_nums:
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
            buf.seek(0)
            b64 = base64.b64encode(buf.read()).decode("ascii")
            outputs.append({
                "output_type": "display_data",
                "data": {"image/png": b64},
                "metadata": {},
            })
            plt.close(fig)
    except Exception:
        pass


def _close_all_matplotlib_figures():
    if "matplotlib.pyplot" in sys.modules:
        try:
            sys.modules["matplotlib.pyplot"].close("all")
        except Exception:
            pass


def _hook_matplotlib(outputs):
    """If matplotlib.pyplot is imported, hook plt.show() so plots capture inline for the active cell."""
    global _ACTIVE_OUTPUTS
    _ACTIVE_OUTPUTS = outputs
    if "matplotlib.pyplot" in sys.modules:
        plt = sys.modules["matplotlib.pyplot"]
        if not getattr(plt, "_forma_hooked", False):
            def _forma_show(*args, **kwargs):
                if _ACTIVE_OUTPUTS is not None:
                    _flush_matplotlib_figures(_ACTIVE_OUTPUTS)
            plt.show = _forma_show
            plt._forma_hooked = True


_MAX_TABLE_ROWS = 500
_MAX_TABLE_COLS = 50
_MAX_SQLITE_TABLE_ROWS = 50000


def _json_safe_cell(val):
    if val is None:
        return None
    tname = type(val).__name__
    if tname in ("NAType", "NaTType"):
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        return None if (math.isnan(val) or math.isinf(val)) else val
    if isinstance(val, str):
        return val if len(val) <= 2000 else val[:1997] + "…"
    # Handle numpy/pandas scalars cleanly via .item()
    if hasattr(val, "item") and callable(val.item) and not isinstance(val, (dict, list, tuple, set, bytes)):
        try:
            scalar = val.item()
            if scalar is not val:
                return _json_safe_cell(scalar)
        except Exception:
            pass
    try:
        s = str(val)
    except Exception:
        return f"<{tname}>"
    mod = getattr(type(val), "__module__", "")
    if s in ("nan", "NaN", "NaT", "<NA>") and mod.startswith(("numpy", "pandas", "polars")):
        return None
    return s if len(s) <= 2000 else s[:1997] + "…"


def _infer_column_dtypes(rows, num_cols):
    dtypes = []
    for c in range(num_cols):
        found = "null"
        for row in rows:
            if c < len(row) and row[c] is not None:
                v = row[c]
                if isinstance(v, bool):
                    found = "bool"
                elif isinstance(v, int):
                    found = "int"
                elif isinstance(v, float):
                    found = "float"
                else:
                    found = "str"
                break
        dtypes.append(found)
    return dtypes


def _extract_forma_table(val, max_rows=_MAX_TABLE_ROWS, max_cols=_MAX_TABLE_COLS):
    """Detect pandas/polars DataFrames or non-empty list of dicts and serialize to FormaTablePayload."""
    tname = type(val).__name__
    mod = getattr(type(val), "__module__", "")

    # 1. pandas.DataFrame
    if tname == "DataFrame" and mod.startswith("pandas"):
        total_rows = int(val.shape[0])
        total_cols = int(val.shape[1])
        sub = val.iloc[:max_rows, :max_cols]
        columns = [str(c) for c in sub.columns.tolist()]
        dtypes = [str(d) for d in sub.dtypes.tolist()]
        rows = [
            [_json_safe_cell(cell) for cell in row]
            for row in sub.itertuples(index=False, name=None)
        ]
        return {
            "columns": columns,
            "dtypes": dtypes,
            "rows": rows,
            "totalRows": total_rows,
            "totalCols": total_cols,
            "truncated": (total_rows > max_rows) or (total_cols > max_cols),
        }

    # 2. polars.DataFrame
    if tname == "DataFrame" and mod.startswith("polars"):
        total_rows = int(val.height)
        total_cols = int(val.width)
        cols = list(val.columns)[:max_cols]
        sub = val.select(cols).head(max_rows)
        dtypes = [str(d) for d in sub.dtypes]
        rows = [
            [_json_safe_cell(cell) for cell in row]
            for row in sub.iter_rows()
        ]
        return {
            "columns": [str(c) for c in cols],
            "dtypes": dtypes,
            "rows": rows,
            "totalRows": total_rows,
            "totalCols": total_cols,
            "truncated": (total_rows > max_rows) or (total_cols > max_cols),
        }

    # 3. Non-empty list of dicts
    if isinstance(val, list) and len(val) > 0 and all(isinstance(x, dict) for x in val[:20]):
        sample = val[:max_rows]
        all_keys = []
        seen = set()
        for item in sample:
            if isinstance(item, dict):
                for k in item.keys():
                    ks = str(k)
                    if ks not in seen:
                        seen.add(ks)
                        all_keys.append(k)
        if not all_keys:
            return None
        total_rows = len(val)
        total_cols = len(all_keys)
        kept_keys = all_keys[:max_cols]
        columns = [str(k) for k in kept_keys]
        rows = [
            [_json_safe_cell(item.get(k) if isinstance(item, dict) else None) for k in kept_keys]
            for item in sample
        ]
        dtypes = _infer_column_dtypes(rows, len(columns))
        return {
            "columns": columns,
            "dtypes": dtypes,
            "rows": rows,
            "totalRows": total_rows,
            "totalCols": total_cols,
            "truncated": (total_rows > max_rows) or (total_cols > max_cols),
        }

    return None


def _serialize_rich_result(val, exec_count):
    data = {}
    try:
        table_payload = _extract_forma_table(val)
        if table_payload is not None:
            data["application/vnd.forma.table+json"] = table_payload
    except Exception:
        pass

    try:
        if hasattr(val, "_repr_html_") and callable(val._repr_html_):
            html = val._repr_html_()
            if isinstance(html, str) and html.strip():
                if len(html) > 120_000:
                    html = html[:120_000] + "\n<div><em>… (HTML output truncated)</em></div>"
                data["text/html"] = html
    except Exception:
        pass

    try:
        if hasattr(val, "_repr_png_") and callable(val._repr_png_):
            png = val._repr_png_()
            if isinstance(png, (bytes, bytearray)):
                data["image/png"] = base64.b64encode(png).decode("ascii")
            elif isinstance(png, str):
                data["image/png"] = png
    except Exception:
        pass

    try:
        if hasattr(val, "_repr_svg_") and callable(val._repr_svg_):
            svg = val._repr_svg_()
            if isinstance(svg, str) and svg.strip():
                if len(svg) <= 250_000:
                    data["image/svg+xml"] = svg
                else:
                    data.setdefault("text/plain", "")
                    data["text/plain"] = f"[SVG output omitted ({len(svg)} bytes exceeds limit)]"
    except Exception:
        pass

    try:
        if hasattr(val, "_repr_latex_") and callable(val._repr_latex_):
            ltx = val._repr_latex_()
            if isinstance(ltx, str) and ltx.strip():
                data["text/latex"] = ltx
    except Exception:
        pass

    try:
        r = repr(val)
        if len(r) > 8000:
            r = r[:8000] + "\n… (truncated)"
        data["text/plain"] = r
    except Exception:
        data["text/plain"] = str(type(val))

    return {
        "output_type": "execute_result",
        "execution_count": exec_count,
        "data": data,
        "metadata": {},
    }


def _inspect_variables():
    items = []
    for name, val in list(NAMESPACE.items()):
        if name.startswith("_"):
            continue
        if isinstance(val, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
            continue
        tname = type(val).__name__
        shape = ""
        try:
            if hasattr(val, "shape") and not isinstance(val, (str, bytes)):
                sh = getattr(val, "shape")
                shape = str(tuple(sh)) if hasattr(sh, "__iter__") and not isinstance(sh, (str, bytes)) else str(sh)
            elif isinstance(val, (list, tuple, dict, set, str, bytes)):
                shape = f"len={len(val)}"
        except Exception:
            pass

        preview = _fast_preview(val, tname)

        items.append({
            "name": name,
            "type": tname,
            "shape": shape,
            "preview": preview,
        })
    items.sort(key=lambda x: x["name"].lower())
    return items[:120]


def _split_sql_statements(sql_text):
    """Split a SQL script into individual statements, respecting quotes and SQL comments."""
    stmts = []
    buf = []
    i = 0
    n = len(sql_text)
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False

    while i < n:
        ch = sql_text[i]
        nxt = sql_text[i + 1] if i + 1 < n else ""

        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            buf.append(ch)
            if ch == "*" and nxt == "/":
                buf.append("/")
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            buf.append(ch)
            if ch == "'":
                if nxt == "'":
                    buf.append("'")
                    i += 2
                    continue
                in_single = False
            i += 1
            continue

        if in_double:
            buf.append(ch)
            if ch == '"':
                if nxt == '"':
                    buf.append('"')
                    i += 2
                    continue
                in_double = False
            i += 1
            continue

        if ch == "-" and nxt == "-":
            buf.append("--")
            in_line_comment = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            buf.append("/*")
            in_block_comment = True
            i += 2
            continue
        if ch == "'":
            in_single = True
            buf.append(ch)
            i += 1
            continue
        if ch == '"':
            in_double = True
            buf.append(ch)
            i += 1
            continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                stmts.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        stmts.append(tail)
    return stmts


def _quote_sql_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def _sqlite_safe_val(val):
    v = _json_safe_cell(val)
    if v is None or isinstance(v, (int, float, str)):
        return v
    if isinstance(v, bool):
        return 1 if v else 0
    return str(v)


def _sqlite_col_affinity(sample_rows, col_idx):
    for row in sample_rows:
        if col_idx < len(row) and row[col_idx] is not None:
            v = row[col_idx]
            if isinstance(v, bool):
                return "INTEGER"
            if isinstance(v, int):
                return "INTEGER"
            if isinstance(v, float):
                return "REAL"
            return "TEXT"
    return "TEXT"


def _format_plain_table(columns, rows, total_rows, total_cols, engine_label):
    if not columns:
        return f"(0 rows · {engine_label})"
    preview_cols = columns[:12]
    preview_rows = rows[:20]
    col_widths = [min(28, max(len(c), 4)) for c in preview_cols]
    str_rows = []
    for row in preview_rows:
        srow = []
        for idx in range(len(preview_cols)):
            val = row[idx] if idx < len(row) else None
            s = "NULL" if val is None else str(val)
            if len(s) > 28:
                s = s[:27] + "…"
            if len(s) > col_widths[idx]:
                col_widths[idx] = len(s)
            srow.append(s)
        str_rows.append(srow)

    header = " | ".join(c[:28].ljust(col_widths[i]) for i, c in enumerate(preview_cols))
    sep = "-+-".join("-" * w for w in col_widths)
    lines = [header, sep]
    for srow in str_rows:
        lines.append(" | ".join(srow[i].ljust(col_widths[i]) for i in range(len(preview_cols))))
    if total_rows > len(preview_rows) or total_cols > len(preview_cols):
        lines.append(f"… ({total_rows} rows × {total_cols} cols · {engine_label})")
    else:
        lines.append(f"({total_rows} rows × {total_cols} cols · {engine_label})")
    return "\n".join(lines)


def _register_sqlite_tables(conn):
    """Register pandas/polars DataFrames and non-empty list-of-dicts from NAMESPACE into SQLite."""
    cur = conn.cursor()
    for name, val in list(NAMESPACE.items()):
        if not name or name.startswith("_"):
            continue
        tname = type(val).__name__
        mod = getattr(type(val), "__module__", "")
        cols = None
        raw_rows = None

        try:
            if tname == "DataFrame" and mod.startswith("pandas"):
                sub = val.iloc[:_MAX_SQLITE_TABLE_ROWS]
                cols = [str(c) for c in sub.columns.tolist()]
                raw_rows = [
                    tuple(_sqlite_safe_val(cell) for cell in row)
                    for row in sub.itertuples(index=False, name=None)
                ]
            elif tname == "DataFrame" and mod.startswith("polars"):
                sub = val.head(_MAX_SQLITE_TABLE_ROWS)
                cols = [str(c) for c in sub.columns]
                raw_rows = [
                    tuple(_sqlite_safe_val(cell) for cell in row)
                    for row in sub.iter_rows()
                ]
            elif isinstance(val, list) and len(val) > 0 and all(isinstance(x, dict) for x in val[:20]):
                sample = val[:_MAX_SQLITE_TABLE_ROWS]
                all_keys = []
                seen = set()
                for item in sample:
                    if isinstance(item, dict):
                        for k in item.keys():
                            ks = str(k)
                            if ks not in seen:
                                seen.add(ks)
                                all_keys.append(k)
                if all_keys:
                    cols = [str(k) for k in all_keys]
                    raw_rows = [
                        tuple(_sqlite_safe_val(item.get(k) if isinstance(item, dict) else None) for k in all_keys)
                        for item in sample
                    ]
        except Exception:
            continue

        if not cols:
            continue

        try:
            col_defs = []
            sample_for_types = raw_rows[:50] if raw_rows else []
            for idx, c in enumerate(cols):
                aff = _sqlite_col_affinity(sample_for_types, idx)
                col_defs.append(f"{_quote_sql_ident(c)} {aff}")
            tbl = _quote_sql_ident(name)
            cur.execute(f"DROP TABLE IF EXISTS {tbl}")
            cur.execute(f"CREATE TABLE {tbl} ({', '.join(col_defs)})")
            if raw_rows:
                placeholders = ", ".join(["?"] * len(cols))
                cur.executemany(f"INSERT INTO {tbl} VALUES ({placeholders})", raw_rows)
        except Exception:
            continue
    conn.commit()


def _infer_duckdb_col_type(rows_data, col_idx):
    seen_types = set()
    for row in rows_data[:200]:
        v = row[col_idx] if col_idx < len(row) else None
        if v is None:
            continue
        if isinstance(v, bool):
            seen_types.add("bool")
        elif isinstance(v, int):
            seen_types.add("int")
        elif isinstance(v, float):
            seen_types.add("float")
        else:
            seen_types.add("str")
    if not seen_types or "str" in seen_types:
        return "VARCHAR"
    if seen_types == {"bool"}:
        return "BOOLEAN"
    if seen_types == {"int"}:
        return "BIGINT"
    if seen_types.issubset({"int", "float"}):
        return "DOUBLE"
    return "VARCHAR"


def _insert_duckdb_table(con, name, cols, rows_data):
    if not cols:
        return
    col_types = [_infer_duckdb_col_type(rows_data, idx) for idx in range(len(cols))]
    cols_q = ", ".join(f"{_quote_sql_ident(c)} {col_types[idx]}" for idx, c in enumerate(cols))
    tbl = _quote_sql_ident(name)
    con.execute(f"DROP TABLE IF EXISTS {tbl}")
    con.execute(f"CREATE TABLE {tbl} ({cols_q})")
    if rows_data:
        placeholders = ", ".join(["?"] * len(cols))
        final_rows = [
            [
                (None if cell is None else (str(cell) if col_types[ci] == "VARCHAR" else cell))
                for ci, cell in enumerate(row)
            ]
            for row in rows_data
        ]
        con.executemany(f"INSERT INTO {tbl} VALUES ({placeholders})", final_rows)


def _execute_sql_duckdb(duckdb_mod, statements):
    con = duckdb_mod.connect(":memory:")
    try:
        for name, val in list(NAMESPACE.items()):
            if not name or name.startswith("_"):
                continue
            tname = type(val).__name__
            mod = getattr(type(val), "__module__", "")
            try:
                if (tname == "DataFrame" and mod.startswith(("pandas", "polars"))) or (
                    tname == "Table" and mod.startswith("pyarrow")
                ):
                    try:
                        con.register(name, val)
                    except Exception:
                        # Fallback for pandas 3.x Arrow StringDtype or incompatible dtypes in older DuckDB
                        if tname == "DataFrame" and mod.startswith("pandas"):
                            sub = val.iloc[:_MAX_SQLITE_TABLE_ROWS]
                            cols = [str(c) for c in sub.columns.tolist()]
                            rows_data = [
                                [_json_safe_cell(cell) for cell in row]
                                for row in sub.itertuples(index=False, name=None)
                            ]
                            _insert_duckdb_table(con, name, cols, rows_data)
                        elif tname == "DataFrame" and mod.startswith("polars"):
                            sub = val.head(_MAX_SQLITE_TABLE_ROWS)
                            cols = [str(c) for c in sub.columns]
                            rows_data = [
                                [_json_safe_cell(cell) for cell in row]
                                for row in sub.iter_rows()
                            ]
                            _insert_duckdb_table(con, name, cols, rows_data)
                elif isinstance(val, list) and len(val) > 0 and all(isinstance(x, dict) for x in val[:20]):
                    sample = val[:_MAX_SQLITE_TABLE_ROWS]
                    all_keys = []
                    seen = set()
                    for item in sample:
                        if isinstance(item, dict):
                            for k in item.keys():
                                ks = str(k)
                                if ks not in seen:
                                    seen.add(ks)
                                    all_keys.append(k)
                    if all_keys:
                        rows_data = [
                            [_json_safe_cell(it.get(k) if isinstance(it, dict) else None) for k in all_keys]
                            for it in sample
                        ]
                        _insert_duckdb_table(con, name, [str(k) for k in all_keys], rows_data)
            except Exception:
                continue

        last_cols = None
        last_rows = None
        last_dtypes = None
        for stmt in statements:
            rel = con.execute(stmt)
            if rel.description:
                last_cols = [str(d[0]) for d in rel.description]
                last_dtypes = [str(d[1]) if len(d) > 1 and d[1] is not None else "" for d in rel.description]
                last_rows = rel.fetchall()
        return last_cols, last_dtypes, last_rows, "DuckDB"
    finally:
        try:
            con.close()
        except Exception:
            pass


def _execute_sql_sqlite(statements):
    conn = sqlite3.connect(":memory:")
    try:
        _register_sqlite_tables(conn)
        cur = conn.cursor()
        last_cols = None
        last_rows = None
        for stmt in statements:
            cur.execute(stmt)
            if cur.description:
                last_cols = [str(d[0]) for d in cur.description]
                last_rows = cur.fetchall()
        return last_cols, None, last_rows, "SQLite"
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _execute_sql(sql_code, req_id=""):
    global EXEC_COUNT
    EXEC_COUNT += 1
    t0 = time.perf_counter()

    # Strip optional leading %%sql magic line
    stripped = sql_code.lstrip()
    if stripped.startswith("%%sql"):
        nl = stripped.find("\n")
        sql_body = stripped[nl + 1:] if nl != -1 else ""
    else:
        sql_body = sql_code

    statements = _split_sql_statements(sql_body)
    if not statements:
        return {
            "ok": True,
            "execution_count": EXEC_COUNT,
            "elapsed_ms": int(round((time.perf_counter() - t0) * 1000)),
            "outputs": [],
            "variables": _inspect_variables(),
        }

    duckdb_mod = None
    try:
        import duckdb as _ddb  # type: ignore
        duckdb_mod = _ddb
    except Exception:
        duckdb_mod = None

    outputs = []
    ok = True
    try:
        if duckdb_mod is not None:
            cols, raw_dtypes, raw_rows, engine_label = _execute_sql_duckdb(duckdb_mod, statements)
        else:
            cols, raw_dtypes, raw_rows, engine_label = _execute_sql_sqlite(statements)

        if cols is not None and raw_rows is not None:
            total_rows = len(raw_rows)
            total_cols = len(cols)
            kept_cols = cols[:_MAX_TABLE_COLS]
            kept_rows = [
                [_json_safe_cell(cell) for cell in row[:_MAX_TABLE_COLS]]
                for row in raw_rows[:_MAX_TABLE_ROWS]
            ]
            if raw_dtypes and any(raw_dtypes[:_MAX_TABLE_COLS]):
                dtypes = [d or "any" for d in raw_dtypes[:_MAX_TABLE_COLS]]
            else:
                dtypes = _infer_column_dtypes(kept_rows, len(kept_cols))

            table_payload = {
                "columns": kept_cols,
                "dtypes": dtypes,
                "rows": kept_rows,
                "totalRows": total_rows,
                "totalCols": total_cols,
                "truncated": (total_rows > _MAX_TABLE_ROWS) or (total_cols > _MAX_TABLE_COLS),
            }
            plain = _format_plain_table(kept_cols, kept_rows, total_rows, total_cols, engine_label)
            outputs.append({
                "output_type": "execute_result",
                "execution_count": EXEC_COUNT,
                "data": {
                    "application/vnd.forma.table+json": table_payload,
                    "text/plain": plain,
                },
                "metadata": {"sql_engine": engine_label},
            })
        else:
            outputs.append({
                "output_type": "execute_result",
                "execution_count": EXEC_COUNT,
                "data": {
                    "text/plain": f"Query executed successfully ({engine_label}).",
                },
                "metadata": {"sql_engine": engine_label},
            })
    except KeyboardInterrupt:
        ok = False
        outputs.append({
            "output_type": "error",
            "ename": "KeyboardInterrupt",
            "evalue": "SQL query interrupted by user",
            "traceback": ["KeyboardInterrupt: SQL query interrupted by user"],
        })
    except BaseException as exc:
        ok = False
        engine_hint = "DuckDB" if duckdb_mod is not None else "SQLite"
        tb_lines = [f"{type(exc).__name__} ({engine_hint}): {exc}"]
        outputs.append({
            "output_type": "error",
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": tb_lines,
        })

    elapsed_ms = int(round((time.perf_counter() - t0) * 1000))
    return {
        "ok": ok,
        "execution_count": EXEC_COUNT,
        "elapsed_ms": elapsed_ms,
        "outputs": outputs,
        "variables": _inspect_variables(),
    }


def _execute_code(code, req_id=""):
    if isinstance(code, str) and code.lstrip().startswith("%%sql"):
        return _execute_sql(code, req_id=req_id)

    global EXEC_COUNT
    EXEC_COUNT += 1
    outputs = []
    stdout_buf = []
    stderr_buf = []

    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = _StreamCapture(stdout_buf, "stdout", req_id)
    sys.stderr = _StreamCapture(stderr_buf, "stderr", req_id)

    t0 = time.perf_counter()
    ok = True
    try:
        _hook_matplotlib(outputs)
        tree = ast.parse(code, filename="<cell>", mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(body=tree.body.pop().value)
            ast.fix_missing_locations(last_expr)

        if tree.body:
            exec(compile(tree, "<cell>", "exec"), NAMESPACE, NAMESPACE)
            _hook_matplotlib(outputs)

        if last_expr is not None:
            val = eval(compile(last_expr, "<cell>", "eval"), NAMESPACE, NAMESPACE)
            _hook_matplotlib(outputs)
            if val is not None:
                outputs.append(_serialize_rich_result(val, EXEC_COUNT))

        _flush_matplotlib_figures(outputs)
    except KeyboardInterrupt:
        ok = False
        outputs.append({
            "output_type": "error",
            "ename": "KeyboardInterrupt",
            "evalue": "Execution interrupted by user",
            "traceback": ["KeyboardInterrupt: Execution interrupted by user"],
        })
    except BaseException as exc:
        ok = False
        tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
        outputs.append({
            "output_type": "error",
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": [line.rstrip("\n") for line in tb_lines],
        })
    finally:
        _close_all_matplotlib_figures()
        sys.stdout = old_out
        sys.stderr = old_err

    elapsed_ms = int(round((time.perf_counter() - t0) * 1000))

    stream_outputs = []
    if stdout_buf:
        out_text = "".join(stdout_buf)
        if len(out_text) > 256000:
            out_text = out_text[:256000] + "\n… (stdout truncated at 256 KB)"
        stream_outputs.append({
            "output_type": "stream",
            "name": "stdout",
            "text": out_text,
        })
    if stderr_buf:
        err_text = "".join(stderr_buf)
        if len(err_text) > 256000:
            err_text = err_text[:256000] + "\n… (stderr truncated at 256 KB)"
        stream_outputs.append({
            "output_type": "stream",
            "name": "stderr",
            "text": err_text,
        })

    return {
        "ok": ok,
        "execution_count": EXEC_COUNT,
        "elapsed_ms": elapsed_ms,
        "outputs": stream_outputs + outputs,
        "variables": _inspect_variables(),
    }


def _snapshot_scope(scope_dict, prev_map):
    items = []
    next_map = {}
    for name, val in list(scope_dict.items()):
        if name.startswith("_"):
            continue
        if isinstance(val, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
            continue
        tname = type(val).__name__
        shape = ""
        try:
            if hasattr(val, "shape") and not isinstance(val, (str, bytes)):
                sh = getattr(val, "shape")
                shape = str(tuple(sh)) if hasattr(sh, "__iter__") and not isinstance(sh, (str, bytes)) else str(sh)
            elif isinstance(val, (list, tuple, dict, set, str, bytes)):
                shape = f"len={len(val)}"
        except Exception:
            pass
        preview = _fast_preview(val, tname)

        sig = f"{tname}|{shape}|{preview}"
        next_map[name] = sig
        changed = (name not in prev_map) or (prev_map[name] != sig)
        items.append({
            "name": name,
            "type": tname,
            "shape": shape,
            "preview": preview,
            "changed": changed,
        })
    items.sort(key=lambda x: (0 if x["changed"] else 1, x["name"].lower()))
    return items[:48], next_map


def _trace_code(code, max_steps=300):
    global EXEC_COUNT
    EXEC_COUNT += 1
    outputs = []
    stdout_buf = []
    stderr_buf = []
    steps = []
    truncated = False
    prev_map = {}

    # Seed prev_map from current NAMESPACE so pre-existing variables don't all look newly changed on step 1
    _, prev_map = _snapshot_scope(NAMESPACE, {})

    def tracer(frame, event, arg):
        nonlocal truncated, prev_map
        if frame.f_code.co_filename != "<cell>":
            return None
        if truncated:
            return None
        if event in ("line", "return"):
            if len(steps) >= max_steps:
                truncated = True
                sys.settrace(None)
                return None
            # For module-level frame, f_locals IS NAMESPACE; for inside functions, show f_locals
            scope = frame.f_locals
            snap, prev_map = _snapshot_scope(scope, prev_map)
            cur_out = "".join(stdout_buf)
            if len(cur_out) > 4000:
                cur_out = "…\n" + cur_out[-4000:]
            steps.append({
                "step": len(steps) + 1,
                "line": frame.f_lineno,
                "func": frame.f_code.co_name,
                "event": event,
                "stdout": cur_out,
                "locals": snap,
            })
        return tracer

    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = _StreamCapture(stdout_buf)
    sys.stderr = _StreamCapture(stderr_buf)

    t0 = time.perf_counter()
    ok = True
    try:
        _hook_matplotlib(outputs)
        tree = ast.parse(code, filename="<cell>", mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(body=tree.body.pop().value)
            ast.fix_missing_locations(last_expr)

        sys.settrace(tracer)
        try:
            if tree.body:
                exec(compile(tree, "<cell>", "exec"), NAMESPACE, NAMESPACE)
                _hook_matplotlib(outputs)

            if last_expr is not None:
                val = eval(compile(last_expr, "<cell>", "eval"), NAMESPACE, NAMESPACE)
                _hook_matplotlib(outputs)
                if val is not None:
                    outputs.append(_serialize_rich_result(val, EXEC_COUNT))
        finally:
            sys.settrace(None)

        _flush_matplotlib_figures(outputs)
    except KeyboardInterrupt:
        ok = False
        outputs.append({
            "output_type": "error",
            "ename": "KeyboardInterrupt",
            "evalue": "Execution interrupted by user",
            "traceback": ["KeyboardInterrupt: Execution interrupted by user"],
        })
    except BaseException as exc:
        ok = False
        tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
        outputs.append({
            "output_type": "error",
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": [line.rstrip("\n") for line in tb_lines],
        })
    finally:
        sys.settrace(None)
        _close_all_matplotlib_figures()
        sys.stdout = old_out
        sys.stderr = old_err

    elapsed_ms = int(round((time.perf_counter() - t0) * 1000))

    stream_outputs = []
    if stdout_buf:
        stream_outputs.append({
            "output_type": "stream",
            "name": "stdout",
            "text": "".join(stdout_buf),
        })
    if stderr_buf:
        stream_outputs.append({
            "output_type": "stream",
            "name": "stderr",
            "text": "".join(stderr_buf),
        })

    return {
        "ok": ok,
        "execution_count": EXEC_COUNT,
        "elapsed_ms": elapsed_ms,
        "outputs": stream_outputs + outputs,
        "variables": _inspect_variables(),
        "trace": {
            "steps": steps,
            "truncated": truncated,
        },
    }


def _send(obj):
    raw = json.dumps(obj, ensure_ascii=False)
    safe = raw.encode("utf-8", errors="replace").decode("utf-8")
    stream = _RPC_STREAM if _RPC_STREAM is not None else sys.__stdout__
    stream.write(safe + "\n")
    stream.flush()


def main():
    global NAMESPACE, EXEC_COUNT
    _init_rpc_stream()
    # Send startup hello so Swift knows kernel is ready
    _send({
        "type": "ready",
        "python_version": sys.version.split()[0],
        "executable": sys.executable,
    })

    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            continue
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue

        mtype = msg.get("type")
        req_id = msg.get("reqId", "")

        if mtype in ("exec", "trace", "sql"):
            cwd = msg.get("cwd")
            if isinstance(cwd, str) and cwd and os.path.isdir(cwd):
                try:
                    os.chdir(cwd)
                    if cwd not in sys.path:
                        sys.path.insert(0, cwd)
                except Exception:
                    pass
            if mtype == "trace":
                max_steps = int(msg.get("max_steps", 300) or 300)
                res = _trace_code(msg.get("code", ""), max_steps=max(10, min(800, max_steps)))
                _send({"type": "trace_result", "reqId": req_id, **res})
            elif mtype == "sql":
                res = _execute_sql(msg.get("code", ""), req_id=req_id)
                _send({"type": "result", "reqId": req_id, **res})
            else:
                res = _execute_code(msg.get("code", ""), req_id=req_id)
                _send({"type": "result", "reqId": req_id, **res})
        elif mtype == "reset":
            _close_all_matplotlib_figures()
            NAMESPACE = {"__name__": "__main__", "__doc__": None}
            EXEC_COUNT = 0
            _send({"type": "reset_ok", "reqId": req_id, "variables": []})
        elif mtype == "inspect":
            _send({"type": "variables", "reqId": req_id, "variables": _inspect_variables()})


if __name__ == "__main__":
    main()
