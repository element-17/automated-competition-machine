import { z } from "zod";
import { mkdir, writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOfficecli } from "./officecli.js";
import { readXlsx } from "./xlsx.js";
import { ChartSpec, renderChartPng, renderMermaidPng } from "./diagrams.js";
import { docxToPdf, renderHtmlToPdf } from "./doc-render.js";
import {
  SLIDE_THEMES,
  SemanticSlide,
  contrastRatio,
  renderSemanticSlide,
  slideThemes,
  validateSemanticSlide,
} from "./slide-templates.js";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
} from "docx";
import { createRequire } from "node:module";
import JSZip from "jszip";
import sharp from "sharp";
const PptxGenJS = createRequire(import.meta.url)("pptxgenjs") as new () => any;
const PDFDocument = createRequire(import.meta.url)(
  "pdfkit",
) as typeof import("pdfkit");

const color = z.string().regex(/^[0-9A-Fa-f]{6}$/);

/** 结构化文档排版规格：既可由公告自动解析，也可由规划/写作指定，渲染层直接落盘执行。 */
export const Typography = z.object({
  titleFont: z.string().default("黑体"),
  titleSizePt: z.number().min(10).max(48).default(22),
  headingFont: z.string().default("黑体"),
  bodyFont: z.string().default("宋体"),
  bodySizePt: z.number().min(8).max(24).default(12),
  lineSpacing: z.number().min(1).max(3).default(1.5),
  firstLineIndentChars: z.number().min(0).max(4).default(2),
  spaceBeforePt: z.number().min(0).max(36).default(0),
  spaceAfterPt: z.number().min(0).max(36).default(0),
  marginCm: z.number().min(1).max(5).default(2.54),
  pageNumbers: z.boolean().default(true),
  coverPage: z.boolean().default(false),
  pdfLayout: z.enum(["document", "portfolio"]).default("document"),
});
export type Typography = z.infer<typeof Typography>;

const cnFontSizes: [RegExp, number][] = [
  [/初号/, 42],
  [/小初/, 36],
  [/小一/, 24],
  [/一号/, 26],
  [/小二/, 18],
  [/二号/, 22],
  [/小三/, 15],
  [/三号/, 16],
  [/小四/, 12],
  [/四号/, 14],
  [/小五/, 9],
  [/五号/, 10.5],
];
const cnFonts = ["仿宋_GB2312", "仿宋", "楷体", "黑体", "宋体", "微软雅黑", "Times New Roman"];

/** 从赛事规则或任务说明里提取明确的排版参数，直接交给渲染器执行。 */
export function parseTypographyRules(texts: string[]): Partial<Typography> {
  const joined = texts.filter(Boolean).join("\n");
  if (!joined.trim()) return {};
  const out: Partial<Typography> = {};
  const bodySeg = /正文[^。\n；;]{0,40}/.exec(joined)?.[0] || joined;
  for (const font of cnFonts) {
    if (bodySeg.includes(font)) {
      out.bodyFont = font;
      break;
    }
  }
  const titleSeg = /标题[^。\n；;]{0,30}/.exec(joined)?.[0];
  if (titleSeg) {
    for (const font of cnFonts) {
      if (titleSeg.includes(font)) {
        out.titleFont = font;
        out.headingFont = font;
        break;
      }
    }
    for (const [re, pt] of cnFontSizes) {
      if (re.test(titleSeg)) {
        out.titleSizePt = pt;
        break;
      }
    }
  }
  for (const [re, pt] of cnFontSizes) {
    if (re.test(bodySeg)) {
      out.bodySizePt = pt;
      break;
    }
  }
  const ptMatch = /正文[^。\n]{0,20}?(\d+(?:\.\d+)?)\s*(?:磅|pt)/i.exec(joined);
  if (ptMatch) out.bodySizePt = Number(ptMatch[1]);
  if (/单倍行距/.test(joined)) out.lineSpacing = 1.0;
  else if (/1\.25\s*倍行距/.test(joined)) out.lineSpacing = 1.25;
  else if (/1\.5\s*倍行距/.test(joined)) out.lineSpacing = 1.5;
  else if (/(?:2|双|两)\s*倍行距/.test(joined)) out.lineSpacing = 2.0;
  else {
    const fixedPt = /固定值\s*(\d+(?:\.\d+)?)\s*(?:磅|pt)/i.exec(joined);
    if (fixedPt) {
      const ratio = Number(fixedPt[1]) / (out.bodySizePt || 12);
      if (ratio >= 1 && ratio <= 3) out.lineSpacing = Number(ratio.toFixed(2));
    }
  }
  if (/段前段后\s*0|段前\s*0[^0-9]{0,6}段后\s*0/.test(joined)) {
    out.spaceBeforePt = 0;
    out.spaceAfterPt = 0;
  }
  if (/左对齐|取消首行缩进|不缩进/.test(joined)) out.firstLineIndentChars = 0;
  const margin = /页边距[^\d]{0,10}(\d+(?:\.\d+)?)\s*(?:cm|厘米)/i.exec(joined);
  if (margin) {
    const cm = Number(margin[1]);
    if (cm >= 1 && cm <= 5) out.marginCm = cm;
  }
  if (/画册|作品集|图文对开|三联图|海报合集|图片\s*PDF|PDF\s*图集/i.test(joined))
    out.pdfLayout = "portfolio";
  return out;
}

export const Element = z
  .object({
    type: z.enum(["text", "rect", "ellipse", "line", "image"]).default("text"),
    ref: z.string().optional(),
    text: z.string().max(2000).default(""),
    x: z.number().min(0),
    y: z.number().min(0),
    w: z.number().positive(),
    h: z.number().positive(),
    fontSize: z.number().min(8).max(72).default(24),
    color: color.default("202832"),
    fill: color.optional(),
    bold: z.boolean().default(false),
  })
  .superRefine((e, ctx) => {
    if (e.type === "text" && !e.text.trim())
      ctx.addIssue({ code: "custom", message: "文本元素不能为空" });
    if (e.type === "image" && !e.ref?.trim())
      ctx.addIssue({
        code: "custom",
        message: "图片元素必须用 ref 指定图片任务 id",
      });
  });

