# Forma Office

An open-format, local-first office, scientific notebook, whiteboard, and multimodal AI search suite compiled into **seven lightweight native macOS (`arm64`) applications** (~8.6 MB per suite app, 1.7 MB menu bar launcher — zero Electron).

Forma keeps your documents strictly on your Mac in standard open formats (`.xlsx`, `.docx`, `.pptx`, `.pdf`, `.ipynb`, `.md`, `.fcanvas`/`.excalidraw`) and pairs them with a self-contained **EmbeddingGemma 2 (Text + Vision)** search engine, global **`⌃Space`** Spotlight launcher, and a **10-tool MCP server** so AI coding assistants can search, read, and create real files directly inside your watched folders.

---

## Applications

| App | Bundle ID | Formats | Highlights |
| :--- | :--- | :--- | :--- |
| **Forma Sheets** | `com.formaoffice.sheets` | `.xlsx`, `.ods`, `.csv`, `.tsv` | Virtualized grid, incremental DAG formula engine (`XLOOKUP`, `SUMIFS`/`COUNTIFS`, dynamic `FILTER`/`UNIQUE`/`SORT` spill, pivot tables), charts round-tripped in `.xlsx`, live table transfer to Docs/Slides, `⌘F` find |
| **Forma Docs** | `com.formaoffice.docs` | `.docx`, `.odt`, `.md`, `.html`, Print/PDF | TipTap/ProseMirror rich editor, live in-place Obsidian-style KaTeX/LaTeX (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`, `Σ` insert menu), Paperwhite/Sepia/Night themes, `[[wikilinks]]`, live linked Sheets tables & Canvas diagrams with 1-click refresh, Mermaid diagrams, outline & review comments |
| **Forma Slides** | `com.formaoffice.slides` | `.pptx`, `.odp`, 16:9 vector `.pdf` | 16:9 drag/resize/nudge stage, native editable tables, 6 themes & 5 layouts, live linked Canvas diagrams with 1-click refresh, speaker notes, full-screen presenter mode (`⌥⌘P`) |
| **Forma PDF** | `com.formaoffice.pdf` | ISO 32000 `.pdf` | Zero-copy HTTP 206 Range streaming for large books, continuous scroll, Reading Mode (`⌘\`) with Paperwhite/Sepia/Night themes, AcroForm fill, redactions, highlight/text/ink/note baking, page reorder/rotate/merge/extract, document diff compare |
| **Forma Lab** | `com.formaoffice.lab` | `.ipynb` (nbformat 4.5), `.py`, `.md` | Persistent zero-dependency local Python 3 kernel (`macos/forma_kernel.py`), auto conda/venv/Homebrew discovery, Open Folder (`⇧⌘O`), interactive DataFrames, SQL queries, matplotlib PNG capture, KaTeX math, reactive `# @slider` controls, AST cell DAG, `sys.settrace` step scrubber |
| **Forma Canvas** | `com.formaoffice.canvas` | `.fcanvas`, `.excalidraw`, `.svg`, `.png`, `.pdf` | Infinite SVG whiteboard, sketchy/clean styles, smart bound connectors, Mermaid flowchart import, Excalidraw v2 compatibility, live embed into Forma Docs & Slides |
| **Forma Search** | `com.formaoffice.search` | All indexed formats + images | Menu bar Spotlight-style floating launcher (**`⌃Space`** default + built-in preset picker & custom shortcut recorder), two-stage instant lexical + multimodal EmbeddingGemma 2 hybrid search, kind filter pills (`All`, `Docs`, `Sheets`, `Slides`, `PDF`, `Lab`, `Canvas`, `Images`), `↵` open in Forma / `⌘↵` reveal in Finder |

---

## Self-Contained Multimodal Search & Background Indexer

Forma's semantic search runs **100% locally with zero Ollama and zero Python dependencies for indexing**:

- **Zero-Idle-RAM Runtime:** Uses an isolated `llama-server` + **EmbeddingGemma 2 (Text + Vision)** GGUF pair in `~/Library/Application Support/FormaOffice/{bin,models}` launched on demand and shut down cleanly after indexing/search idles.
- **Native macOS Daemons (`launchd`):**
  - `com.formaoffice.indexer`: FSEvents background watcher (`forma-indexer watch`) reacting cleanly to file edits/deletes/moves across watched folders.
  - `com.formaoffice.indexer-reconcile`: Scheduled daily catch-up reconcile at **02:00** local time.
- **Deep Content Coverage:** Indexes Forma Docs (+ inline images), Sheets, Slides (+ slide images), Lab Notebooks (+ matplotlib PNG charts), Canvas boards (+ embedded images), standalone images, and PDFs (+ Apple Vision OCR + up to 8 auto-rendered page JPEGs via PDFKit).
- **Hybrid Ranking:** SQLite FTS5 lexical search fused with Accelerate (`vDSP`) SIMD cosine similarity on normalized 768-dim multimodal embeddings.
- **Hub Management:** Manage watched roots (default: `~/Documents`, `~/Desktop`, `~/Downloads`) and trigger syncs from **Indexed Folders** in the Forma Start Hub or `⌘K`.

---

## Agent MCP Server (`mcp/forma-mcp`)

Forma ships a stdio MCP server exposing **10 tools** over the shared local index and native document engines (`Claude Code`, `Cursor`, `Gemini CLI`, and any stdio MCP client):

- **Search & Read:** `forma_search`, `forma_read` (supports Vision OCR via `ocr: true`), `forma_status`, `forma_index`, `forma_folders`, `forma_open`
- **Declarative File Creation:**
  - `forma_create_canvas` — Mermaid flowcharts or starter templates → `.fcanvas` / `.excalidraw`
  - `forma_create_sheet` — multi-sheet workbooks with styled headers and live Excel formulas (`=...`) → `.xlsx` / `.csv`
  - `forma_create_slides` — themed 16:9 decks with bullets & speaker notes → `.pptx`
  - `forma_create_doc` — Markdown (headings, lists, code blocks, pipe tables) → `.docx` / `.md`

Register with Claude Code in one command from the repository root:

```bash
claude mcp add --transport stdio forma -- node "$PWD/mcp/forma-mcp/index.mjs"
```

See [mcp/forma-mcp/README.md](mcp/forma-mcp/README.md) for JSON client configs, security details, and tool schemas.

---

## Security & Privacy

- **100% Local:** Zero cloud calls, zero telemetry, and zero outbound requests after optional model download.
- **Hardened IPC:** Embedded `llama-server` binds strictly to a private `0600` Unix-domain socket inside `~/Library/Application Support/FormaOffice/run/`.
- **Publisher SHA-256 Verification:** `npm run setup:embed` verifies exact SHA-256 checksums on both EmbeddingGemma 2 GGUF artifacts before installing.
- **Watched-Folder & HTML Boundaries:** Both `FormaFileGrants` (native host) and `mcp/forma-mcp` enforce canonical `realpath` watched-folder scoping and reject hidden paths/symlinks; document HTML is sanitized with `DOMPurify` under a strict CSP.

---

## Requirements & Quick Start

- **Platform:** Apple Silicon Mac (`arm64`), macOS 13.0+
- **Build Tools:** Xcode Command Line Tools (`swiftc`, `clang`, `codesign`), Node.js 20+ (`npm`)
- **Optional (for local multimodal AI embeddings):** `brew install llama.cpp` (only needed to stage `llama-server` via `npm run setup:embed`; all 7 apps and fast FTS5 lexical search work out of the box without it)

```bash
# 1. Install JS dependencies
npm ci

# 2. (Optional, recommended) Stage self-contained llama-server + EmbeddingGemma 2 models (~825 MB)
npm run setup:embed

# 3. Build web bundle, compile arm64 Swift apps & forma-indexer, ad-hoc sign & install to /Applications/
npm run build:mac

# 4. Install background FSEvents indexer & daily 02:00 reconcile LaunchAgents
npm run mac:install-indexer

# 5. Install & start Forma Search menu bar launcher (press ⌃Space from anywhere)
npm run mac:install-search

# 6. (Optional) Register Forma apps as macOS file handlers
npm run mac:set-defaults
```

For web-only local development (`http://localhost:5173`):

```bash
npm run dev
```

*(Note: Apps built from source are ad-hoc signed locally (`codesign --sign -`). If you later distribute `.dmg`/`.app` archives to other Macs without building locally, Apple Developer ID signing and notarization will be needed.)*

---

## Verification & Tests

```bash
npx tsc -b                          # Strict TypeScript check
npm test -- --run                   # Vitest unit & format round-trip suite (15 suites / 74 tests)
node scripts/verify-indexer.mjs     # E2E indexer, OCR/vision retrieval, and 10-tool MCP verification
node scripts/verify-index-watcher.mjs # E2E FSEvents watcher & LaunchAgent resilience tests
```

---

## Project Layout

- `src/` — React 18, TypeScript, Vite 6 frontend, document/sheet/slide/PDF/notebook/canvas codecs, TipTap extensions (`liveLatex.ts`), and IndexedDB storage (`src/storage/`)
- `macos/` — Native arm64 Cocoa/`WKWebView` app host (`FormaHost.swift`), Carbon/AppKit Spotlight launcher (`FormaSpotlight.swift`), FSEvents background indexer (`FormaIndexerCLI.swift`, `FormaIndexWatch.swift`), multimodal index & Unix-socket bridge (`FormaSemanticIndex.swift`, `FormaSocketHTTP.c`), Python kernel (`forma_kernel.py`), and app icon generator (`GenerateIcons.swift`)
- `mcp/forma-mcp/` — 10-tool stdio MCP server and declarative `.fcanvas`/`.xlsx`/`.pptx`/`.docx` creators
- `scripts/` — macOS app builder/installer (`build-macos-apps.sh`), model stager (`setup-embedded-models.sh`), LaunchAgent installers, and E2E verification harnesses
