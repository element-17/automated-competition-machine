/**
 * 离线图表与架构图渲染器：纯 TypeScript 生成高分辨率 SVG 并通过 sharp 栅格化为 PNG，
 * 零外部网络/CDN 依赖，支持科研数据图（柱状/折线/饼环/雷达）与 Mermaid（流程图/状态图/时序图）。
 */
import sharp from "sharp";
import { z } from "zod";

const FONT = "Microsoft YaHei, Noto Sans CJK SC, SimHei, PingFang SC, sans-serif";
export const CHART_PALETTE = [
  "#1B4F72",
  "#2E86C1",
  "#16A085",
  "#D68910",
  "#C0392B",
  "#7D3C98",
  "#2C3E50",
  "#27AE60",
];

export const ChartSpec = z.object({
  type: z.enum(["bar", "horizontal-bar", "line", "pie", "donut", "radar"]),
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(180).optional(),
  xLabel: z.string().trim().max(80).optional(),
  yLabel: z.string().trim().max(80).optional(),
  unit: z.string().trim().max(24).optional(),
  source: z.string().trim().max(160).optional(),
  labels: z.array(z.string().trim().min(1).max(60)).min(1).max(24),
  series: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        values: z.array(z.number().finite()).min(1).max(24),
        color: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional(),
      }),
    )
    .min(1)
    .max(8),
  width: z.number().int().min(480).max(2400).default(1000),
  height: z.number().int().min(320).max(1600).default(580),
}).superRefine((s, ctx) => {
  for (const [i, row] of s.series.entries()) {
    if (row.values.length !== s.labels.length)
      ctx.addIssue({
        code: "custom",
        message: `图表系列 ${i + 1}（${row.name}）数据点数 ${row.values.length} 与标签数 ${s.labels.length} 不一致`,
      });
  }
  if ((s.type === "pie" || s.type === "donut") && s.series[0]!.values.every((v) => v <= 0))
    ctx.addIssue({ code: "custom", message: "饼图/环图必须包含正数值" });
  if (s.type === "radar" && s.labels.length < 3)
    ctx.addIssue({ code: "custom", message: "雷达图至少需要 3 个维度标签" });
});
export type ChartSpec = z.infer<typeof ChartSpec>;

const esc = (x: string) =>
  x
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const normColor = (c: string | undefined, i: number) =>
  c ? (c.startsWith("#") ? c : `#${c}`) : CHART_PALETTE[i % CHART_PALETTE.length]!;

const fmtNum = (n: number): string => {
  if (Math.abs(n) >= 10000 && Number.isInteger(n)) return n.toLocaleString("en-US");
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(1) : Number(n.toFixed(2)).toString();
};

const charUnits = (s: string) =>
  [...s].reduce((sum, ch) => sum + (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.56), 0);