export const FreeformSlide = z.object({
  background: color.default("FFFFFF"),
  elements: z.array(Element).min(1).max(30),
});
export const Slide = z.union([SemanticSlide, FreeformSlide]);
export type Slide = z.infer<typeof Slide>;
export const isSemanticSlide = (s: Slide): s is SemanticSlide => "layout" in s;

/** 工作表：第一行约定为表头行；单元格一律字符串，公式由禁用规则挡在 validateWork。 */
export const Sheet = z.object({
  name: z.string().trim().min(1).max(60),
  rows: z.array(z.array(z.string().max(2000)).max(40)).min(1).max(1000),
});
export const Work = z
  .object({
    kind: z.enum(["text", "slides", "spreadsheet"]),
    title: z.string().min(1),
    text: z.string().optional(),
    slides: z.array(Slide).max(40).optional(),
    theme: z.enum(slideThemes).optional(),
    typography: Typography.partial().optional(),
    sheets: z.array(Sheet).max(8).optional(),
    sources: z.array(z.string()).default([]),
    needs_input: z.array(z.string()).default([]),
  })
  .superRefine((x, ctx) => {
    if (x.kind === "text" && !x.text?.trim())
      ctx.addIssue({ code: "custom", message: "文字作品为空" });
    if (x.kind === "slides" && !x.slides?.length)
      ctx.addIssue({ code: "custom", message: "PPT 没有幻灯片" });
    if (x.kind === "spreadsheet" && !x.sheets?.length)
      ctx.addIssue({ code: "custom", message: "工作簿没有工作表" });
  });
export type Work = z.infer<typeof Work>;

/** 剥掉代码块后扫描正文里的 Markdown 图片引用。 */
export function markdownImageRefs(text: string): { alt: string; ref: string }[] {
  const stripped = text.replace(/```[\s\S]*?```/g, "");
  return [...stripped.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => ({
    alt: m[1]!.trim(),
    ref: m[2]!.trim(),
  }));
}

