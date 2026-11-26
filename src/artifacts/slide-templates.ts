/**
 * 语义化竞赛答辩 PPT 引擎：把模型输出的结构化页面意图（母版 + 内容 + 图表/图片引用）
 * 编译成网格对齐、对比度合规、原生表格与高清图示完备的专业幻灯片，彻底告别裸算坐标画白框。
 */
import sharp from "sharp";
import { z } from "zod";
import { ChartSpec, renderChartPng, renderMermaidPng } from "./diagrams.js";

export const slideThemes = [
  "academic-blue",
  "tech-dark",
  "editorial-warm",
  "industrial-clean",
  "eco-green",
] as const;
export type SlideThemeName = (typeof slideThemes)[number];

export type SlideTheme = {
  name: SlideThemeName;
  label: string;
  bg: string;
  surface: string;
  primary: string;
  accent: string;
  text: string;
  muted: string;
  border: string;
  onPrimary: string;
  tableStripe: string;
};

export const SLIDE_THEMES: Record<SlideThemeName, SlideTheme> = {
  "academic-blue": {
    name: "academic-blue",
    label: "学术蓝（工科/论文/挑战杯）",
    bg: "F7F9FC",
    surface: "FFFFFF",
    primary: "1B4F72",
    accent: "2E86C1",
    text: "1C2833",
    muted: "566573",
    border: "D5E0EC",
    onPrimary: "FFFFFF",
    tableStripe: "F0F5FA",
  },
  "tech-dark": {
    name: "tech-dark",
    label: "深邃科技（AI/软件/算法）",
    bg: "0F172A",
    surface: "1E293B",
    primary: "38BDF8",
    accent: "22D3EE",
    text: "F1F5F9",
    muted: "94A3B8",
    border: "334155",
    onPrimary: "0F172A",
    tableStripe: "162234",
  },
  "editorial-warm": {
    name: "editorial-warm",
    label: "温润人文（文创/社科/设计）",
    bg: "FAF7F2",
    surface: "FFFFFF",
    primary: "7B241C",
    accent: "B9770E",
    text: "2C241E",
    muted: "6E5D52",
    border: "E8DFD5",
    onPrimary: "FFFFFF",
    tableStripe: "F4EFE7",
  },
  "industrial-clean": {
    name: "industrial-clean",
    label: "工业极简（产品/创客/制造）",
    bg: "F4F5F7",
    surface: "FFFFFF",
    primary: "1F2937",
    accent: "D97706",
    text: "111827",
    muted: "4B5563",
    border: "D1D5DB",
    onPrimary: "FFFFFF",
    tableStripe: "ECEFF3",
  },
  "eco-green": {
    name: "eco-green",
    label: "生态青绿（农业/环保/ESG）",
    bg: "F4FAF7",
    surface: "FFFFFF",
    primary: "145A32",
    accent: "16A085",
    text: "1B2631",
    muted: "4D5656",
    border: "D0E6DC",
    onPrimary: "FFFFFF",
    tableStripe: "EBF5F0",
  },
};