function wrapText(text: string, maxUnits: number): string[] {
  const clean = text.replace(/\r?\n/g, " ").trim();
  if (!clean) return [""];
  if (charUnits(clean) <= maxUnits) return [clean];
  const lines: string[] = [];
  let cur = "", curU = 0;
  for (const ch of clean) {
    const u = /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.56;
    if (cur && curU + u > maxUnits) {
      lines.push(cur.trim());
      cur = ch;
      curU = u;
    } else {
      cur += ch;
      curU += u;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.slice(0, 4);
}

function niceScale(minVal: number, maxVal: number, ticks = 5) {
  let lo = Math.min(0, minVal);
  let hi = Math.max(0, maxVal);
  if (hi === lo) hi = lo + 1;
  const rawStep = (hi - lo) / ticks;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const values: number[] = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) values.push(Number(v.toFixed(6)));
  return { lo, hi, values };
}

function chartHeader(spec: ChartSpec, W: number) {
  const parts: string[] = [
    `<rect width="${W}" height="${spec.height}" fill="#FFFFFF" rx="8"/>`,
    `<rect x="0" y="0" width="${W}" height="5" fill="#1B4F72"/>`,
    `<text x="${W / 2}" y="38" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="700" fill="#1A252F">${esc(spec.title)}</text>`,
  ];
  if (spec.subtitle)
    parts.push(
      `<text x="${W / 2}" y="62" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#5D6D7E">${esc(spec.subtitle)}</text>`,
    );
  if (spec.source)
    parts.push(
      `<text x="${W - 28}" y="${spec.height - 14}" text-anchor="end" font-family="${FONT}" font-size="11" fill="#7F8C8D">${esc(spec.source)}</text>`,
    );
  return parts;
}

function legendSvg(series: ChartSpec["series"], W: number, y: number): string {
  const items = series.map((s, i) => ({
    name: s.name,
    color: normColor(s.color, i),
    width: Math.max(70, Math.round(charUnits(s.name) * 13 + 30)),
  }));
  const total = items.reduce((a, b) => a + b.width, 0) + (items.length - 1) * 16;
  let x = Math.max(24, (W - total) / 2);
  return items
    .map((it) => {
      const out = `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${it.color}"/><text x="${x + 18}" y="${y}" font-family="${FONT}" font-size="13" fill="#2C3E50">${esc(it.name)}</text>`;
      x += it.width + 16;
      return out;
    })
    .join("");
}

export function renderChartSvg(rawSpec: ChartSpec): string {
  const spec = ChartSpec.parse(rawSpec);
  const W = spec.width, H = spec.height;
  const parts = chartHeader(spec, W);
  const unit = spec.unit ? ` ${spec.unit}` : "";
  const topPad = spec.subtitle ? 84 : 62;
  const hasLegend = spec.series.length > 1 && spec.type !== "pie" && spec.type !== "donut";
  const legendY = topPad + 10;
  if (hasLegend) parts.push(legendSvg(spec.series, W, legendY));
  const plotTop = hasLegend ? topPad + 30 : topPad + 10;
  const plotBottom = H - (spec.source ? 64 : 52);

  if (spec.type === "bar" || spec.type === "line") {
    const plotLeft = spec.yLabel ? 92 : 74;
    const plotRight = W - 36;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;
    const allVals = spec.series.flatMap((s) => s.values);
    const { lo, hi, values: ticks } = niceScale(Math.min(...allVals), Math.max(...allVals));
    const yOf = (v: number) => plotBottom - ((v - lo) / (hi - lo || 1)) * plotH;

    for (const t of ticks) {
      const y = yOf(t);
      parts.push(
        `<line x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" stroke="${t === 0 ? "#85929E" : "#E5E8E8"}" stroke-width="${t === 0 ? 1.4 : 1}" ${t === 0 ? "" : 'stroke-dasharray="4 4"'}/>`,
        `<text x="${plotLeft - 10}" y="${y + 4}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#566573">${esc(fmtNum(t))}</text>`,
      );
    }
    if (spec.yLabel)
      parts.push(
        `<text x="20" y="${plotTop + plotH / 2}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#2C3E50" transform="rotate(-90 20 ${plotTop + plotH / 2})">${esc(spec.yLabel)}</text>`,
      );
    if (spec.xLabel)
      parts.push(
        `<text x="${plotLeft + plotW / 2}" y="${H - (spec.source ? 26 : 12)}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#2C3E50">${esc(spec.xLabel)}</text>`,
      );

    const n = spec.labels.length;
    const groupW = plotW / n;
    for (let i = 0; i < n; i++) {
      const cx = plotLeft + (i + 0.5) * groupW;
      const lines = wrapText(spec.labels[i]!, Math.max(4, Math.floor((groupW - 8) / 13)));
      lines.slice(0, 2).forEach((ln, li) =>
        parts.push(
          `<text x="${cx}" y="${plotBottom + 18 + li * 15}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#2C3E50">${esc(ln)}</text>`,
        ),
      );
    }

    if (spec.type === "bar") {
      const m = spec.series.length;
      const innerW = groupW * 0.72;
      const barW = Math.min(48, Math.max(10, (innerW - (m - 1) * 4) / m));
      const totalBarsW = barW * m + (m - 1) * 4;
      const y0 = yOf(0);
      for (let i = 0; i < n; i++) {
        const startX = plotLeft + (i + 0.5) * groupW - totalBarsW / 2;
        spec.series.forEach((s, si) => {
          const v = s.values[i]!;
          const x = startX + si * (barW + 4);
          const yv = yOf(v);
          const rectY = Math.min(yv, y0);
          const rectH = Math.max(2, Math.abs(y0 - yv));
          parts.push(
            `<rect x="${x.toFixed(1)}" y="${rectY.toFixed(1)}" width="${barW.toFixed(1)}" height="${rectH.toFixed(1)}" rx="3" fill="${normColor(s.color, si)}"/>`,
            `<text x="${(x + barW / 2).toFixed(1)}" y="${(v >= 0 ? rectY - 5 : rectY + rectH + 13).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#2C3E50">${esc(fmtNum(v) + unit)}</text>`,
          );
        });
      }
    } else {
      const allPts = spec.series.map((s) =>
        s.values.map((v, i) => ({
          x: plotLeft + (n === 1 ? plotW / 2 : (i + 0.5) * groupW),
          y: yOf(v),
          v,
        })),
      );
      spec.series.forEach((s, si) => {
        const color = normColor(s.color, si);
        const pts = allPts[si]!;
        const d = pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>`);
        pts.forEach((p, idx) => {
          // 若同 X 处存在更靠上（SVG y 更小）且距离过近的系列点，则把本点数值标签放到圆点下方，避免文字重叠。
          const crowdedAbove = allPts.some(
            (other, oi) =>
              oi !== si &&
              other[idx] &&
              other[idx]!.y <= p.y &&
              p.y - other[idx]!.y < 20 &&
              (other[idx]!.y < p.y || oi < si),
          );
          const labelY = crowdedAbove ? p.y + 18 : p.y - 9;
          parts.push(
            `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#FFFFFF" stroke="${color}" stroke-width="2.5"/>`,
            `<text x="${p.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${color}">${esc(fmtNum(p.v) + unit)}</text>`,
          );
        });
      });
    }
  } else if (spec.type === "horizontal-bar") {
    const labelW = Math.min(220, Math.max(90, Math.round(Math.max(...spec.labels.map(charUnits)) * 13 + 22)));
    const plotLeft = labelW + 16;
    const plotRight = W - 76;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;
    const allVals = spec.series.flatMap((s) => s.values);
    const { lo, hi, values: ticks } = niceScale(Math.min(0, ...allVals), Math.max(...allVals));
    const xOf = (v: number) => plotLeft + ((v - lo) / (hi - lo || 1)) * plotW;

    for (const t of ticks) {
      const x = xOf(t);
      parts.push(
        `<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="${t === 0 ? "#85929E" : "#E5E8E8"}" stroke-width="1" ${t === 0 ? "" : 'stroke-dasharray="4 4"'}/>`,
        `<text x="${x}" y="${plotBottom + 18}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#566573">${esc(fmtNum(t))}</text>`,
      );
    }
    const n = spec.labels.length;
    const rowH = plotH / n;
    const m = spec.series.length;
    const barH = Math.min(28, Math.max(10, (rowH * 0.72 - (m - 1) * 3) / m));
    const totalH = barH * m + (m - 1) * 3;
    const x0 = xOf(0);
    for (let i = 0; i < n; i++) {
      const cy = plotTop + (i + 0.5) * rowH;
      parts.push(
        `<text x="${plotLeft - 10}" y="${cy + 4}" text-anchor="end" font-family="${FONT}" font-size="12" fill="#2C3E50">${esc(spec.labels[i]!)}</text>`,
      );
      const startY = cy - totalH / 2;
      spec.series.forEach((s, si) => {
        const v = s.values[i]!;
        const y = startY + si * (barH + 3);
        const xv = xOf(v);
        const rx = Math.min(x0, xv);
        const rw = Math.max(2, Math.abs(xv - x0));
        parts.push(
          `<rect x="${rx.toFixed(1)}" y="${y.toFixed(1)}" width="${rw.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${normColor(s.color, si)}"/>`,
          `<text x="${(rx + rw + 6).toFixed(1)}" y="${(y + barH / 2 + 4).toFixed(1)}" font-family="${FONT}" font-size="11" font-weight="600" fill="#2C3E50">${esc(fmtNum(v) + unit)}</text>`,
        );
      });
    }
  } else if (spec.type === "pie" || spec.type === "donut") {
    const vals = spec.series[0]!.values.map((v) => Math.max(0, v));
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = W * 0.36;
    const cy = plotTop + (plotBottom - plotTop) / 2;
    const r = Math.min(W * 0.25, (plotBottom - plotTop) * 0.44);
    const inner = spec.type === "donut" ? r * 0.54 : 0;
    let angle = -Math.PI / 2;

    vals.forEach((v, i) => {
      if (v <= 0) return;
      const slice = (v / sum) * Math.PI * 2;
      const end = angle + slice;
      const large = slice > Math.PI ? 1 : 0;
      const color = normColor(undefined, i);
      if (slice >= Math.PI * 1.9999) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
      } else {
        const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
        if (inner > 0) {
          const ix1 = cx + inner * Math.cos(end), iy1 = cy + inner * Math.sin(end);
          const ix2 = cx + inner * Math.cos(angle), iy2 = cy + inner * Math.sin(angle);
          parts.push(
            `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} L${ix1.toFixed(1)},${iy1.toFixed(1)} A${inner},${inner} 0 ${large} 0 ${ix2.toFixed(1)},${iy2.toFixed(1)} Z" fill="${color}" stroke="#FFFFFF" stroke-width="2"/>`,
          );
        } else {
          parts.push(
            `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" stroke="#FFFFFF" stroke-width="2"/>`,
          );
        }
      }
      const pct = (v / sum) * 100;
      if (pct >= 6) {
        const mid = angle + slice / 2;
        const lr = inner > 0 ? (r + inner) / 2 : r * 0.65;
        parts.push(
          `<text x="${(cx + lr * Math.cos(mid)).toFixed(1)}" y="${(cy + lr * Math.sin(mid) + 4).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#FFFFFF">${pct.toFixed(1)}%</text>`,
        );
      }
      angle = end;
    });
    if (inner > 0) {
      parts.push(
        `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#5D6D7E">合计</text>`,
        `<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="${FONT}" font-size="18" font-weight="700" fill="#1A252F">${esc(fmtNum(sum) + unit)}</text>`,
      );
    }
    const lx = W * 0.66;
    const startY = Math.max(plotTop + 16, cy - (spec.labels.length * 28) / 2);
    spec.labels.forEach((lbl, i) => {
      const ly = startY + i * 28;
      const pct = ((vals[i]! / sum) * 100).toFixed(1);
      parts.push(
        `<rect x="${lx}" y="${ly - 10}" width="13" height="13" rx="3" fill="${normColor(undefined, i)}"/>`,
        `<text x="${lx + 20}" y="${ly + 1}" font-family="${FONT}" font-size="13" fill="#2C3E50">${esc(lbl)}：${esc(fmtNum(vals[i]!) + unit)} (${pct}%)</text>`,
      );
    });
  } else if (spec.type === "radar") {
    const cx = W / 2;
    const cy = plotTop + (plotBottom - plotTop) / 2 + 8;
    const r = Math.min(W * 0.3, (plotBottom - plotTop) * 0.39);
    const n = spec.labels.length;
    const maxV = Math.max(1, ...spec.series.flatMap((s) => s.values));
    const rings = 4;
    for (let ring = 1; ring <= rings; ring++) {
      const rr = (r * ring) / rings;
      const pts = Array.from({ length: n }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
        return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
      }).join(" ");
      parts.push(`<polygon points="${pts}" fill="none" stroke="#D5DBDB" stroke-width="1"/>`);
    }
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      const lx = cx + (r + 24) * Math.cos(a), ly = cy + (r + 22) * Math.sin(a);
      const anchor = Math.abs(Math.cos(a)) < 0.2 ? "middle" : Math.cos(a) > 0 ? "start" : "end";
      parts.push(
        `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#D5DBDB" stroke-width="1"/>`,
        `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" font-family="${FONT}" font-size="13" font-weight="600" fill="#2C3E50">${esc(spec.labels[i]!)}</text>`,
      );
    }
    spec.series.forEach((s, si) => {
      const color = normColor(s.color, si);
      const pts = s.values
        .map((v, i) => {
          const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
          const rr = (Math.max(0, v) / maxV) * r;
          return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
        })
        .join(" ");
      parts.push(
        `<polygon points="${pts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2.5"/>`,
      );
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export async function renderChartPng(
  spec: ChartSpec,
): Promise<{ data: Buffer; width: number; height: number }> {
  const parsed = ChartSpec.parse(spec);
  const svg = renderChartSvg(parsed);
  const data = await sharp(Buffer.from(svg), { density: 180 }).png().toBuffer();
  const meta = await sharp(data).metadata();
  return { data, width: meta.width || parsed.width, height: meta.height || parsed.height };
}

/* ---------- 离线 Mermaid 渲染（flowchart / graph / stateDiagram / sequenceDiagram） ---------- */

type NodeShape = "rect" | "round" | "stadium" | "diamond" | "db" | "circle";
type FlowNode = { id: string; label: string; shape: NodeShape; group?: string };
type FlowEdge = { from: string; to: string; label?: string; dashed?: boolean };

function parseNodeToken(raw: string): FlowNode {
  const s = raw.trim();
  const patterns: [RegExp, NodeShape][] = [
    [/^([A-Za-z0-9_.-]+)\s*\(\[([^\]]+)\]\)$/, "stadium"],
    [/^([A-Za-z0-9_.-]+)\s*\[\(([^)]+)\)\]$/, "db"],
    [/^([A-Za-z0-9_.-]+)\s*\(\(([^)]+)\)\)$/, "circle"],
    [/^([A-Za-z0-9_.-]+)\s*\{([^}]+)\}$/, "diamond"],
    [/^([A-Za-z0-9_.-]+)\s*\(([^)]+)\)$/, "round"],
    [/^([A-Za-z0-9_.-]+)\s*\[([^\]]+)\]$/, "rect"],
  ];
  for (const [re, shape] of patterns) {
    const m = re.exec(s);
    if (m) return { id: m[1]!, label: m[2]!.replace(/^["']|["']$/g, "").trim(), shape };
  }
  const id = s.replace(/[^A-Za-z0-9_\u4e00-\u9fa5.-]/g, "") || "node";
  return { id, label: s.replace(/^["']|["']$/g, "").trim() || id, shape: "rect" };
}

function renderSequenceSvg(lines: string[], title?: string): string {
  const actors: { id: string; label: string }[] = [];
  const ensure = (id: string, label?: string) => {
    let found = actors.find((a) => a.id === id);
    if (!found) {
      found = { id, label: label || id };
      actors.push(found);
    } else if (label) found.label = label;
    return found;
  };
  const msgs: { from: string; to: string; text: string; dashed: boolean }[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    const part = /^(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (part) {
      ensure(part[1]!, part[2]?.trim());
      continue;
    }
    const msg = /^([^\s-]+?)\s*(--?>>?)\s*([^\s:]+)\s*:\s*(.*)$/.exec(line);
    if (msg) {
      ensure(msg[1]!);
      ensure(msg[3]!);
      msgs.push({ from: msg[1]!, to: msg[3]!, text: msg[4]!.trim(), dashed: msg[2]!.startsWith("--") });
    }
  }
  if (!actors.length) actors.push({ id: "A", label: "系统" });
  const colW = 210;
  const W = Math.max(640, actors.length * colW + 80);
  const topY = title ? 74 : 36;
  const rowH = 54;
  const H = Math.max(300, topY + 90 + msgs.length * rowH);
  const xOf = (id: string) => 40 + (actors.findIndex((a) => a.id === id) + 0.5) * colW;
  const parts: string[] = [
    `<defs><marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#1B4F72"/></marker></defs>`,
    `<rect width="${W}" height="${H}" fill="#FFFFFF" rx="8"/>`,
  ];
  if (title)
    parts.push(`<text x="${W / 2}" y="38" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="700" fill="#1A252F">${esc(title)}</text>`);
  for (const a of actors) {
    const cx = xOf(a.id);
    parts.push(
      `<line x1="${cx}" y1="${topY + 42}" x2="${cx}" y2="${H - 28}" stroke="#BFC9CA" stroke-width="1.5" stroke-dasharray="5 5"/>`,
      `<rect x="${cx - 78}" y="${topY}" width="156" height="42" rx="6" fill="#EBF5FB" stroke="#1B4F72" stroke-width="1.8"/>`,
      `<text x="${cx}" y="${topY + 26}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="700" fill="#1B4F72">${esc(a.label)}</text>`,
    );
  }
  msgs.forEach((m, idx) => {
    const y = topY + 76 + idx * rowH;
    const x1 = xOf(m.from), x2 = xOf(m.to);
    if (x1 === x2) {
      parts.push(
        `<path d="M${x1},${y - 8} H${x1 + 52} V${y + 12} H${x1 + 6}" fill="none" stroke="#1B4F72" stroke-width="1.8" ${m.dashed ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#seq-arrow)"/>`,
        `<text x="${x1 + 58}" y="${y + 4}" font-family="${FONT}" font-size="12" fill="#2C3E50">${esc(m.text)}</text>`,
      );
    } else {
      const dir = x2 > x1 ? 1 : -1;
      parts.push(
        `<line x1="${x1}" y1="${y}" x2="${x2 - dir * 6}" y2="${y}" stroke="#1B4F72" stroke-width="1.8" ${m.dashed ? 'stroke-dasharray="6 4"' : ""} marker-end="url(#seq-arrow)"/>`,
        `<text x="${(x1 + x2) / 2}" y="${y - 8}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#2C3E50">${esc(m.text)}</text>`,
      );
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export function renderMermaidSvg(code: string, title?: string): string {
  const rawLines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));
  if (!rawLines.length) throw Error("Mermaid 图表内容为空");
  const header = rawLines[0]!;
  if (/^sequenceDiagram/i.test(header)) return renderSequenceSvg(rawLines, title);

  const isState = /^stateDiagram/i.test(header);
  const horizontal = /\b(LR|RL)\b/i.test(header);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  let currentGroup: string | undefined;
  let startCount = 0;

  const upsert = (node: FlowNode) => {
    const prev = nodes.get(node.id);
    if (!prev) nodes.set(node.id, { ...node, group: currentGroup });
    else if (prev.label === prev.id && node.label !== node.id) {
      prev.label = node.label;
      prev.shape = node.shape;
    }
  };

  for (const raw of rawLines.slice(1)) {
    if (/^(?:style|classDef|class|linkStyle|click)\b/i.test(raw)) continue;
    const sub = /^subgraph\s+(?:[A-Za-z0-9_.-]+\s*\[([^\]]+)\]|(.+))$/i.exec(raw);
    if (sub) {
      currentGroup = (sub[1] || sub[2] || "").replace(/^["']|["']$/g, "").trim();
      continue;
    }
    if (/^end$/i.test(raw)) {
      currentGroup = undefined;
      continue;
    }
    if (isState) {
      const m = /^(\[\*\]|[A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_\u4e00-\u9fa5.-]+)(?:\s*:\s*(.+))?$/.exec(raw);
      if (m) {
        const fromId = m[1] === "[*]" ? `__start_${++startCount}` : m[1]!;
        const toId = m[2] === "[*]" ? `__end_${++startCount}` : m[2]!;
        upsert({ id: fromId, label: m[1] === "[*]" ? "开始" : fromId, shape: m[1] === "[*]" ? "stadium" : "round" });
        upsert({ id: toId, label: m[2] === "[*]" ? "结束" : toId, shape: m[2] === "[*]" ? "stadium" : "round" });
        edges.push({ from: fromId, to: toId, label: m[3]?.trim() });
      }
      continue;
    }
    // 支持链式边：A[输入] --> B[处理] -->|成功| C[输出]
    const edgeRe = /\s*(-\.->|==>|--\s+([^->]+?)\s+-->|-->)(?:\|([^|]+)\|)?\s*/g;
    const matches = [...raw.matchAll(edgeRe)];
    if (matches.length) {
      const segs: string[] = [];
      let pos = 0;
      for (const m of matches) {
        segs.push(raw.slice(pos, m.index!));
        pos = m.index! + m[0].length;
      }
      segs.push(raw.slice(pos));
      const parsed = segs.map((s) => parseNodeToken(s));
      parsed.forEach(upsert);
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i]!;
        edges.push({
          from: parsed[i]!.id,
          to: parsed[i + 1]!.id,
          label: (m[3] || m[2] || "").trim() || undefined,
          dashed: m[1]!.startsWith("-."),
        });
      }
    } else if (/^[A-Za-z0-9_.-]+\s*[\[\(\{]/.test(raw)) {
      upsert(parseNodeToken(raw));
    }
  }

  if (!nodes.size) throw Error("未能从 Mermaid 代码中解析出节点");

  // 拓扑分层布局
  const indeg = new Map<string, number>([...nodes.keys()].map((id) => [id, 0]));
  const adj = new Map<string, string[]>([...nodes.keys()].map((id) => [id, []]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    adj.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const layer = new Map<string, number>();
  const queue = [...nodes.keys()].filter((id) => (indeg.get(id) || 0) === 0);
  if (!queue.length) queue.push([...nodes.keys()][0]!);
  for (const id of queue) layer.set(id, 0);
  const visited = new Set<string>(queue);
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    const lu = layer.get(u) || 0;
    for (const v of adj.get(u) || []) {
      const next = Math.max(layer.get(v) || 0, lu + 1);
      if (!visited.has(v)) {
        layer.set(v, next);
        visited.add(v);
        queue.push(v);
      } else if (next < nodes.size && next > (layer.get(v) || 0)) {
        layer.set(v, next);
      }
    }
  }
  for (const id of nodes.keys()) if (!layer.has(id)) layer.set(id, 0);

  const layers: FlowNode[][] = [];
  for (const node of nodes.values()) {
    const l = layer.get(node.id) || 0;
    (layers[l] ||= []).push(node);
  }

  const maxLabelUnits = Math.max(8, ...[...nodes.values()].map((n) => charUnits(n.label)));
  const nodeW = Math.min(280, Math.max(210, Math.round(maxLabelUnits * 16 + 38)));
  const maxEdgeLabelW = edges.reduce(
    (mx, e) => (e.label ? Math.max(mx, Math.round(charUnits(e.label) * 13 + 20)) : mx),
    0,
  );
  const nodeH = 68;
  const gapX = horizontal ? Math.max(56, maxEdgeLabelW + 28) : 52;
  const gapY = horizontal ? 48 : Math.max(50, maxEdgeLabelW ? 68 : 50);
  const maxPerLayer = Math.max(...layers.map((l) => l.length));
  const titleOffset = title ? 44 : 0;
  const pad = 44;

  const contentW = horizontal
    ? layers.length * nodeW + Math.max(0, layers.length - 1) * gapX
    : maxPerLayer * nodeW + Math.max(0, maxPerLayer - 1) * gapX;
  const contentH = horizontal
    ? maxPerLayer * nodeH + Math.max(0, maxPerLayer - 1) * gapY
    : layers.length * nodeH + Math.max(0, layers.length - 1) * gapY;
  const W = Math.max(640, contentW + pad * 2);
  const H = Math.max(260, contentH + pad * 2 + titleOffset);

  const coords = new Map<string, { x: number; y: number; w: number; h: number }>();
  layers.forEach((group, li) => {
    const span = horizontal
      ? group.length * nodeH + (group.length - 1) * gapY
      : group.length * nodeW + (group.length - 1) * gapX;
    group.forEach((node, gi) => {
      const x = horizontal
        ? pad + li * (nodeW + gapX)
        : (W - span) / 2 + gi * (nodeW + gapX);
      const y = horizontal
        ? titleOffset + (H - titleOffset - span) / 2 + gi * (nodeH + gapY)
        : pad + titleOffset + li * (nodeH + gapY);
      coords.set(node.id, { x, y, w: nodeW, h: nodeH });
    });
  });

  const parts: string[] = [
    `<defs><marker id="mm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 1 L 10 5 L 0 9 z" fill="#2E86C1"/></marker></defs>`,
    `<rect width="${W}" height="${H}" fill="#FFFFFF" rx="8"/>`,
  ];
  if (title)
    parts.push(`<text x="${W / 2}" y="34" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="700" fill="#1A252F">${esc(title)}</text>`);

  // 分组底框
  const groupBoxes = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
  for (const node of nodes.values()) {
    if (!node.group) continue;
    const c = coords.get(node.id)!;
    const box = groupBoxes.get(node.group);
    if (!box) groupBoxes.set(node.group, { x1: c.x - 14, y1: c.y - 26, x2: c.x + c.w + 14, y2: c.y + c.h + 14 });
    else {
      box.x1 = Math.min(box.x1, c.x - 14);
      box.y1 = Math.min(box.y1, c.y - 26);
      box.x2 = Math.max(box.x2, c.x + c.w + 14);
      box.y2 = Math.max(box.y2, c.y + c.h + 14);
    }
  }
  for (const [name, b] of groupBoxes) {
    parts.push(
      `<rect x="${b.x1}" y="${b.y1}" width="${b.x2 - b.x1}" height="${b.y2 - b.y1}" rx="10" fill="#F8FAFC" stroke="#AED6F1" stroke-width="1.6" stroke-dasharray="6 4"/>`,
      `<text x="${b.x1 + 12}" y="${b.y1 + 19}" font-family="${FONT}" font-size="15" font-weight="700" fill="#1B4F72">${esc(name)}</text>`,
    );
  }

  // 边（连线先画，边标签放到节点之后绘制避免被节点盖住）
  const edgeLabelParts: string[] = [];
  for (const e of edges) {
    const a = coords.get(e.from), b = coords.get(e.to);
    if (!a || !b) continue;
    let x1: number, y1: number, x2: number, y2: number;
    if (horizontal) {
      x1 = a.x + a.w; y1 = a.y + a.h / 2;
      x2 = b.x; y2 = b.y + b.h / 2;
      if (x2 < x1) { x1 = a.x; x2 = b.x + b.w; }
    } else {
      x1 = a.x + a.w / 2; y1 = a.y + a.h;
      x2 = b.x + b.w / 2; y2 = b.y;
      if (y2 < y1) { y1 = a.y; y2 = b.y + b.h; }
    }
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const path = horizontal
      ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
      : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    parts.push(
      `<path d="${path}" fill="none" stroke="#2E86C1" stroke-width="2" ${e.dashed ? 'stroke-dasharray="6 4"' : ""} marker-end="url(#mm-arrow)"/>`,
    );
    if (e.label) {
      const lw = Math.max(44, Math.round(charUnits(e.label) * 13 + 18));
      edgeLabelParts.push(
        `<rect x="${mx - lw / 2}" y="${my - 13}" width="${lw}" height="26" rx="5" fill="#FFFFFF" stroke="#AED6F1" stroke-width="1.2"/>`,
        `<text x="${mx}" y="${my + 5}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="600" fill="#1B4F72">${esc(e.label)}</text>`,
      );
    }
  }

  // 节点
  for (const node of nodes.values()) {
    const c = coords.get(node.id)!;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const isTerminal = node.shape === "stadium" || node.shape === "circle";
    const fill = node.shape === "diamond" ? "#FEF9E7" : isTerminal ? "#1B4F72" : "#EBF5FB";
    const stroke = node.shape === "diamond" ? "#D68910" : "#1B4F72";
    const textFill = isTerminal ? "#FFFFFF" : "#1A252F";
    if (node.shape === "diamond") {
      const pts = `${cx},${c.y - 4} ${c.x + c.w + 4},${cy} ${cx},${c.y + c.h + 4} ${c.x - 4},${cy}`;
      parts.push(`<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="1.8"/>`);
    } else {
      const rx = isTerminal ? c.h / 2 : node.shape === "round" ? 14 : 6;
      parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.8"/>`);
    }
    const lines = wrapText(node.label, 12).slice(0, 2);
    const startY = cy - ((lines.length - 1) * 21) / 2 + 6;
    lines.forEach((ln, li) =>
      parts.push(
        `<text x="${cx}" y="${startY + li * 21}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="700" fill="${textFill}">${esc(ln)}</text>`,
      ),
    );
  }
  parts.push(...edgeLabelParts);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export async function renderMermaidPng(
  code: string,
  title?: string,
): Promise<{ data: Buffer; width: number; height: number }> {
  const svg = renderMermaidSvg(code, title);
  const data = await sharp(Buffer.from(svg), { density: 240 }).png().toBuffer();
  const meta = await sharp(data).metadata();
  return { data, width: meta.width || 800, height: meta.height || 400 };
}