export function validateWork(
  work: Work,
  images?: Record<string, string>,
): string[] {
  const issues: string[] = [];
  if (work.kind === "text" && work.text) {
    // 禁止在正文里编造不存在的 Markdown 图片链接（如 image_xxx.png）。
    if (images) {
      for (const img of markdownImageRefs(work.text)) {
        if (/^data:image\//i.test(img.ref)) continue;
        if (!images[img.ref])
          issues.push(
            `正文引用了不存在的图片 ${img.ref}；只能引用已生成图片（${Object.keys(images).join("、") || "当前无可用图片"}）或改用 mermaid/chart 代码块绘制图示，不得虚构图片链接`,
          );
      }
    }
    // 校验内嵌 chart 代码块的 JSON 合法性。
    for (const m of work.text.matchAll(/```chart\s*\r?\n([\s\S]*?)```/gi)) {
      try {
        ChartSpec.parse(JSON.parse(m[1]!.trim()));
      } catch (e) {
        issues.push(
          `内嵌 chart 图表配置无效：${e instanceof Error ? e.message.slice(0, 180) : String(e)}`,
        );
      }
    }
  }
  if (work.kind === "slides") {
    for (const [i, slide] of (work.slides || []).entries()) {
      if (isSemanticSlide(slide)) {
        issues.push(...validateSemanticSlide(slide, i + 1, images));
        continue;
      }
      const textElements = slide.elements.filter((e) => e.type === "text");
      if (textElements.length) {
        const maxFont = Math.max(...textElements.map((e) => e.fontSize));
        const minFont = Math.min(...textElements.map((e) => e.fontSize));
        const hasTitle =
          maxFont >= 28 ||
          (maxFont >= 24 && (textElements.length === 1 || maxFont >= minFont + 6));
        if (!hasTitle)
          issues.push(`第 ${i + 1} 页缺少标题级文本（当前最大字号 ${maxFont}，应不少于 28 或比正文字号大至少 6pt 且不少于 24）`);
        const totalChars = textElements
          .map((e) => e.text.replace(/\s+/g, "").length)
          .reduce((a, b) => a + b, 0);
        if (totalChars > 220)
          issues.push(`第 ${i + 1} 页文字过多（共 ${totalChars} 字，超过 220 字上限），请精简要点或拆页`);
      }
      for (const [j, e] of slide.elements.entries()) {
        if (e.x + e.w > 13.3334 || e.y + e.h > 7.5)
          issues.push(`第 ${i + 1} 页第 ${j + 1} 个元素越界`);
        if (e.type === "image" && images && !images[e.ref!])
          issues.push(
            `第 ${i + 1} 页第 ${j + 1} 个图片元素引用了不存在的图片 ${e.ref}；只能使用 ${Object.keys(images).join("、") || "（当前没有可用图片，请删除图片元素）"}`,
          );
        if (e.type === "text") {
          if (e.fontSize < 14)
            issues.push(`第 ${i + 1} 页第 ${j + 1} 个文本框字号 ${e.fontSize} 小于 14，投影难以辨认`);
          // 查找文字下方的实心色块（若有），按有效底色计算 WCAG 对比度。
          let effectiveBg = slide.background;
          for (let k = j - 1; k >= 0; k--) {
            const bgEl = slide.elements[k]!;
            if (
              bgEl.type === "rect" &&
              bgEl.fill &&
              bgEl.x <= e.x + 0.05 &&
              bgEl.y <= e.y + 0.05 &&
              bgEl.x + bgEl.w >= e.x + e.w - 0.05 &&
              bgEl.y + bgEl.h >= e.y + e.h - 0.05
            ) {
              effectiveBg = bgEl.fill;
              break;
            }
          }
          const ratio = contrastRatio(e.color, effectiveBg);
          if (ratio < 3)
            issues.push(
              `第 ${i + 1} 页第 ${j + 1} 个文本框颜色 #${e.color} 与背景 #${effectiveBg} 对比度仅 ${ratio.toFixed(2)}（低于 3.0）`,
            );
          const approxChars =
            Math.max(1, Math.floor((e.w * 72) / (e.fontSize * 0.9))) *
            Math.max(1, Math.floor((e.h * 72) / (e.fontSize * 1.25)));
          if (e.text.length > approxChars * 1.4)
            issues.push(`第 ${i + 1} 页第 ${j + 1} 个文本框可能溢出`);
          for (let k = 0; k < j; k++) {
            const other = slide.elements[k];
            if (other?.type !== "text") continue;
            const w = Math.max(
              0,
              Math.min(e.x + e.w, other.x + other.w) - Math.max(e.x, other.x),
            );
            const h = Math.max(
              0,
              Math.min(e.y + e.h, other.y + other.h) - Math.max(e.y, other.y),
            );
            if (w * h > Math.min(e.w * e.h, other.w * other.h) * 0.05)
              issues.push(`第 ${i + 1} 页第 ${k + 1} 与 ${j + 1} 个文本框重叠`);
          }
        }
      }
    }
  }
  if (work.kind === "spreadsheet") {
    const names = new Set<string>();
    for (const [i, sheet] of (work.sheets || []).entries()) {
      if (/[\\/?*[\]:]/.test(sheet.name))
        issues.push(`工作表 ${i + 1} 名称含 Excel 不允许的字符：${sheet.name}`);
      if (names.has(sheet.name))
        issues.push(`工作表名称重复：${sheet.name}`);
      names.add(sheet.name);
      if (sheet.rows.every((row) => row.every((cell) => !cell.trim())))
        issues.push(`工作表 ${sheet.name} 没有任何内容`);
      for (const [r, row] of sheet.rows.entries())
        for (const [c, cell] of row.entries())
          if (cell.trim().startsWith("="))
            issues.push(
              `工作表 ${sheet.name} 第 ${r + 1} 行第 ${c + 1} 列以 = 开头；本系统只交付数据单元格，不写公式`,
            );
    }
  }
  return issues;
}

/* ---------- LaTeX 数学与行内富文本处理 ---------- */

const latexSymbols: [RegExp, string][] = [
  [/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, "$1"],
  [/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)"],
  [/\\sqrt\{([^{}]+)\}/g, "√($1)"],
  [/\\leq|\\le\b/g, "≤"],
  [/\\geq|\\ge\b/g, "≥"],
  [/\\neq|\\ne\b/g, "≠"],
  [/\\approx\b/g, "≈"],
  [/\\equiv\b/g, "≡"],
  [/\\sim\b/g, "∼"],
  [/\\times\b/g, "×"],
  [/\\cdot\b/g, "·"],
  [/\\pm\b/g, "±"],
  [/\\mp\b/g, "∓"],
  [/\\div\b/g, "÷"],
  [/\\infty\b/g, "∞"],
  [/\\degree|\\circ\b/g, "°"],
  [/\\rightarrow|\\to\b/g, "→"],
  [/\\leftarrow\b/g, "←"],
  [/\\Rightarrow\b/g, "⇒"],
  [/\\sum\b/g, "∑"],
  [/\\prod\b/g, "∏"],
  [/\\int\b/g, "∫"],
  [/\\partial\b/g, "∂"],
  [/\\nabla\b/g, "∇"],
  [/\\forall\b/g, "∀"],
  [/\\exists\b/g, "∃"],
  [/\\in\b/g, "∈"],
  [/\\subset\b/g, "⊂"],
  [/\\Delta\b/g, "Δ"],
  [/\\Sigma\b/g, "Σ"],
  [/\\Omega\b/g, "Ω"],
  [/\\Theta\b/g, "Θ"],
  [/\\Lambda\b/g, "Λ"],
  [/\\Phi\b/g, "Φ"],
  [/\\Psi\b/g, "Ψ"],
  [/\\alpha\b/g, "α"],
  [/\\beta\b/g, "β"],
  [/\\gamma\b/g, "γ"],
  [/\\delta\b/g, "δ"],
  [/\\varepsilon|\\epsilon\b/g, "ε"],
  [/\\zeta\b/g, "ζ"],
  [/\\eta\b/g, "η"],
  [/\\theta\b/g, "θ"],
  [/\\lambda\b/g, "λ"],
  [/\\mu\b/g, "μ"],
  [/\\nu\b/g, "ν"],
  [/\\pi\b/g, "π"],
  [/\\rho\b/g, "ρ"],
  [/\\sigma\b/g, "σ"],
  [/\\tau\b/g, "τ"],
  [/\\phi|\\varphi\b/g, "φ"],
  [/\\chi\b/g, "χ"],
  [/\\psi\b/g, "ψ"],
  [/\\omega\b/g, "ω"],
  [/\\[,;:! ]/g, " "],
  [/\\left|\\right/g, ""],
  [/\\%/g, "%"],
];

/** 把 LaTeX 数学表达式转为可读符号，保留 _{x}/^{x} 供上下标渲染。 */
export function normalizeMathText(expr: string): string {
  let s = expr.trim();
  for (let pass = 0; pass < 3; pass++) {
    for (const [re, rep] of latexSymbols) s = s.replace(re, rep);
  }
  return s
    .replace(/([ΔΣΩαβγδεζηθλμπρστφχω])\s+([A-Za-z])/g, "$1$2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function mathRuns(expr: string, base: { font?: string; size?: number; bold?: boolean }): TextRun[] {
  const clean = normalizeMathText(expr);
  const out: TextRun[] = [];
  const re = /_\{([^{}]+)\}|\^\{([^{}]+)\}|_([A-Za-z0-9α-ωΔΩ])|\^([A-Za-z0-9°+\-])/g;
  let last = 0;
  for (const m of clean.matchAll(re)) {
    if (m.index! > last)
      out.push(new TextRun({ text: clean.slice(last, m.index!), ...base }));
    const sub = m[1] || m[3];
    const sup = m[2] || m[4];
    if (sub) out.push(new TextRun({ text: sub, ...base, subScript: true }));
    else if (sup) out.push(new TextRun({ text: sup, ...base, superScript: true }));
    last = m.index! + m[0].length;
  }
  if (last < clean.length)
    out.push(new TextRun({ text: clean.slice(last), ...base }));
  return out;
}

/** 行内 **加粗**、*斜体*、`代码`、$公式$ 转为 Word TextRun。 */
function inlineRuns(
  line: string,
  base: { font?: string; size?: number; bold?: boolean; color?: string } = {},
): TextRun[] {
  const tokenRe = /(\*\*[^*]+\*\*|\$\$[^$]+\$\$|\$[^$\n]+\$|`[^`\n]+`|\*[^*\n]+\*)/g;
  const out: TextRun[] = [];
  let last = 0;
  for (const m of line.matchAll(tokenRe)) {
    if (m.index! > last)
      out.push(new TextRun({ text: line.slice(last, m.index!), ...base }));
    const tok = m[0];
    if (tok.startsWith("**") && tok.endsWith("**"))
      out.push(...inlineRuns(tok.slice(2, -2), { ...base, bold: true }));
    else if (tok.startsWith("$$") && tok.endsWith("$$"))
      out.push(...mathRuns(tok.slice(2, -2), base));
    else if (tok.startsWith("$") && tok.endsWith("$"))
      out.push(...mathRuns(tok.slice(1, -1), base));
    else if (tok.startsWith("`") && tok.endsWith("`"))
      out.push(
        new TextRun({
          text: tok.slice(1, -1),
          font: "Consolas",
          size: base.size ? Math.max(18, base.size - 2) : 20,
          shading: { type: ShadingType.CLEAR, fill: "F1F5F9" },
        }),
      );
    else if (tok.startsWith("*") && tok.endsWith("*"))
      out.push(new TextRun({ text: tok.slice(1, -1), ...base, italics: true }));
    last = m.index! + tok.length;
  }
  if (last < line.length)
    out.push(new TextRun({ text: line.slice(last), ...base }));
  return out.length ? out : [new TextRun({ text: line, ...base })];
}

const isTableRow = (line: string) => /^\s*\|.+\|\s*$/.test(line);
const isTableSep = (line: string) =>
  /^\s*\|[\s:|-]+\|\s*$/.test(line) && /---/.test(line);
const splitTableCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** 署名与个人信息短行（不首行缩进）。 */
const isSignatureLine = (line: string) =>
  /^(?:\*\*)?(?:作者|参赛作者|作者姓名|姓名|申报人|学校|就读学校|所在学校|院校|学院|就读院系|所属学院|专业|攻读专业|修读专业|学历身份|身份类别|身份|年级|班级|学号|联系电话|电话|手机|电子邮箱|邮箱|指导教师|指导老师|团队名称|所属团队|参赛赛道|作品名称|作品标题|日期|提交日期|赛氪报名编号)(?:\*\*)?\s*[：:]/.test(
    line.trim(),
  );

function buildDocxTable(
  headers: string[],
  rows: string[][],
  typo: Typography,
): Table {
  const cols = Math.max(headers.length, ...rows.map((r) => r.length));
  const cellFont = { font: typo.bodyFont, size: Math.max(18, Math.round(typo.bodySizePt * 2) - 2) };
  const border = { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" };
  const padRow = (r: string[]) =>
    Array.from({ length: cols }, (_, i) => r[i] ?? "");

  const headerRow = new TableRow({
    tableHeader: true,
    children: padRow(headers).map(
      (cell) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: "1B4F72" },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          borders: { top: border, bottom: border, left: border, right: border },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { line: 280, before: 0, after: 0 },
              children: inlineRuns(cell, { ...cellFont, bold: true, color: "FFFFFF" }),
            }),
          ],
        }),
    ),
  });
  const bodyRows = rows.map(
    (row, ri) =>
      new TableRow({
        children: padRow(row).map(
          (cell) =>
            new TableCell({
              shading:
                ri % 2 === 1
                  ? { type: ShadingType.CLEAR, fill: "F8FAFC" }
                  : undefined,
              margins: { top: 70, bottom: 70, left: 120, right: 120 },
              borders: { top: border, bottom: border, left: border, right: border },
              children: [
                new Paragraph({
                  spacing: { line: 280, before: 0, after: 0 },
                  children: inlineRuns(cell, cellFont),
                }),
              ],
            }),
        ),
      }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

async function imageBlocks(
  data: Buffer,
  caption: string,
  figIndex: number,
  typo: Typography,
): Promise<Paragraph[]> {
  const png = await sharp(data)
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  const maxW = 540, maxH = 420;
  const origW = meta.width || 800, origH = meta.height || 500;
  const scale = Math.min(maxW / origW, maxH / origH, 1);
  const w = Math.max(120, Math.round(origW * scale));
  const h = Math.max(80, Math.round(origH * scale));
  const out: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 80 },
      children: [
        new ImageRun({
          data: png,
          transformation: { width: w, height: h },
          type: "png",
        }),
      ],
    }),
  ];
  if (caption.trim()) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 160 },
        children: [
          new TextRun({
            text: /^图\s*\d+/.test(caption.trim())
              ? caption.trim()
              : `图 ${figIndex}  ${caption.trim()}`,
            font: typo.headingFont,
            size: Math.max(18, Math.round(typo.bodySizePt * 2) - 2),
            color: "475569",
          }),
        ],
      }),
    );
  }
  return out;
}

/** 把写作模型的 Markdown 正文转为完整 Word 块（支持表格、有序/无序列表、公式、嵌入式图片与 Mermaid/Chart 图示）。 */
export async function markdownDocxBlocks(
  title: string,
  text: string,
  opts: { typography?: Partial<Typography>; images?: Record<string, string> } = {},
): Promise<FileChild[]> {
  const typo = Typography.parse(opts.typography || {});
  const images = opts.images || {};
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && lines[first]!.replace(/^#+\s*/, "").trim() === title.trim())
    lines.splice(first, 1);

  const bodyHalfPt = Math.round(typo.bodySizePt * 2);
  const lineTwips = Math.round(240 * typo.lineSpacing);
  const indentTwips = Math.round(typo.firstLineIndentChars * typo.bodySizePt * 20);
  const beforeTwips = Math.round(typo.spaceBeforePt * 20);
  const afterTwips = Math.round(typo.spaceAfterPt * 20);
  const headingSizes = [
    Math.round((typo.bodySizePt + 4) * 2),
    Math.round((typo.bodySizePt + 2) * 2),
    Math.round((typo.bodySizePt + 1) * 2),
  ];
  const headingLevels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
  ];

  const out: FileChild[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 240, line: lineTwips },
      children: [
        new TextRun({
          text: title,
          font: typo.titleFont,
          size: Math.round(typo.titleSizePt * 2),
          bold: true,
          color: "111827",
        }),
      ],
    }),
  ];

  let figCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    // 1. 围栏代码块（mermaid / chart / 普通代码）
    const fence = /^\s*```([a-z0-9_-]*)\s*$/i.exec(line);
    if (fence) {
      const lang = (fence[1] || "").toLowerCase();
      const buf: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) {
        buf.push(lines[j]!);
        j++;
      }
      i = j;
      const body = buf.join("\n").trim();
      if (!body) continue;
      if (lang === "mermaid") {
        figCount++;
        const png = await renderMermaidPng(body);
        out.push(...(await imageBlocks(png.data, `系统结构与流程示意`, figCount, typo)));
        continue;
      }
      if (lang === "chart") {
        figCount++;
        const spec = ChartSpec.parse(JSON.parse(body));
        const png = await renderChartPng(spec);
        out.push(...(await imageBlocks(png.data, spec.title, figCount, typo)));
        continue;
      }
      for (const codeLine of buf) {
        out.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: "F8FAFC" },
            indent: { left: 240, right: 240 },
            spacing: { line: 260, before: 20, after: 20 },
            children: [
              new TextRun({ text: codeLine || " ", font: "Consolas", size: 19, color: "1E293B" }),
            ],
          }),
        );
      }
      continue;
    }

    // 2. 独立块级公式 $$ ... $$
    if (/^\s*\$\$\s*$/.test(line)) {
      const buf: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*\$\$\s*$/.test(lines[j]!)) {
        buf.push(lines[j]!);
        j++;
      }
      i = j;
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 100, after: 100, line: lineTwips },
          children: mathRuns(buf.join(" "), { font: typo.bodyFont, size: bodyHalfPt }),
        }),
      );
      continue;
    }

    // 3. Markdown 表格
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const headers = splitTableCells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]!)) {
        rows.push(splitTableCells(lines[j]!));
        j++;
      }
      i = j - 1;
      out.push(buildDocxTable(headers, rows, typo));
      out.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));
      continue;
    }

    // 4. 分隔线 --- / ***
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CBD5E1" } },
          spacing: { before: 80, after: 120 },
          children: [],
        }),
      );
      continue;
    }

    // 5. 独立图片行 ![alt](ref)
    const imgLine = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
    if (imgLine) {
      const alt = imgLine[1]!.trim();
      const ref = imgLine[2]!.trim();
      const filePath = images[ref];
      if (filePath && existsSync(filePath)) {
        figCount++;
        out.push(...(await imageBlocks(await readFile(filePath), alt, figCount, typo)));
        continue;
      }
    }

    // 6. 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(h[1]!.length, 3) - 1;
      out.push(
        new Paragraph({
          heading: headingLevels[lvl]!,
          keepNext: true,
          spacing: { before: lvl === 0 ? 220 : 160, after: 100, line: lineTwips },
          children: inlineRuns(h[2]!.replace(/\*\*/g, ""), {
            font: typo.headingFont,
            size: headingSizes[lvl]!,
            bold: true,
            color: lvl === 0 ? "1B4F72" : "1F2937",
          }),
        }),
      );
      continue;
    }

    // 7. 无序列表
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { line: lineTwips, before: beforeTwips, after: Math.max(40, afterTwips) },
          children: inlineRuns(bullet[1]!, { font: typo.bodyFont, size: bodyHalfPt }),
        }),
      );
      continue;
    }

    // 8. 有序列表
    const ordered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) {
      out.push(
        new Paragraph({
          numbering: { reference: "ordered-list", level: 0 },
          spacing: { line: lineTwips, before: beforeTwips, after: Math.max(40, afterTwips) },
          children: inlineRuns(ordered[2]!, { font: typo.bodyFont, size: bodyHalfPt }),
        }),
      );
      continue;
    }

    // 9. 引用块
    if (/^\s*>\s?/.test(line)) {
      out.push(
        new Paragraph({
          indent: { left: 420 },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: "2E86C1" } },
          shading: { type: ShadingType.CLEAR, fill: "F8FAFC" },
          spacing: { line: lineTwips, before: 60, after: 60 },
          children: inlineRuns(line.replace(/^\s*>\s?/, ""), {
            font: typo.bodyFont,
            size: bodyHalfPt,
            color: "334155",
          }),
        }),
      );
      continue;
    }

    // 10. 正文与署名短行
    const sig = isSignatureLine(line);
    out.push(
      new Paragraph({
        children: inlineRuns(line.trim(), { font: typo.bodyFont, size: bodyHalfPt }),
        ...(sig || !indentTwips ? {} : { indent: { firstLine: indentTwips } }),
        spacing: { line: lineTwips, before: beforeTwips, after: afterTwips },
      }),
    );
  }
  return out;
}

