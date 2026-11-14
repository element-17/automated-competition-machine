import { z } from "zod";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { runOfficecli } from "./officecli.js";
import { readXlsx } from "./xlsx.js";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { createRequire } from "node:module";
import JSZip from "jszip";
const PptxGenJS = createRequire(import.meta.url)("pptxgenjs") as new () => any;
const PDFDocument = createRequire(import.meta.url)(
  "pdfkit",
) as typeof import("pdfkit");

const color = z.string().regex(/^[0-9A-Fa-f]{6}$/);
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
export const Slide = z.object({
  background: color.default("FFFFFF"),
  elements: z.array(Element).min(1).max(30),
});
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
export function validateWork(
  work: Work,
  images?: Record<string, string>,
): string[] {
  const issues: string[] = [];
  if (work.kind === "slides")
    for (const [i, slide] of (work.slides || []).entries()) {
      for (const [j, e] of slide.elements.entries()) {
        if (e.x + e.w > 13.3334 || e.y + e.h > 7.5)
          issues.push(`第 ${i + 1} 页第 ${j + 1} 个元素越界`);
        if (e.type === "image" && images && !images[e.ref!])
          issues.push(
            `第 ${i + 1} 页第 ${j + 1} 个图片元素引用了不存在的图片 ${e.ref}；只能使用 ${Object.keys(images).join("、") || "（当前没有可用图片，请删除图片元素）"}`,
          );
        if (e.type === "text") {
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
/** 行内 **加粗** 转为 Word 文本片段。 */
const runs = (line: string) =>
  line
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) =>
      /^\*\*[^*]+\*\*$/.test(part)
        ? new TextRun({ text: part.slice(2, -2), bold: true })
        : new TextRun(part),
    );
/** 把写作模型的 Markdown 正文转为带标题、列表样式的 Word 段落；正文首行与标题相同时不重复。 */
export function markdownParagraphs(title: string, text: string): Paragraph[] {
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
  const levels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
  ];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(
        new Paragraph({
          text: h[2]!.replace(/\*\*/g, ""),
          heading: levels[Math.min(h[1]!.length, 3) - 1]!,
        }),
      );
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(
        new Paragraph({ children: runs(bullet[1]!), bullet: { level: 0 } }),
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out.push(
        new Paragraph({
          children: runs(line.replace(/^\s*>\s?/, "")),
          indent: { left: 480 },
        }),
      );
      continue;
    }
    out.push(
      new Paragraph({
        children: runs(line.trim()),
        indent: { firstLine: 480 },
        spacing: { line: 360 },
      }),
    );
  }
  return out;
}
/** 纯文本与 PDF：去掉 Markdown 标记，保留标题。 */
const plainText = (title: string, text: string) =>
  `${title}\n\n${text.replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1")}`;
/** PPT 中的图片压缩为 JPEG（最长边 1920），避免多张 5 MB 级的 PNG 让演示文稿过大。 */
async function slideImage(path: string) {
  const sharp = (await import("sharp")).default;
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
    work.kind === "slides" ? images : undefined,
  );
  if (issues.length) throw Error(`作品自动检查未通过：${issues.join("；")}`);
  const out = join(folder, `${baseName}.${ext}`);
  if (ext === "xlsx") return renderSpreadsheet(work, out);
  if (ext === "pptx") {
    const ppt = new PptxGenJS();
    ppt.layout = "LAYOUT_WIDE";
    ppt.author = "Competition CLI";
    ppt.subject = "Competition entry";
    for (const slide of work.slides!) {
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
    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 54, bottom: 54, left: 54, right: 54 },
      });
      const stream = createWriteStream(out);
      stream.on("finish", resolve);
      stream.on("error", reject);
      doc.on("error", reject);
      try {
        doc.pipe(stream);
        doc
          .font(font)
          .fontSize(12)
          .text(plainText(work.title, work.text!), { lineGap: 4 });
        doc.end();
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    });
  } else if (ext === "docx") {
    const doc = new Document({
      styles: { default: { document: { run: { font: "宋体", size: 24 } } } },
      sections: [{ children: markdownParagraphs(work.title, work.text!) }],
    });
    await writeFile(out, await Packer.toBuffer(doc));
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
