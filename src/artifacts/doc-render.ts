/**
 * DOCX 渲染：先转成 PDF，再从同一份 PDF 取页数、逐页图片和逐页文字。
 * 页数、截图和文字只有一个来源，不会出现“统计 6 页、截图只有 5 页”而漏看最后一页。
 * Windows 优先用本机 Word 导出，其余平台（或 Word 不可用时）用 LibreOffice。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { browserAvailability } from "./browser-checks.js";

const exec = promisify(execFile);

export type RenderedDoc = {
  /** 真实总页数。 */
  pages: number;
  /** 每页可提取的文字，下标 0 为第 1 页。 */
  text: string[];
  /** 渲染指定页（从 1 开始）为 PNG。 */
  png(page: number): Promise<Buffer>;
  dispose(): Promise<void>;
};

const wordScript = `param([string]$In, [string]$Out)
$ErrorActionPreference = "Stop"
$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $false
  $w.DisplayAlerts = 0
  $d = $w.Documents.Open($In, $false, $true, $false)
  try { $d.ExportAsFixedFormat($Out, 17) } finally { $d.Close([ref]0) }
} finally {
  try { $w.Quit([ref]0) } catch {}
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w)
}
`;

const exists = (path: string) => stat(path).then((s) => s.size > 0, () => false);
const reason = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split(/\r?\n/).filter(Boolean).slice(0, 3).join(" ").slice(0, 400);

async function viaWord(file: string, dir: string, out: string): Promise<void> {
  const script = join(dir, "export.ps1");
  // PowerShell 5 按系统代码页读取无 BOM 脚本；脚本只含 ASCII，路径通过参数传入。
  await writeFile(script, wordScript, "ascii");
  await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, "-In", file, "-Out", out], { timeout: 180_000, windowsHide: true, maxBuffer: 2_000_000 });
  if (!(await exists(out))) throw Error("Word 没有生成 PDF");
}

async function viaLibreOffice(file: string, dir: string, out: string): Promise<void> {
  const profile = pathToFileURL(join(dir, "lo-profile")).href;
  await exec(process.env.COMPETE_SOFFICE || "soffice", ["--headless", `-env:UserInstallation=${profile}`,
    "--convert-to", "pdf", "--outdir", dir, file], { timeout: 180_000, windowsHide: true, maxBuffer: 2_000_000 });
  const made = join(dir, basename(file).replace(/\.[^.]+$/, "") + ".pdf");
  if (!(await exists(made))) throw Error("LibreOffice 没有生成 PDF");
  if (made !== out) await writeFile(out, await readFile(made));
}