/** 保持兼容的同步段落接口；新导出统一走 markdownDocxBlocks。 */
export function markdownParagraphs(title: string, text: string): Paragraph[] {
  const typo = Typography.parse({});
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && lines[first]!.replace(/^#+\s*/, "").trim() === title.trim())
    lines.splice(first, 1);
  const out = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
  ];
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(new Paragraph({ text: h[2]!.replace(/\*\*/g, ""), heading: levels[Math.min(h[1]!.length, 3) - 1]! }));
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(new Paragraph({ children: inlineRuns(bullet[1]!, { font: typo.bodyFont, size: 24 }), bullet: { level: 0 } }));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out.push(new Paragraph({ children: inlineRuns(line.replace(/^\s*>\s?/, ""), { font: typo.bodyFont, size: 24 }), indent: { left: 480 } }));
      continue;
    }
    out.push(
      new Paragraph({
        children: inlineRuns(line.trim(), { font: typo.bodyFont, size: 24 }),
        ...(isSignatureLine(line) ? {} : { indent: { firstLine: 480 } }),
        spacing: { line: 360 },
      }),
    );
  }
  return out;
}

const escHtml = (x: string) =>
  x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlineHtml(line: string): string {
  const tokenRe = /(\*\*[^*]+\*\*|\$\$[^$]+\$\$|\$[^$\n]+\$|`[^`\n]+`|\*[^*\n]+\*)/g;
  let out = "", last = 0;
  for (const m of line.matchAll(tokenRe)) {
    if (m.index! > last) out += escHtml(line.slice(last, m.index!));
    const tok = m[0];
    if (tok.startsWith("**") && tok.endsWith("**"))
      out += `<strong>${inlineHtml(tok.slice(2, -2))}</strong>`;
    else if (tok.startsWith("$$") || tok.startsWith("$")) {
      const inner = normalizeMathText(tok.replace(/^\$\$?|\$\$?$/g, ""));
      out += escHtml(inner)
        .replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>")
        .replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>")
        .replace(/_([A-Za-z0-9])/g, "<sub>$1</sub>")
        .replace(/\^([A-Za-z0-9°+\-])/g, "<sup>$1</sup>");
    } else if (tok.startsWith("`"))
      out += `<code>${escHtml(tok.slice(1, -1))}</code>`;
    else if (tok.startsWith("*"))
      out += `<em>${escHtml(tok.slice(1, -1))}</em>`;
    last = m.index! + tok.length;
  }
  if (last < line.length) out += escHtml(line.slice(last));
  return out;
}