/** 按 WCAG 2.1 相对亮度公式计算两个 6 位十六进制颜色的对比度（1–21）。 */
export function contrastRatio(hexA: string, hexB: string): number {
  const lum = (hex: string) => {
    const clean = hex.replace(/^#/, "");
    const rgb = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
    const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  };
  const l1 = lum(hexA), l2 = lum(hexB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const MetricCard = z.object({
  value: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(40),
  detail: z.string().trim().max(90).default(""),
});

const ColumnBlock = z.object({
  heading: z.string().trim().min(1).max(48),
  points: z.array(z.string().trim().min(1).max(120)).min(1).max(6),
});

const StepItem = z.object({
  phase: z.string().trim().min(1).max(28),
  title: z.string().trim().min(1).max(48),
  detail: z.string().trim().max(110).default(""),
});

export const SemanticSlide = z.object({
  layout: z.enum([
    "cover",
    "toc",
    "hero-stats",
    "two-column",
    "image-text",
    "architecture",
    "table",
    "chart",
    "timeline",
    "ending",
  ]),
  title: z.string().trim().min(1).max(90),
  subtitle: z.string().trim().max(140).optional(),
  kicker: z.string().trim().max(40).optional(),
  bullets: z.array(z.string().trim().min(1).max(140)).max(6).optional(),
  metrics: z.array(MetricCard).max(4).optional(),
  left: ColumnBlock.optional(),
  right: ColumnBlock.optional(),
  imageRef: z.string().trim().min(1).optional(),
  imageCaption: z.string().trim().max(100).optional(),
  imageSide: z.enum(["left", "right"]).default("left"),
  mermaid: z.string().trim().min(1).optional(),
  chart: ChartSpec.optional(),
  table: z
    .object({
      headers: z.array(z.string().trim().min(1).max(50)).min(2).max(8),
      rows: z.array(z.array(z.string().max(120)).min(2).max(8)).min(1).max(12),
    })
    .optional(),
  steps: z.array(StepItem).max(5).optional(),
  footnote: z.string().trim().max(140).optional(),
  meta: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
});
export type SemanticSlide = z.infer<typeof SemanticSlide>;

/** 统计语义页所有可见文字字符数（用于 220 字密度红线检查）。 */
export function semanticSlideTextLength(s: SemanticSlide): number {
  const chunks: string[] = [
    s.title,
    s.subtitle || "",
    ...(s.bullets || []),
    ...(s.metrics || []).flatMap((m) => [m.value, m.label, m.detail]),
    ...(s.left ? [s.left.heading, ...s.left.points] : []),
    ...(s.right ? [s.right.heading, ...s.right.points] : []),
    ...(s.steps || []).flatMap((st) => [st.phase, st.title, st.detail]),
    ...(s.table ? [...s.table.headers, ...s.table.rows.flat()] : []),
    s.imageCaption || "",
  ];
  return chunks.join("").replace(/\s+/g, "").length;
}

/** 校验语义页引用的图片、表格和图表的完整性。 */
export function validateSemanticSlide(
  slide: SemanticSlide,
  pageNum: number,
  images?: Record<string, string>,
): string[] {
  const issues: string[] = [];
  if (slide.imageRef && images && !images[slide.imageRef])
    issues.push(
      `第 ${pageNum} 页引用了不存在的图片 ${slide.imageRef}；可用图片：${Object.keys(images).join("、") || "无"}`,
    );
  if (slide.layout === "table" && !slide.table)
    issues.push(`第 ${pageNum} 页 layout 为 table 但缺少 table 数据`);
  if (slide.layout === "chart" && !slide.chart)
    issues.push(`第 ${pageNum} 页 layout 为 chart 但缺少 chart 数据`);
  if (slide.layout === "two-column" && (!slide.left || !slide.right))
    issues.push(`第 ${pageNum} 页 layout 为 two-column 但缺少 left 或 right 分栏`);
  if (slide.layout === "hero-stats" && !(slide.metrics?.length))
    issues.push(`第 ${pageNum} 页 layout 为 hero-stats 但缺少 metrics 指标卡片`);
  if (slide.layout === "timeline" && !(slide.steps?.length))
    issues.push(`第 ${pageNum} 页 layout 为 timeline 但缺少 steps 阶段列表`);
  if (slide.table) {
    const cols = slide.table.headers.length;
    if (slide.table.rows.some((r) => r.length !== cols))
      issues.push(`第 ${pageNum} 页表格各行列数与表头（${cols} 列）不一致`);
  }
  const chars = semanticSlideTextLength(slide);
  const limit =
    slide.layout === "table"
      ? 560
      : slide.layout === "two-column" || slide.layout === "timeline" || slide.layout === "hero-stats"
        ? 360
        : 300;
  if (chars > limit)
    issues.push(`第 ${pageNum} 页文字过多（${chars} 字，上限 ${limit} 字），请精简要点或拆分页面`);
  return issues;
}

/** 剥掉模型自带的行首项目符号（避免母版统一加“• / ▪”后出现“• ◆”双重符号）。 */
const stripBullet = (text: string) =>
  text.replace(/^\s*(?:[•▪▸►◆◇●○■□★☆✓✔✅🔹🔸▶\-–—\*]|(?:\d+|[一二三四五六七八九十]+)[.、)])\s*/u, "").trim();

async function toFittedImage(
  input: string | Buffer,
  box: { x: number; y: number; w: number; h: number },
): Promise<{ data: string; x: number; y: number; w: number; h: number }> {
  const img = sharp(input);
  const meta = await img.metadata();
  const data = await img
    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  const iw = meta.width || 1600;
  const ih = meta.height || 900;
  const aspect = iw / ih;
  const boxAspect = box.w / box.h;
  let w = box.w;
  let h = box.h;
  if (aspect > boxAspect) h = box.w / aspect;
  else w = box.h * aspect;
  return {
    data: `data:image/jpeg;base64,${data.toString("base64")}`,
    x: Number((box.x + (box.w - w) / 2).toFixed(3)),
    y: Number((box.y + (box.h - h) / 2).toFixed(3)),
    w: Number(w.toFixed(3)),
    h: Number(h.toFixed(3)),
  };
}

function addHeader(
  ppt: any,
  page: any,
  theme: SlideTheme,
  slide: SemanticSlide,
  index: number,
  total: number,
  deckTitle: string,
) {
  page.addShape(ppt.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.1,
    fill: { color: theme.primary },
    line: { color: theme.primary },
  });
  if (slide.kicker) {
    page.addText(slide.kicker.toUpperCase(), {
      x: 0.65,
      y: 0.24,
      w: 5,
      h: 0.28,
      fontFace: "Microsoft YaHei",
      fontSize: 11,
      bold: true,
      color: theme.accent,
      margin: 0,
    });
  }
  page.addText(slide.title, {
    x: 0.65,
    y: slide.kicker ? 0.52 : 0.34,
    w: 11.4,
    h: 0.62,
    fontFace: "Microsoft YaHei",
    fontSize: 28,
    bold: true,
    color: theme.text,
    margin: 0,
    fit: "shrink",
  });
  if (slide.subtitle) {
    page.addText(slide.subtitle, {
      x: 0.65,
      y: slide.kicker ? 1.14 : 0.98,
      w: 11.8,
      h: 0.36,
      fontFace: "Microsoft YaHei",
      fontSize: 14,
      color: theme.muted,
      margin: 0,
      fit: "shrink",
    });
  }
  page.addShape(ppt.ShapeType.line, {
    x: 0.65,
    y: slide.subtitle ? 1.42 : 1.24,
    w: 12.03,
    h: 0,
    line: { color: theme.border, width: 1 },
  });
  // 页脚
  page.addText(slide.footnote || deckTitle, {
    x: 0.65,
    y: 7.08,
    w: 10.5,
    h: 0.28,
    fontFace: "Microsoft YaHei",
    fontSize: 10,
    color: theme.muted,
    margin: 0,
  });
  page.addText(`${index + 1} / ${total}`, {
    x: 11.5,
    y: 7.08,
    w: 1.18,
    h: 0.28,
    fontFace: "Microsoft YaHei",
    fontSize: 10,
    bold: true,
    color: theme.muted,
    align: "right",
    margin: 0,
  });
}

/** 把一张语义页编译成 PptxGenJS 幻灯片。 */
export async function renderSemanticSlide(
  ppt: any,
  slide: SemanticSlide,
  opts: {
    theme: SlideTheme;
    index: number;
    total: number;
    deckTitle: string;
    images: Record<string, string>;
  },
) {
  const { theme, index, total, deckTitle, images } = opts;
  const page = ppt.addSlide();
  const isDarkTheme = theme.name === "tech-dark";
  const coverBg = isDarkTheme ? "0B1120" : theme.primary;
  const coverText = isDarkTheme ? theme.text : theme.onPrimary;
  const coverMuted = isDarkTheme ? theme.muted : theme.onPrimary;
  page.background = { color: slide.layout === "cover" || slide.layout === "ending" ? coverBg : theme.bg };
  const bodyTop = slide.subtitle ? 1.62 : 1.46;

  if (slide.layout === "cover") {
    page.addShape(ppt.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 0.28,
      h: 7.5,
      fill: { color: theme.primary },
      line: { color: theme.primary },
    });
    const hasHero = !!(slide.imageRef && images[slide.imageRef]);
    const textW = hasHero ? 7.2 : 11.4;
    if (slide.kicker) {
      page.addText(slide.kicker, {
        x: 0.9,
        y: 1.35,
        w: textW,
        h: 0.4,
        fontFace: "Microsoft YaHei",
        fontSize: 14,
        bold: true,
        color: isDarkTheme ? theme.primary : coverText,
        margin: 0,
      });
    }
    page.addText(slide.title, {
      x: 0.9,
      y: 1.9,
      w: textW,
      h: 2.1,
      fontFace: "Microsoft YaHei",
      fontSize: 38,
      bold: true,
      color: coverText,
      margin: 0,
      fit: "shrink",
    });
    if (slide.subtitle) {
      page.addText(slide.subtitle, {
        x: 0.9,
        y: 4.15,
        w: textW,
        h: 0.9,
        fontFace: "Microsoft YaHei",
        fontSize: 18,
        color: coverMuted,
        margin: 0,
        fit: "shrink",
      });
    }
    if (slide.meta?.length) {
      page.addText(slide.meta.join("   |   "), {
        x: 0.9,
        y: 6.1,
        w: textW,
        h: 0.65,
        fontFace: "Microsoft YaHei",
        fontSize: 14,
        color: coverMuted,
        margin: 0,
      });
    }
    if (hasHero) {
      page.addImage(
        await toFittedImage(images[slide.imageRef!]!, { x: 8.45, y: 1.15, w: 4.35, h: 5.2 }),
      );
    }
    return;
  }

  if (slide.layout === "ending") {
    page.addShape(ppt.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.333,
      h: 0.12,
      fill: { color: theme.primary },
      line: { color: theme.primary },
    });
    page.addText(slide.title, {
      x: 1.0,
      y: 1.7,
      w: 11.33,
      h: 1.2,
      fontFace: "Microsoft YaHei",
      fontSize: 38,
      bold: true,
      color: coverText,
      align: "center",
      fit: "shrink",
    });
    if (slide.subtitle) {
      page.addText(slide.subtitle, {
        x: 1.4,
        y: 3.05,
        w: 10.53,
        h: 0.7,
        fontFace: "Microsoft YaHei",
        fontSize: 18,
        color: coverMuted,
        align: "center",
      });
    }
    if (slide.bullets?.length) {
      const n = slide.bullets.length;
      const cardW = (11.2 - (n - 1) * 0.3) / n;
      slide.bullets.forEach((b, i) => {
        const cx = 1.06 + i * (cardW + 0.3);
        page.addShape(ppt.ShapeType.roundRect, {
          x: cx,
          y: 4.15,
          w: cardW,
          h: 1.35,
          rectRadius: 0.06,
          fill: { color: theme.surface },
          line: { color: theme.border },
        });
        page.addText(b, {
          x: cx + 0.18,
          y: 4.3,
          w: cardW - 0.36,
          h: 1.05,
          fontFace: "Microsoft YaHei",
          fontSize: 14,
          bold: true,
          color: theme.text,
          align: "center",
          valign: "middle",
          fit: "shrink",
        });
      });
    }
    if (slide.meta?.length) {
      page.addText(slide.meta.join("   ·   "), {
        x: 1.0,
        y: 6.2,
        w: 11.33,
        h: 0.5,
        fontFace: "Microsoft YaHei",
        fontSize: 14,
        color: coverMuted,
        align: "center",
      });
    }
    return;
  }

  addHeader(ppt, page, theme, slide, index, total, deckTitle);

  if (slide.layout === "toc") {
    const items = slide.bullets?.length ? slide.bullets : (slide.steps || []).map((s) => `${s.phase}  ${s.title}`);
    const cols = items.length <= 3 ? 1 : 2;
    const rows = Math.ceil(items.length / cols);
    const colW = cols === 1 ? 12.0 : 5.85;
    const cardH = Math.min(1.4, (5.1 - (rows - 1) * 0.25) / Math.max(1, rows));
    items.forEach((item, i) => {
      const col = cols === 1 ? 0 : Math.floor(i / rows);
      const row = cols === 1 ? i : i % rows;
      const x = 0.65 + col * (colW + 0.33);
      const y = bodyTop + 0.15 + row * (cardH + 0.25);
      page.addShape(ppt.ShapeType.roundRect, {
        x,
        y,
        w: colW,
        h: cardH,
        fill: { color: theme.surface },
        line: { color: theme.border },
      });
      page.addShape(ppt.ShapeType.rect, {
        x,
        y,
        w: 0.72,
        h: cardH,
        fill: { color: theme.primary },
        line: { color: theme.primary },
      });
      page.addText(String(i + 1).padStart(2, "0"), {
        x,
        y,
        w: 0.72,
        h: cardH,
        fontFace: "Microsoft YaHei",
        fontSize: 22,
        bold: true,
        color: theme.onPrimary,
        align: "center",
        valign: "middle",
      });
      page.addText(item, {
        x: x + 0.9,
        y: y + 0.12,
        w: colW - 1.08,
        h: cardH - 0.24,
        fontFace: "Microsoft YaHei",
        fontSize: 17,
        bold: true,
        color: theme.text,
        valign: "middle",
        fit: "shrink",
      });
    });
    return;
  }

  if (slide.layout === "hero-stats") {
    const cards = slide.metrics || [];
    const n = Math.max(1, cards.length);
    const gap = 0.28;
    const cardW = (12.03 - gap * (n - 1)) / n;
    const cardH = slide.bullets?.length ? 2.75 : 4.4;
    cards.forEach((m, i) => {
      const x = 0.65 + i * (cardW + gap);
      page.addShape(ppt.ShapeType.roundRect, {
        x,
        y: bodyTop + 0.15,
        w: cardW,
        h: cardH,
        rectRadius: 0.05,
        fill: { color: theme.surface },
        line: { color: theme.border },
      });
      page.addShape(ppt.ShapeType.rect, {
        x,
        y: bodyTop + 0.15,
        w: cardW,
        h: 0.1,
        fill: { color: i % 2 === 0 ? theme.primary : theme.accent },
        line: { color: i % 2 === 0 ? theme.primary : theme.accent },
      });
      page.addText(m.value, {
        x: x + 0.2,
        y: bodyTop + 0.45,
        w: cardW - 0.4,
        h: 0.95,
        fontFace: "Microsoft YaHei",
        fontSize: 34,
        bold: true,
        color: theme.primary,
        align: "center",
        valign: "middle",
        fit: "shrink",
      });
      page.addText(m.label, {
        x: x + 0.2,
        y: bodyTop + 1.45,
        w: cardW - 0.4,
        h: 0.45,
        fontFace: "Microsoft YaHei",
        fontSize: 16,
        bold: true,
        color: theme.text,
        align: "center",
        fit: "shrink",
      });
      if (m.detail) {
        page.addText(m.detail, {
          x: x + 0.2,
          y: bodyTop + 1.95,
          w: cardW - 0.4,
          h: cardH - 1.95,
          fontFace: "Microsoft YaHei",
          fontSize: 14,
          color: theme.muted,
          align: "center",
          valign: "top",
          fit: "shrink",
        });
      }
    });
    if (slide.bullets?.length) {
      page.addShape(ppt.ShapeType.roundRect, {
        x: 0.65,
        y: bodyTop + 3.15,
        w: 12.03,
        h: 2.05,
        fill: { color: theme.surface },
        line: { color: theme.border },
      });
      page.addText(
        slide.bullets.map((b) => `▪  ${stripBullet(b)}`).join("\n"),
        {
          x: 0.95,
          y: bodyTop + 3.3,
          w: 11.43,
          h: 1.75,
          fontFace: "Microsoft YaHei",
          fontSize: 15,
          color: theme.text,
          valign: "middle",
          lineSpacingMultiple: 1.35,
          fit: "shrink",
        },
      );
    }
    return;
  }

  if (slide.layout === "two-column") {
    const cols = [
      { block: slide.left!, x: 0.65, bar: theme.primary },
      { block: slide.right!, x: 6.83, bar: theme.accent },
    ];
    for (const c of cols) {
      page.addShape(ppt.ShapeType.roundRect, {
        x: c.x,
        y: bodyTop + 0.1,
        w: 5.85,
        h: 5.15,
        rectRadius: 0.04,
        fill: { color: theme.surface },
        line: { color: theme.border },
      });
      page.addShape(ppt.ShapeType.rect, {
        x: c.x,
        y: bodyTop + 0.1,
        w: 5.85,
        h: 0.56,
        fill: { color: c.bar },
        line: { color: c.bar },
      });
      page.addText(c.block.heading, {
        x: c.x + 0.22,
        y: bodyTop + 0.14,
        w: 5.41,
        h: 0.48,
        fontFace: "Microsoft YaHei",
        fontSize: 16,
        bold: true,
        color: theme.onPrimary,
        valign: "middle",
        fit: "shrink",
      });
      page.addText(
        c.block.points.map((p) => `•  ${stripBullet(p)}`).join("\n\n"),
        {
          x: c.x + 0.26,
          y: bodyTop + 0.85,
          w: 5.33,
          h: 4.2,
          fontFace: "Microsoft YaHei",
          fontSize: 15,
          color: theme.text,
          valign: "top",
          lineSpacingMultiple: 1.25,
          fit: "shrink",
        },
      );
    }
    return;
  }

  if (slide.layout === "image-text") {
    const imgLeft = slide.imageSide !== "right";
    const imgX = imgLeft ? 0.65 : 6.55;
    const textX = imgLeft ? 6.95 : 0.65;
    page.addShape(ppt.ShapeType.roundRect, {
      x: imgX,
      y: bodyTop + 0.1,
      w: 6.0,
      h: 4.8,
      fill: { color: theme.surface },
      line: { color: theme.border },
    });
    let imgInput: string | Buffer | null = null;
    if (slide.imageRef && images[slide.imageRef]) imgInput = images[slide.imageRef]!;
    else if (slide.mermaid) imgInput = (await renderMermaidPng(slide.mermaid)).data;
    else if (slide.chart) imgInput = (await renderChartPng(slide.chart)).data;
    if (imgInput) {
      page.addImage(
        await toFittedImage(imgInput, {
          x: imgX + 0.15,
          y: bodyTop + 0.22,
          w: 5.7,
          h: 4.56,
        }),
      );
    }
    if (slide.imageCaption) {
      page.addText(slide.imageCaption, {
        x: imgX,
        y: bodyTop + 4.96,
        w: 6.0,
        h: 0.34,
        fontFace: "Microsoft YaHei",
        fontSize: 12,
        color: theme.muted,
        align: "center",
      });
    }
    const bullets = slide.bullets || [];
    const cardH = Math.min(1.15, (5.1 - Math.max(0, bullets.length - 1) * 0.18) / Math.max(1, bullets.length));
    bullets.forEach((b, i) => {
      const y = bodyTop + 0.1 + i * (cardH + 0.18);
      page.addShape(ppt.ShapeType.roundRect, {
        x: textX,
        y,
        w: 5.73,
        h: cardH,
        fill: { color: theme.surface },
        line: { color: theme.border },
      });
      page.addShape(ppt.ShapeType.rect, {
        x: textX,
        y,
        w: 0.1,
        h: cardH,
        fill: { color: theme.accent },
        line: { color: theme.accent },
      });
      page.addText(b, {
        x: textX + 0.24,
        y: y + 0.08,
        w: 5.36,
        h: cardH - 0.16,
        fontFace: "Microsoft YaHei",
        fontSize: 15,
        color: theme.text,
        valign: "middle",
        fit: "shrink",
      });
    });
    return;
  }

  if (slide.layout === "architecture") {
    const hasBottom = !!(slide.bullets?.length);
    const diagH = hasBottom ? 3.55 : 5.0;
    page.addShape(ppt.ShapeType.roundRect, {
      x: 0.65,
      y: bodyTop + 0.08,
      w: 12.03,
      h: diagH,
      fill: { color: theme.surface },
      line: { color: theme.border },
    });
    let imgInput: string | Buffer | null = null;
    if (slide.mermaid) imgInput = (await renderMermaidPng(slide.mermaid)).data;
    else if (slide.imageRef && images[slide.imageRef]) imgInput = images[slide.imageRef]!;
    else if (slide.chart) imgInput = (await renderChartPng(slide.chart)).data;
    if (imgInput) {
      page.addImage(
        await toFittedImage(imgInput, {
          x: 0.85,
          y: bodyTop + 0.2,
          w: 11.63,
          h: diagH - 0.24,
        }),
      );
    }
    if (hasBottom) {
      const items = slide.bullets!.slice(0, 4);
      const cw = (12.03 - (items.length - 1) * 0.24) / items.length;
      items.forEach((b, i) => {
        const cx = 0.65 + i * (cw + 0.24);
        page.addShape(ppt.ShapeType.roundRect, {
          x: cx,
          y: bodyTop + diagH + 0.24,
          w: cw,
          h: 1.32,
          fill: { color: theme.surface },
          line: { color: theme.border },
        });
        page.addText(b, {
          x: cx + 0.18,
          y: bodyTop + diagH + 0.34,
          w: cw - 0.36,
          h: 1.12,
          fontFace: "Microsoft YaHei",
          fontSize: 14,
          color: theme.text,
          valign: "middle",
          fit: "shrink",
        });
      });
    }
    return;
  }

  if (slide.layout === "table" && slide.table) {
    const headerRow = slide.table.headers.map((h) => ({
      text: h,
      options: {
        bold: true,
        color: theme.onPrimary,
        fill: { color: theme.primary },
        fontFace: "Microsoft YaHei",
        fontSize: 14,
        align: "center",
        valign: "middle",
      },
    }));
    const bodyRows = slide.table.rows.map((row, ri) =>
      row.map((cell) => ({
        text: cell,
        options: {
          color: theme.text,
          fill: { color: ri % 2 === 0 ? theme.surface : theme.tableStripe },
          fontFace: "Microsoft YaHei",
          fontSize: 14,
          valign: "middle",
        },
      })),
    );
    page.addTable([headerRow, ...bodyRows], {
      x: 0.65,
      y: bodyTop + 0.12,
      w: 12.03,
      border: { pt: 0.8, color: theme.border },
      margin: [0.08, 0.1, 0.08, 0.1],
      autoPage: false,
    });
    return;
  }

  if (slide.layout === "chart" && slide.chart) {
    const png = await renderChartPng(slide.chart);
    const hasNotes = !!(slide.bullets?.length);
    const chartW = hasNotes ? 8.15 : 12.03;
    page.addShape(ppt.ShapeType.roundRect, {
      x: 0.65,
      y: bodyTop + 0.1,
      w: chartW,
      h: 5.1,
      fill: { color: "FFFFFF" },
      line: { color: theme.border },
    });
    page.addImage(
      await toFittedImage(png.data, {
        x: 0.78,
        y: bodyTop + 0.2,
        w: chartW - 0.26,
        h: 4.9,
      }),
    );
    if (hasNotes) {
      page.addShape(ppt.ShapeType.roundRect, {
        x: 9.0,
        y: bodyTop + 0.1,
        w: 3.68,
        h: 5.1,
        fill: { color: theme.surface },
        line: { color: theme.border },
      });
      page.addText("核心结论", {
        x: 9.22,
        y: bodyTop + 0.28,
        w: 3.24,
        h: 0.42,
        fontFace: "Microsoft YaHei",
        fontSize: 17,
        bold: true,
        color: theme.primary,
      });
      page.addText(
        slide.bullets!.map((b) => `▪  ${stripBullet(b)}`).join("\n\n"),
        {
          x: 9.22,
          y: bodyTop + 0.82,
          w: 3.24,
          h: 4.2,
          fontFace: "Microsoft YaHei",
          fontSize: 14,
          color: theme.text,
          valign: "top",
          lineSpacingMultiple: 1.25,
          fit: "shrink",
        },
      );
    }
    return;
  }

  if (slide.layout === "timeline") {
    const steps = slide.steps || [];
    const n = Math.max(1, steps.length);
    const gap = 0.24;
    const cardW = (12.03 - gap * (n - 1)) / n;
    page.addShape(ppt.ShapeType.line, {
      x: 1.1,
      y: bodyTop + 0.62,
      w: 11.1,
      h: 0,
      line: { color: theme.accent, width: 2.5 },
    });
    steps.forEach((st, i) => {
      const x = 0.65 + i * (cardW + gap);
      page.addShape(ppt.ShapeType.roundRect, {
        x: x + cardW * 0.15,
        y: bodyTop + 0.34,
        w: cardW * 0.7,
        h: 0.56,
        fill: { color: theme.primary },
        line: { color: theme.primary },
      });
      page.addText(st.phase, {
        x: x + cardW * 0.15,
        y: bodyTop + 0.34,
        w: cardW * 0.7,
        h: 0.56,
        fontFace: "Microsoft YaHei",
        fontSize: 14,
        bold: true,
        color: theme.onPrimary,
        align: "center",
        valign: "middle",
        fit: "shrink",
      });
      page.addShape(ppt.ShapeType.roundRect, {
        x,
        y: bodyTop + 1.15,
        w: cardW,
        h: 3.95,
        fill: { color: theme.surface },
        line: { color: theme.border },
      });
      page.addText(st.title, {
        x: x + 0.18,
        y: bodyTop + 1.35,
        w: cardW - 0.36,
        h: 0.72,
        fontFace: "Microsoft YaHei",
        fontSize: 17,
        bold: true,
        color: theme.text,
        align: "center",
        valign: "middle",
        fit: "shrink",
      });
      page.addText(st.detail, {
        x: x + 0.18,
        y: bodyTop + 2.15,
        w: cardW - 0.36,
        h: 2.75,
        fontFace: "Microsoft YaHei",
        fontSize: 14,
        color: theme.muted,
        valign: "top",
        lineSpacingMultiple: 1.25,
        fit: "shrink",
      });
    });
  }
}