/** 把 DOCX 转换为 PDF 文件；优先使用本机 Word，其次 LibreOffice。 */
export async function docxToPdf(source: string, outPath: string): Promise<void> {
  const file = resolve(source);
  const target = resolve(outPath);
  const dir = await mkdtemp(join(tmpdir(), "docx2pdf-"));
  const tempOut = join(dir, "rendered.pdf");
  const failures: string[] = [];
  const converters: [string, () => Promise<void>][] = [
    ...(process.platform === "win32" && !process.env.COMPETE_SOFFICE
      ? [["Word", () => viaWord(file, dir, tempOut)] as [string, () => Promise<void>]] : []),
    ["LibreOffice", () => viaLibreOffice(file, dir, tempOut)],
  ];
  try {
    let done = false;
    for (const [name, convert] of converters) {
      try { await convert(); done = true; break; }
      catch (e) { failures.push(`${name}：${reason(e)}`); }
    }
    if (!done)
      throw Error(`无法把 Word 文档转换为 PDF（${failures.join("；")}）；请安装 Microsoft Word 或 LibreOffice，或用 COMPETE_SOFFICE 指定 soffice 路径`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(tempOut));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 离线把 HTML 渲染成 A4 PDF（用于画册/作品集 PDF 或无 Office 环境下的富排版 PDF）。 */
export async function renderHtmlToPdf(html: string, outPath: string): Promise<void> {
  const avail = browserAvailability();
  if (!avail.available || !avail.executablePath)
    throw Error(avail.reason || "浏览器不可用，无法通过 Chromium 导出 PDF");
  const browser = await chromium.launch({
    executablePath: avail.executablePath,
    headless: true,
    timeout: 25_000,
  });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await page.pdf({
      path: resolve(outPath),
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

async function openPdfAsRendered(
  pdfPath: string,
  cleanup?: () => Promise<void>,
): Promise<RenderedDoc> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  const text: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    text.push((await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(""));
  }
  return {
    pages: doc.numPages,
    text,
    async png(n) {
      const { createCanvas } = await import("@napi-rs/canvas");
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({
        canvasContext: canvas.getContext("2d") as never, viewport, canvas: canvas as never,
      }).promise;
      return canvas.toBuffer("image/png");
    },
    async dispose() {
      await doc.destroy().catch(() => {});
      if (cleanup) await cleanup();
    },
  };
}

/** 统计 PDF 实际绘制的图片对象数，防止纯文字假图集 PDF 冒充图片作品通过验收。 */
export async function countPdfImages(source: string): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await readFile(resolve(source))),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  const imageOps = new Set<number>([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageMaskXObject,
    pdfjs.OPS.paintImageXObjectRepeat,
  ].filter((x): x is number => typeof x === "number"));
  let count = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) if (imageOps.has(fn)) count++;
    }
    return count;
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/** 直接打开已有 PDF，逐页提取文字和 PNG 截图供视觉版面审查。 */
export async function renderPdf(source: string): Promise<RenderedDoc> {
  return openPdfAsRendered(resolve(source));
}

/** 把 DOCX 转成 PDF 并打开；全部转换方式失败时抛错，不能渲染就不能声称版式合格。 */
export async function renderDocx(source: string): Promise<RenderedDoc> {
  const dir = await mkdtemp(join(tmpdir(), "docpdf-"));
  const out = join(dir, "rendered.pdf");
  try {
    await docxToPdf(source, out);
    return await openPdfAsRendered(out, () => rm(dir, { recursive: true, force: true }).catch(() => {}));
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

const squash = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");

/**
 * 核对文档原文是否都出现在渲染页面上。按均匀取样的片段比对：
 * 结尾缺失或大面积缺失是明确丢内容；少量差异（页眉页脚、自动编号）只作提示。
 */
export function textCoverage(source: string, pages: string[]): {
  status: "verified" | "mismatch"; blocking: boolean; details: string;
} {
  const full = squash(source), rendered = squash(pages.join(""));
  if (!full) return { status: "verified", blocking: false, details: "文档没有正文文字，无需比对" };
  if (!rendered) return { status: "mismatch", blocking: true, details: "渲染出的页面没有任何可提取文字，正文可能没有显示" };
  const size = 16;
  if (full.length <= size) {
    const ok = rendered.includes(full);
    return { status: ok ? "verified" : "mismatch", blocking: !ok,
      details: ok ? "渲染页面包含全部正文" : "渲染页面缺少文档正文" };
  }
  const count = Math.min(40, Math.floor(full.length / size));
  const step = (full.length - size) / Math.max(1, count - 1);
  let found = 0;
  for (let i = 0; i < count; i++) {
    const start = Math.round(i * step);
    if (rendered.includes(full.slice(start, start + size))) found++;
  }
  const tail = full.slice(-size), ratio = found / count;
  // 结尾恰好跨页时中间可能夹着页码，所以也接受前后两半分别出现。
  const tailShown = rendered.includes(tail) ||
    (rendered.includes(tail.slice(0, size / 2)) && rendered.includes(tail.slice(size / 2)));
  if (!tailShown)
    return { status: "mismatch", blocking: true,
      details: `文档结尾（“${tail}”）没有出现在渲染页面上（${count} 处取样命中 ${found} 处）：末尾内容丢失，需要补全后重新导出` };
  if (ratio < 0.5)
    return { status: "mismatch", blocking: true,
      details: `渲染页面只包含文档 ${count} 处取样中的 ${found} 处：大量正文没有显示，需要检查后重新导出` };
  if (ratio < 0.9)
    return { status: "mismatch", blocking: false,
      details: `渲染页面包含文档 ${count} 处取样中的 ${found} 处；差异可能来自页眉页脚或自动编号，请人工复核` };
  return { status: "verified", blocking: false,
    details: `全部 ${pages.length} 页的文字与文档原文比对一致（${count} 处取样命中 ${found} 处，结尾完整）` };
}

/** 实际使用的渲染器；测试可替换，避免依赖本机 Word 或 PDF 渲染。 */
export const renderers: {
  docx: (file: string) => Promise<RenderedDoc>;
  pdf: (file: string) => Promise<RenderedDoc>;
} = { docx: renderDocx, pdf: renderPdf };