/** 渲染高质量 A4 HTML 文档（支持画册 portfolio 与正式文档 document 两种打印样式）。 */
export async function markdownToHtml(
  title: string,
  text: string,
  opts: { typography?: Partial<Typography>; images?: Record<string, string> } = {},
): Promise<string> {
  const typo = Typography.parse(opts.typography || {});
  const images = opts.images || {};
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && lines[first]!.replace(/^#+\s*/, "").trim() === title.trim())
    lines.splice(first, 1);

  const blocks: string[] = [];
  let figCount = 0;
  const imgDataUri = async (buf: Buffer) => {
    const png = await sharp(buf)
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (!line.trim()) continue;
    const fence = /^\s*```([a-z0-9_-]*)\s*$/i.exec(line);
    if (fence) {
      const lang = (fence[1] || "").toLowerCase();
      const buf: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) { buf.push(lines[j]!); j++; }
      i = j;
      const body = buf.join("\n").trim();
      if (!body) continue;
      if (lang === "mermaid") {
        figCount++;
        const uri = await imgDataUri((await renderMermaidPng(body)).data);
        blocks.push(`<figure><img src="${uri}" alt="图 ${figCount}"/><figcaption>图 ${figCount} 系统结构与流程示意</figcaption></figure>`);
        continue;
      }
      if (lang === "chart") {
        figCount++;
        const spec = ChartSpec.parse(JSON.parse(body));
        const uri = await imgDataUri((await renderChartPng(spec)).data);
        blocks.push(`<figure><img src="${uri}" alt="${escHtml(spec.title)}"/><figcaption>图 ${figCount} ${escHtml(spec.title)}</figcaption></figure>`);
        continue;
      }
      blocks.push(`<pre><code>${escHtml(body)}</code></pre>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const headers = splitTableCells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]!)) { rows.push(splitTableCells(lines[j]!)); j++; }
      i = j - 1;
      blocks.push(
        `<table><thead><tr>${headers.map((h) => `<th>${inlineHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }
    const imgLine = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
    if (imgLine && images[imgLine[2]!.trim()] && existsSync(images[imgLine[2]!.trim()]!)) {
      figCount++;
      const uri = await imgDataUri(await readFile(images[imgLine[2]!.trim()]!));
      const cap = imgLine[1]!.trim();
      blocks.push(`<figure><img src="${uri}" alt="${escHtml(cap)}"/><figcaption>${cap ? escHtml(/^图\s*\d+/.test(cap) ? cap : `图 ${figCount} ${cap}`) : `图 ${figCount}`}</figcaption></figure>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push("<hr/>"); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(h[1]!.length + 1, 4);
      blocks.push(`<h${lvl}>${inlineHtml(h[2]!)}</h${lvl}>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*[-*+]\s+(.*)$/.test(lines[j]!)) {
        items.push(`<li>${inlineHtml(lines[j]!.replace(/^\s*[-*+]\s+/, ""))}</li>`);
        j++;
      }
      i = j - 1;
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*\d+\.\s+(.*)$/.test(lines[j]!)) {
        items.push(`<li>${inlineHtml(lines[j]!.replace(/^\s*\d+\.\s+/, ""))}</li>`);
        j++;
      }
      i = j - 1;
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      blocks.push(`<blockquote>${inlineHtml(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    const cls = isSignatureLine(line) ? ' class="sig"' : "";
    blocks.push(`<p${cls}>${inlineHtml(line.trim())}</p>`);
  }

  const isPortfolio = typo.pdfLayout === "portfolio";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
@page { size: A4; margin: ${typo.marginCm}cm; }
body { font-family: "${typo.bodyFont}", "Microsoft YaHei", "Noto Sans CJK SC", serif; font-size: ${typo.bodySizePt}pt; line-height: ${typo.lineSpacing}; color: #1C2833; margin: 0; }
h1.doc-title { font-family: "${typo.titleFont}", "Microsoft YaHei", sans-serif; font-size: ${typo.titleSizePt}pt; text-align: center; color: ${isPortfolio ? "#1B4F72" : "#111827"}; margin: 0 0 18pt 0; ${isPortfolio ? "padding-bottom: 10pt; border-bottom: 2.5pt solid #1B4F72;" : ""} }
h2, h3, h4 { font-family: "${typo.headingFont}", "Microsoft YaHei", sans-serif; color: #1B4F72; page-break-after: avoid; margin: 14pt 0 6pt 0; }
h2 { font-size: ${typo.bodySizePt + 4}pt; } h3 { font-size: ${typo.bodySizePt + 2}pt; } h4 { font-size: ${typo.bodySizePt + 1}pt; }
p { margin: ${typo.spaceBeforePt}pt 0 ${typo.spaceAfterPt || 4}pt 0; text-indent: ${typo.firstLineIndentChars}em; text-align: justify; }
p.sig { text-indent: 0; margin: 2pt 0; }
ul, ol { margin: 4pt 0 8pt 0; padding-left: 2em; } li { margin: 2pt 0; }
blockquote { margin: 8pt 0; padding: 6pt 12pt; border-left: 3pt solid #2E86C1; background: #F8FAFC; color: #334155; }
table { width: 100%; border-collapse: collapse; margin: 10pt 0; font-size: ${Math.max(9, typo.bodySizePt - 1)}pt; page-break-inside: avoid; }
th { background: #1B4F72; color: #FFF; padding: 6pt 8pt; border: 0.5pt solid #CBD5E1; text-align: center; }
td { padding: 5pt 8pt; border: 0.5pt solid #CBD5E1; }
tbody tr:nth-child(even) { background: #F8FAFC; }
figure { margin: 12pt 0; text-align: center; page-break-inside: avoid; ${isPortfolio ? "background: #F8FAFC; padding: 10pt; border: 0.75pt solid #E2E8F0; border-radius: 6pt;" : ""} }
figure img { max-width: 100%; max-height: ${isPortfolio ? "16cm" : "11.5cm"}; object-fit: contain; }
figcaption { font-family: "${typo.headingFont}", sans-serif; font-size: ${Math.max(9, typo.bodySizePt - 1.5)}pt; color: #475569; margin-top: 6pt; }
pre { background: #F8FAFC; padding: 8pt 10pt; border: 0.5pt solid #E2E8F0; border-radius: 4pt; font-family: Consolas, monospace; font-size: 9.5pt; white-space: pre-wrap; }
code { font-family: Consolas, monospace; background: #F1F5F9; padding: 1pt 3pt; border-radius: 2pt; font-size: 0.92em; }
hr { border: none; border-top: 0.75pt solid #CBD5E1; margin: 12pt 0; }
</style></head><body><h1 class="doc-title">${escHtml(title)}</h1>${blocks.join("\n")}</body></html>`;
}

/** 纯文本：去掉 Markdown 与数学美元符标记，保留标题。 */
const plainText = (title: string, text: string) => {
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\$\$?([^$\n]+)\$\$?/g, (_, expr) => normalizeMathText(expr).replace(/[_^]\{([^{}]+)\}/g, "$1"));
  return `${title}\n\n${cleaned}`;
};

