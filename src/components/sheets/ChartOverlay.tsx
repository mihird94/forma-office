import React, { useMemo, useRef } from 'react';
import { BarChart3, LineChart, PieChart, AreaChart, X } from 'lucide-react';
import { ChartSpec, ChartType, ComputedCell } from '../../types/spreadsheet';
import { coordToAddress, parseRange } from '../../engine/spreadsheet/address';

interface ChartOverlayProps {
  chart: ChartSpec;
  computed: Record<string, ComputedCell>;
  zoom?: number;
  onBeginChange?: () => void;
  onUpdate: (updated: ChartSpec, recordHistory?: boolean) => void;
  onDelete: (id: string) => void;
}

const PALETTE = ['#059669', '#2563eb', '#d97706', '#7c3aed', '#e11d48', '#0891b2'];

export const ChartOverlay: React.FC<ChartOverlayProps> = ({
  chart,
  computed,
  zoom = 1,
  onBeginChange,
  onUpdate,
  onDelete,
}) => {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  );

  const parsedData = useMemo(() => {
    const parsed = parseRange(chart.dataRange);
    if (!parsed) return { categories: [] as string[], series: [] as { name: string; values: number[] }[] };

    const r1 = Math.min(parsed.start.row, parsed.end.row);
    const r2 = Math.max(parsed.start.row, parsed.end.row);
    const c1 = Math.min(parsed.start.col, parsed.end.col);
    const c2 = Math.max(parsed.start.col, parsed.end.col);

    // Column-oriented 2-column table (e.g. A4:B10 or A5:B10 where col A = categories, col B = values)
    if (c2 - c1 === 1 && r2 - r1 >= 1) {
      const firstVal = computed[coordToAddress(r1, c2)]?.value;
      const hasHeaderRow = typeof firstVal !== 'number';
      const startRow = hasHeaderRow ? r1 + 1 : r1;
      const seriesName = hasHeaderRow
        ? computed[coordToAddress(r1, c2)]?.formatted || chart.title
        : (r1 > 0 ? computed[coordToAddress(r1 - 1, c2)]?.formatted : '') || chart.title;

      const categories: string[] = [];
      const values: number[] = [];
      let hasNum = false;
      for (let r = startRow; r <= r2; r++) {
        const label = computed[coordToAddress(r, c1)]?.formatted || `Row ${r + 1}`;
        const v = computed[coordToAddress(r, c2)]?.value;
        const num = typeof v === 'number' && Number.isFinite(v) ? v : 0;
        if (typeof v === 'number') hasNum = true;
        categories.push(label);
        values.push(num);
      }
      return {
        categories,
        series: hasNum ? [{ name: seriesName, values }] : [],
      };
    }

    // Row r1 = column headers (categories across cols c1+1..c2), Rows r1+1..r2 = series
    const categories: string[] = [];
    for (let c = c1 + 1; c <= c2; c++) {
      const cell = computed[coordToAddress(r1, c)];
      categories.push(cell?.formatted || `Col ${c + 1}`);
    }

    const series: { name: string; values: number[] }[] = [];
    for (let r = r1 + 1; r <= r2; r++) {
      const name = computed[coordToAddress(r, c1)]?.formatted || `Row ${r + 1}`;
      const values: number[] = [];
      let hasNum = false;
      for (let c = c1 + 1; c <= c2; c++) {
        const v = computed[coordToAddress(r, c)]?.value;
        const num = typeof v === 'number' && Number.isFinite(v) ? v : 0;
        if (typeof v === 'number') hasNum = true;
        values.push(num);
      }
      if (hasNum) series.push({ name, values });
    }
    return { categories, series };
  }, [chart.dataRange, computed]);

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    onBeginChange?.();
    const scale = zoom || 1;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: chart.x,
      origY: chart.y,
    };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = (ev.clientX - dragRef.current.startX) / scale;
      const dy = (ev.clientY - dragRef.current.startY) / scale;
      onUpdate({
        ...chart,
        x: Math.max(0, Math.round(dragRef.current.origX + dx)),
        y: Math.max(0, Math.round(dragRef.current.origY + dy)),
      }, false);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const chartTypes: { id: ChartType; icon: React.ReactNode; label: string }[] = [
    { id: 'bar', icon: <BarChart3 className="w-3.5 h-3.5" />, label: 'Bar' },
    { id: 'line', icon: <LineChart className="w-3.5 h-3.5" />, label: 'Line' },
    { id: 'area', icon: <AreaChart className="w-3.5 h-3.5" />, label: 'Area' },
    { id: 'pie', icon: <PieChart className="w-3.5 h-3.5" />, label: 'Pie' },
  ];

  const { categories, series } = parsedData;
  const svgW = Math.max(280, chart.width - 24);
  const svgH = Math.max(150, chart.height - 86);
  const padL = 56;
  const padR = 16;
  const padT = 14;
  const padB = 28;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const allVals = series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allVals, 0);
  const minVal = Math.min(0, ...allVals);
  const span = Math.max(1, maxVal - minVal);
  const yScale = (v: number) => padT + plotH - ((v - minVal) / span) * plotH;

  const formatAxisVal = (v: number) => {
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
    return String(Math.round(v));
  };

  return (
    <div
      style={{
        left: chart.x,
        top: chart.y,
        width: chart.width,
        height: chart.height,
      }}
      className="absolute z-20 bg-white/95 backdrop-blur border border-slate-200 rounded-xl shadow-lg flex flex-col overflow-hidden select-none"
    >
      {/* Draggable header */}
      <div
        onMouseDown={handleHeaderMouseDown}
        className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between cursor-move"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-slate-800 truncate">{chart.title}</span>
          <span className="text-[10px] font-mono text-slate-500 bg-slate-200/70 px-1.5 py-0.5 rounded">
            {chart.dataRange}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {chartTypes.map((ct) => (
            <button
              key={ct.id}
              title={`${ct.label} Chart`}
              onClick={() => onUpdate({ ...chart, type: ct.id }, true)}
              className={`p-1 rounded transition ${
                chart.type === ct.id
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'text-slate-500 hover:bg-slate-200/70'
              }`}
            >
              {ct.icon}
            </button>
          ))}
          <button
            title="Remove chart"
            onClick={() => onDelete(chart.id)}
            className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 ml-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Chart Body */}
      <div className="flex-1 px-3 py-2 flex flex-col justify-between">
        {categories.length === 0 || series.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
            Select a numeric table with row &amp; column labels to render a chart.
          </div>
        ) : chart.type === 'pie' ? (
          <div className="flex items-center justify-center flex-1 gap-6">
            {(() => {
              const firstSeries = series[series.length - 1];
              const total = firstSeries.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
              const radius = Math.min(svgW * 0.25, svgH * 0.44);
              const cx = radius + 8;
              const cy = radius + 8;
              let cumAngle = -Math.PI / 2;

              return (
                <svg width={(radius + 8) * 2} height={(radius + 8) * 2}>
                  {firstSeries.values.map((val, i) => {
                    const frac = Math.max(0, val) / total;
                    const angle = frac * Math.PI * 2;
                    const x1 = cx + radius * Math.cos(cumAngle);
                    const y1 = cy + radius * Math.sin(cumAngle);
                    const x2 = cx + radius * Math.cos(cumAngle + angle);
                    const y2 = cy + radius * Math.sin(cumAngle + angle);
                    const largeArc = angle > Math.PI ? 1 : 0;
                    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
                    cumAngle += angle;
                    return (
                      <path
                        key={i}
                        d={d}
                        fill={PALETTE[i % PALETTE.length]}
                        stroke="#ffffff"
                        strokeWidth={1.5}
                      >
                        <title>
                          {categories[i]}: {val.toLocaleString()} ({(frac * 100).toFixed(1)}%)
                        </title>
                      </path>
                    );
                  })}
                </svg>
              );
            })()}
            <div className="flex flex-col gap-1.5 text-[11px] text-slate-700">
              <div className="font-semibold text-slate-800">{series[series.length - 1].name}</div>
              {categories.map((cat, i) => (
                <div key={cat} className="flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-sm inline-block"
                    style={{ background: PALETTE[i % PALETTE.length] }}
                  />
                  <span>{cat}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <svg width={svgW} height={svgH} className="overflow-visible">
              {/* Grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                const v = minVal + t * span;
                const y = yScale(v);
                return (
                  <g key={t}>
                    <line
                      x1={padL}
                      x2={padL + plotW}
                      y1={y}
                      y2={y}
                      stroke="#e2e8f0"
                      strokeDasharray={t === 0 ? undefined : '3,3'}
                    />
                    <text
                      x={padL - 6}
                      y={y + 3}
                      textAnchor="end"
                      className="fill-slate-400 text-[10px]"
                    >
                      {formatAxisVal(v)}
                    </text>
                  </g>
                );
              })}

              {/* Bars */}
              {chart.type === 'bar' &&
                categories.map((cat, cIdx) => {
                  const groupW = plotW / categories.length;
                  const innerPad = Math.min(14, groupW * 0.16);
                  const barW = Math.max(4, (groupW - innerPad * 2) / Math.max(1, series.length) - 2);
                  const baseY = yScale(0);
                  return (
                    <g key={cat}>
                      {series.map((s, sIdx) => {
                        const val = s.values[cIdx] ?? 0;
                        const y = yScale(Math.max(0, val));
                        const h = Math.max(1, Math.abs(yScale(val) - baseY));
                        const x = padL + cIdx * groupW + innerPad + sIdx * (barW + 2);
                        return (
                          <rect
                            key={s.name}
                            x={x}
                            y={val >= 0 ? y : baseY}
                            width={barW}
                            height={h}
                            rx={2}
                            fill={PALETTE[sIdx % PALETTE.length]}
                          >
                            <title>
                              {s.name} ({cat}): {val.toLocaleString()}
                            </title>
                          </rect>
                        );
                      })}
                      <text
                        x={padL + cIdx * groupW + groupW / 2}
                        y={svgH - 6}
                        textAnchor="middle"
                        className="fill-slate-500 text-[10px]"
                      >
                        {cat}
                      </text>
                    </g>
                  );
                })}

              {/* Line / Area */}
              {(chart.type === 'line' || chart.type === 'area') && (
                <>
                  {series.map((s, sIdx) => {
                    const color = PALETTE[sIdx % PALETTE.length];
                    const stepX =
                      categories.length > 1 ? plotW / (categories.length - 1) : plotW / 2;
                    const pts = s.values.map((val, i) => ({
                      x: padL + (categories.length > 1 ? i * stepX : plotW / 2),
                      y: yScale(val),
                      val,
                    }));
                    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
                    const areaPath =
                      linePath +
                      ` L ${pts[pts.length - 1].x} ${yScale(0)} L ${pts[0].x} ${yScale(0)} Z`;
                    return (
                      <g key={s.name}>
                        {chart.type === 'area' && (
                          <path d={areaPath} fill={color} fillOpacity={0.14} />
                        )}
                        <path
                          d={linePath}
                          fill="none"
                          stroke={color}
                          strokeWidth={2.2}
                          strokeLinejoin="round"
                        />
                        {pts.map((p, i) => (
                          <circle key={i} cx={p.x} cy={p.y} r={3.2} fill="#fff" stroke={color} strokeWidth={2}>
                            <title>
                              {s.name} ({categories[i]}): {p.val.toLocaleString()}
                            </title>
                          </circle>
                        ))}
                      </g>
                    );
                  })}
                  {categories.map((cat, i) => {
                    const stepX =
                      categories.length > 1 ? plotW / (categories.length - 1) : plotW / 2;
                    const x = padL + (categories.length > 1 ? i * stepX : plotW / 2);
                    return (
                      <text
                        key={cat}
                        x={x}
                        y={svgH - 6}
                        textAnchor="middle"
                        className="fill-slate-500 text-[10px]"
                      >
                        {cat}
                      </text>
                    );
                  })}
                </>
              )}
            </svg>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-100 text-[10px] text-slate-600">
              {series.map((s, i) => (
                <div key={s.name} className="flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-sm inline-block"
                    style={{ background: PALETTE[i % PALETTE.length] }}
                  />
                  <span className="truncate max-w-[130px]">{s.name}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