async function buildDocxBuffer(
  work: Work,
  images: Record<string, string>,
): Promise<Buffer> {
  const typo = Typography.parse(work.typography || {});
  const marginTwips = Math.round(typo.marginCm * 566.93);
  const children = await markdownDocxBlocks(work.title, work.text!, {
    typography: typo,
    images,
  });
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "ordered-list",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 540, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: {
            font: typo.bodyFont,
            size: Math.round(typo.bodySizePt * 2),
          },
          paragraph: {
            spacing: { line: Math.round(240 * typo.lineSpacing) },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: {
              top: marginTwips,
              bottom: marginTwips,
              left: marginTwips,
              right: marginTwips,
            },
          },
        },
        ...(typo.pageNumbers
          ? {
              footers: {
                default: new Footer({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({
                          children: [PageNumber.CURRENT],
                          font: typo.bodyFont,
                          size: 18,
                          color: "64748B",
                        }),
                      ],
                    }),
                  ],
                }),
              },
            }
          : {}),
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function renderPdfViaPdfkit(
  work: Work,
  out: string,
  images: Record<string, string>,
): Promise<void> {
  const font = [
    process.env.COMPETE_PDF_FONT,
    "C:\\Windows\\Fonts\\simhei.ttf",
    "/usr/share/fonts/truetype/arphic/ukai.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].find((x) => x && existsSync(x));
  if (!font)
    throw Error("没有可用的 PDF 字体，请通过 COMPETE_PDF_FONT 设置字体路径");
  if (/[^\x00-\x7F]/.test(work.text!) && font.includes("DejaVuSans"))
    throw Error(
      "PDF 需要中文字体，请通过 COMPETE_PDF_FONT 指定可嵌入的中文 TTF 字体",
    );
  const typo = Typography.parse(work.typography || {});
  const marginPt = Math.round(typo.marginCm * 28.35);
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: marginPt, bottom: marginPt, left: marginPt, right: marginPt },
    });
    const stream = createWriteStream(out);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
    (async () => {
      try {
        doc.pipe(stream);
        doc.font(font).fontSize(typo.titleSizePt).text(work.title, { align: "center" });
        doc.moveDown(0.8);
        const lines = work.text!.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!.trim();
          if (!line) continue;
          const img = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line);
          if (img && images[img[2]!] && existsSync(images[img[2]!])) {
            const png = await sharp(images[img[2]!]).resize({ width: 1000, fit: "inside" }).png().toBuffer();
            doc.image(png, { fit: [450, 320], align: "center" });
            if (img[1]) doc.fontSize(10).text(img[1], { align: "center" });
            doc.moveDown(0.4);
            continue;
          }
          const h = /^(#{1,6})\s+(.*)$/.exec(line);
          if (h) {
            const sz = Math.max(typo.bodySizePt + 1, typo.bodySizePt + 5 - h[1]!.length);
            doc.moveDown(0.4).fontSize(sz).text(h[2]!.replace(/\*\*/g, ""));
            doc.moveDown(0.2);
            continue;
          }
          const clean = line
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/\$\$?([^$\n]+)\$\$?/g, (_, e) => normalizeMathText(e));
          doc.fontSize(typo.bodySizePt).text(clean, {
            indent: isSignatureLine(line) ? 0 : typo.firstLineIndentChars * typo.bodySizePt,
            lineGap: Math.round(typo.bodySizePt * (typo.lineSpacing - 1)),
          });
        }
        doc.end();
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    })();
  });
}

/** PPT 中的图片压缩为 JPEG（最长边 1920），避免多张 5 MB 级的 PNG 让演示文稿过大。 */
async function slideImage(path: string) {
  const data = await sharp(path)
    .resize({
      width: 1920,
      height: 1920,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}
/** 列号转 Excel 列字母（0 起始）：0→A，25→Z，26→AA。 */
const colLetter = (index: number): string => {
  let n = index + 1,
    out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};
/** officecli 可能把纯数字写成数值单元格，回读比对时按数值宽限。 */
const sameCell = (a: string, b: string): boolean =>
  a === b ||
  (a.trim() !== "" &&
    b.trim() !== "" &&
    Number.isFinite(Number(a)) &&
    Number.isFinite(Number(b)) &&
    Number(a) === Number(b));

/** 用 officecli 真实创建 OOXML 工作簿；关闭驻留进程后逐格回读核对，不靠命令自述。 */
async function renderSpreadsheet(work: Work, out: string): Promise<string> {
  const sheets = work.sheets!;
  const commands: Record<string, unknown>[] = [];
  for (const [i, sheet] of sheets.entries()) {
    commands.push(
      i === 0
        ? { command: "set", path: "/Sheet1", props: { name: sheet.name } }
        : {
            command: "add",
            parent: "/",
            type: "sheet",
            props: { name: sheet.name },
          },
    );
    for (const [r, row] of sheet.rows.entries())
      for (const [c, value] of row.entries())
        if (value !== "")
          commands.push({
            command: "set",
            path: `/${sheet.name}/${colLetter(c)}${r + 1}`,
            props: { value, ...(r === 0 ? { bold: "true" } : {}) },
          });
  }
  const batchFile = `${out}.batch.json`;
  await writeFile(batchFile, JSON.stringify(commands), "utf8");
  try {
    await runOfficecli(["create", out], 60_000);
    await runOfficecli(["batch", out, "--input", batchFile], 300_000);
    await runOfficecli(["validate", out], 60_000);
    await runOfficecli(["close", out], 60_000).catch(() => {});
    const written = await readXlsx(await readFile(out));
    const missing: string[] = [];
    for (const [i, sheet] of sheets.entries()) {
      const actual = written.sheets[i];
      if (!actual) {
        missing.push(`工作表 ${sheet.name} 缺失`);
        continue;
      }
      for (const [r, row] of sheet.rows.entries())
        for (const [c, value] of row.entries())
          if (
            value !== "" &&
            !sameCell(actual.rows[r]?.[c] ?? "", value)
          )
            missing.push(
              `${sheet.name} ${colLetter(c)}${r + 1}：应为 ${value}，实际 ${actual.rows[r]?.[c] ?? "（空）"}`,
            );
    }
    if (missing.length)
      throw Error(`工作簿回读核对不一致：${missing.slice(0, 8).join("；")}`);
    return out;
  } finally {
    await rm(batchFile, { force: true }).catch(() => {});
  }
}

export async function renderWork(
  work: Work,
  format: string,
  folder: string,
  baseName = "submission",
  images: Record<string, string> = {},
): Promise<string> {
  await mkdir(folder, { recursive: true });
  const ext = format.toLowerCase().replace(/^\./, "");
  const allowed =
    work.kind === "slides"
      ? ["pptx"]
      : work.kind === "spreadsheet"
        ? ["xlsx"]
        : ["txt", "md", "docx", "pdf"];
  if (!allowed.includes(ext))
    throw Error(
      `当前无法制作 ${work.kind}/${ext}，已保留研究和方案；需要相应制作适配器`,
    );
  const issues = validateWork(
    work,
    work.kind === "slides" || work.kind === "text" ? images : undefined,
  );
  if (issues.length) throw Error(`作品自动检查未通过：${issues.join("；")}`);
  const out = join(folder, `${baseName}.${ext}`);
  if (ext === "xlsx") return renderSpreadsheet(work, out);
  if (ext === "pptx") {
    const ppt = new PptxGenJS();
    ppt.layout = "LAYOUT_WIDE";
    ppt.author = "Competition CLI";
    ppt.subject = "Competition entry";
    const theme = SLIDE_THEMES[work.theme || "academic-blue"];
    const total = work.slides!.length;
    for (const [index, slide] of work.slides!.entries()) {
      if (isSemanticSlide(slide)) {
        await renderSemanticSlide(ppt, slide, {
          theme,
          index,
          total,
          deckTitle: work.title,
          images,
        });
        continue;
      }
      const page = ppt.addSlide();
      page.background = { color: slide.background };
      for (const e of slide.elements) {
        if (e.type === "image") {
          page.addImage({
            data: await slideImage(images[e.ref!]!),
            x: e.x,
            y: e.y,
            w: e.w,
            h: e.h,
            sizing: { type: "contain", w: e.w, h: e.h },
          });
        } else if (e.type === "text")
          page.addText(e.text, {
            x: e.x,
            y: e.y,
            w: e.w,
            h: e.h,
            fontFace: "Microsoft YaHei",
            fontSize: e.fontSize,
            color: e.color,
            bold: e.bold,
            margin: 0,
            breakLine: false,
            fit: "shrink",
          });
        else
          page.addShape(ppt.ShapeType[e.type], {
            x: e.x,
            y: e.y,
            w: e.w,
            h: e.h,
            line: { color: e.color },
            ...(e.fill ? { fill: { color: e.fill } } : {}),
          });
      }
    }
    await ppt.writeFile({ fileName: out });
    const archive = await JSZip.loadAsync(await readFile(out));
    const count = Object.keys(archive.files).filter((x) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(x),
    ).length;
    if (count !== work.slides!.length) throw Error("PPT 页数校验失败");
  } else if (ext === "pdf") {
    const typo = Typography.parse(work.typography || {});
    let done = false;
    // 画册/作品集 PDF 优先走 HTML+CSS Print → Chromium；正式文稿优先走 DOCX 同源样式 → Office 转 PDF。
    if (typo.pdfLayout === "portfolio") {
      try {
        const html = await markdownToHtml(work.title, work.text!, { typography: typo, images });
        await renderHtmlToPdf(html, out);
        done = true;
      } catch { /* 无浏览器时继续尝试 DOCX 转 PDF。 */ }
    }
    if (!done) {
      const tempDir = await mkdtemp(join(tmpdir(), "pdf-from-docx-"));
      try {
        const tempDocx = join(tempDir, "source.docx");
        await writeFile(tempDocx, await buildDocxBuffer(work, images));
        await docxToPdf(tempDocx, out);
        done = true;
      } catch {
        // Office 不可用时再尝试 HTML → Chromium，最后退回结构化 pdfkit。
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!done) {
      try {
        const html = await markdownToHtml(work.title, work.text!, { typography: typo, images });
        await renderHtmlToPdf(html, out);
        done = true;
      } catch { /* 无浏览器时退回结构化 pdfkit。 */ }
    }
    if (!done) await renderPdfViaPdfkit(work, out, images);
  } else if (ext === "docx") {
    await writeFile(out, await buildDocxBuffer(work, images));
  } else if (ext === "md")
    await writeFile(
      out,
      /^#\s/.test(work.text!.trimStart())
        ? work.text!
        : `# ${work.title}\n\n${work.text}`,
      "utf8",
    );
  else await writeFile(out, plainText(work.title, work.text!), "utf8");
  return out;
}
