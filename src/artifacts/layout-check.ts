/**
 * 版面审查：用 officecli 把 docx/pptx 渲染成真实页面，交给排版 Agent 看图，
 * 只找肉眼可见的版面缺陷。失败一律抛错——不能渲染就不能声称版式合格。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ModelGateway } from "../core/types.js";
import { parseJSON } from "../core/gateway.js";
import { isJobControlError } from "../core/job-control.js";
import { budgetError } from "../workflows/shared.js";
import { renderers, textCoverage, type RenderedDoc } from "./doc-render.js";

const exec = promisify(execFile);
const officecli = () => process.env.COMPETE_OFFICECLI || "officecli";
const Criterion = z.object({
  criterion: z.number().int().nonnegative(),
  status: z.enum(["passed", "failed", "unverified", "not_applicable"]),
  evidence: z.string(),
});
const Layout = z.object({
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  criteria: z.array(Criterion).optional(),
});
export type LayoutReport = {
  issues: string[];
  suggestions: string[];
  checked: number;
  /** 未能可靠确定页数时为 null，不能拿抽检页数冒充总页数。 */
  totalPages: number | null;
  checkedPages: number[];
  failedPages: number[];
  /** 全部真实页面已完成视觉评审；缺陷看 issues，逐字完整性看 textCoverage。 */
  complete: boolean;
  /** Word：渲染页面的文字与文档原文逐段比对的结果；幻灯片不适用。 */
  textCoverage: "verified" | "mismatch" | "unverified" | "not_applicable";
  textCoverageDetails: string;
  criteria?: {
    criterion: number;
    status: "passed" | "failed" | "unverified";
    evidence: string;
  }[];
};

/** officecli 是否可用。 */
export async function officeAvailable(): Promise<boolean> {
  try {
    await exec(officecli(), ["--version"], {
      timeout: 15_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
async function requireOffice(): Promise<void> {
  if (await officeAvailable()) return;
  throw Error(
    `排版审查需要 officecli，但无法执行 ${officecli()}；请安装 officecli 或用 COMPETE_OFFICECLI 指定可执行文件`,
  );
}
/** 只信 CLI 输出的明确页码越界诊断；Error.message 含命令行和 --page，不能用于探测。 */
function pageOutOfRange(error: unknown, page: number): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { stdout?: unknown; stderr?: unknown; killed?: boolean; signal?: unknown };
  if (e.killed || e.signal) return false;
  const diagnostic = [e.stdout, e.stderr]
    .filter((x) => typeof x === "string" || Buffer.isBuffer(x))
    .map(String).join("\n");
  return diagnostic.split(/\r?\n/).some((line) => {
    const message = line.trim().replace(/^(?:error|错误)\s*[:：]\s*/i, "");
    return new RegExp(`^(?:page|slide)(?: number| index)?\\s+${page}\\s+(?:is\\s+)?out of range\\b`, "i").test(message) ||
      new RegExp(`^第?\\s*${page}\\s*页(?:页码)?(?:超出|超越)(?:范围|总页数)`).test(message);
  });
}

/** 渲染单页为 PNG；只有明确越界返回 false，空图与其他失败均抛错。 */
async function shot(file: string, page: number, out: string): Promise<boolean> {
  try {
    await exec(officecli(), ["view", file, "screenshot", "--page", String(page), "-o", out,
    ], {
      timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000,
    });
  } catch (e) {
    if (pageOutOfRange(e, page)) return false;
    throw Error(`渲染 ${file} 第 ${page} 页失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!(await readFile(out)).length) throw Error(`渲染 ${file} 第 ${page} 页生成空图片`);
  return true;
}

const docxRubric = `任务：排版审查。现在看到的是 Word/PDF 文档渲染后的真实页面（长文档会分页，看到的是其中一页）。只指出肉眼可见、会影响阅读的版面缺陷：Markdown 表格符号（竖线、横线）被当成普通文字显示而没有变成表格；单独成行的分隔线或代码围栏符号；星号、井号、美元符公式或图片 Markdown 链接（![...](...)）等未转换的标记；标题层级在字号和缩进上明显不连贯；文字溢出页面边界、元素互相重叠或在页面中间被裁掉；声明了图题或图片展示区却缺失实际图像、图片位置错乱或没有图题；同类元素样式明显不统一。

分页可以断在句子中间：某一页最后一行停在半句、下一页接着写是正常现象，不是缺陷，也不要据此判断内容被截断；全文文字是否完整由程序逐字比对，不需要你判断。只检查这一页上实际可见的问题：文字被裁切、重叠、异常的大片空白或空页。最后一页内容较少、下方留白是正常的。

不评价内容质量，不因措辞、标点或个人偏好提意见。每条写清楚现象和改法，最多 5 条，没有缺陷时 issues 为空数组。只输出 JSON {"issues":["阻塞版面缺陷"],"suggestions":["可选改进"]}。`;
const pptxRubric = `任务：幻灯片版面审查。现在看到的是 PPT 渲染后的真实一页。只指出肉眼可见、会影响观感的版面缺陷：文字溢出页面或文本框、文字互相重叠、文字与图片重叠遮挡；元素明显越界或被裁掉；同一页字号、颜色、对齐混乱；标题缺失或每页位置不一致；图片拉伸变形、模糊或占位失败；整页几乎空白或文字小到看不清。不评价内容观点和措辞。每条写清楚现象和改法，最多 5 条，没有缺陷时 issues 为空数组。只输出 JSON {"issues":["阻塞版面缺陷"],"suggestions":["可选改进"]}。`;

/** PPT 由 stats 提供真实页数；Word 的页数来自渲染出的 PDF，不走这里。 */
async function pageCount(file: string): Promise<number | null> {
  const { stdout } = await exec(officecli(), ["view", file, "stats"], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 2_000_000,
  });
  const m = /^(?:Slides|Pages|总页数|页数)\s*[:：]\s*(\d+)\s*$/im.exec(stdout);
  if (!m) return null;
  const count = Number(m[1]);
  if (!Number.isSafeInteger(count) || count < 1) throw Error(`无效文档页数：${m[1]}`);
  return count;
}

/**
 * 逐页渲染并检查版面；任何一页渲染失败或看图模型不可用都抛错。
 * pages 为空时检查全部页面。
 */
export async function checkLayout(
  gateway: ModelGateway,
  file: string,
  pages?: number[],
  criteria?: { criterion: number; requirement: string }[],
  render?: (file: string) => Promise<RenderedDoc>,
): Promise<LayoutReport> {
  const ext = extname(file).toLowerCase();
  const isDocx = ext === ".docx";
  const isPdf = ext === ".pdf";
  const isDocLike = isDocx || isPdf;
  const report: LayoutReport = {
    issues: [], suggestions: [], checked: 0, totalPages: null,
    checkedPages: [], failedPages: [], complete: false,
    textCoverage: isDocLike ? "unverified" : "not_applicable",
    textCoverageDetails: isDocLike
      ? "尚未完成渲染页面与文档原文的文字比对"
      : "幻灯片由逐页视觉检查核验，不做Word全文比对",
  };
  let rendered: RenderedDoc | undefined;
  const requested = criteria || [];
  const observations = new Map<number, z.infer<typeof Criterion>[]>();
  const summarize = () => {
    if (!criteria) return;
    report.criteria = requested.map(({ criterion }) => {
      const rows = observations.get(criterion) || [];
      const failed = rows.some((x) => x.status === "failed");
      const passed = report.complete && rows.some((x) => x.status === "passed") &&
        !rows.some((x) => x.status === "unverified");
      return {
        criterion, status: failed ? "failed" : passed ? "passed" : "unverified",
        evidence: rows.map((x) => x.evidence).filter(Boolean).join("；") || "没有实际页面证据",
      };
    });
  };
  let dir: string | undefined;
  try {
    if (!gateway.inspectImage) throw Error("排版审查需要能看图的评审模型，当前配置的模型不支持图片输入");
    if (pages?.some((page) => !Number.isSafeInteger(page) || page < 1))
      throw Error("检查页码必须是正整数");
    if (requested.some((x) => !Number.isSafeInteger(x.criterion) || x.criterion < 0 || !x.requirement.trim()) ||
        new Set(requested.map((x) => x.criterion)).size !== requested.length)
      throw Error("视觉标准编号必须唯一且要求不能为空");
    if (!isDocLike) await requireOffice();
    const sharp = (await import("sharp")).default;
    dir = await mkdtemp(join(tmpdir(), "layout-"));
    // Word / PDF：页数、截图和文字都来自同一份 PDF 渲染结果，不会出现统计页数与可截图页数不一致。
    if (isDocLike) {
      const fn = render || (isPdf ? renderers.pdf : renderers.docx);
      rendered = await fn(file);
    }
    const reported = rendered ? rendered.pages : await pageCount(file);
    if (reported !== null && (!Number.isSafeInteger(reported) || reported < 1))
      throw Error("文档没有可渲染页面");
    report.totalPages = reported;
    if (reported !== null && reported > maxPages)
      throw Error(`文档共 ${reported} 页，超过单次可检查页数 ${maxPages}，未完成检查`);
    const selected = pages?.length ? [...new Set(pages)].sort((a, b) => a - b) : undefined;
    // 未知总页数必须连续探测；抽检列表不能用来推算总页数。截图保存在临时目录避免长文档占满内存。
    const targets = reported === null ? range(maxPages + 1) : selected || range(reported);
    const shots = new Map<number, string>();
    const fingerprints = new Set<string>();
    const failures: string[] = [];
    for (const page of targets) {
      const out = join(dir, `p${page}.png`);
      try {
        if (rendered) await writeFile(out, await rendered.png(page));
        const exists = rendered ? true : await shot(file, page, out);
        if (rendered && !(await readFile(out)).length) throw Error(`渲染 ${file} 第 ${page} 页生成空图片`);
        if (!exists) {
          if (reported !== null) throw Error(`总页数为 ${reported}，请求第 ${page} 页却返回越界`);
          if (page === 1) throw Error("文档没有可渲染页面");
          report.totalPages = page - 1;
          break;
        }
        if (page > maxPages) throw Error(`逐页探测超过 ${maxPages} 页，真实总页数未知，未完成检查`);
        if (reported === null) {
          const hash = createHash("sha256").update(await readFile(out)).digest("hex");
          if (fingerprints.has(hash)) {
            report.failedPages.push(page);
            failures.push(`真实总页数未知且第 ${page} 页返回重复截图，无法区分重复页面与越界回退，停止探测`);
            break;
          }
          fingerprints.add(hash);
        }
        shots.set(page, out);
      } catch (e) {
        if (isJobControlError(e) || budgetError(e)) throw e;
        report.failedPages.push(page);
        failures.push(e instanceof Error ? e.message : String(e));
        if (reported === null) break;
      }
    }
    if (report.totalPages === null) failures.push("未能确定文档真实总页数");
    const total = report.totalPages;
    for (const page of selected || [...shots.keys()]) {
      const out = shots.get(page);
      if (!out) {
        if (!report.failedPages.includes(page)) {
          report.failedPages.push(page);
          failures.push(`第 ${page} 页未成功渲染`);
        }
        continue;
      }
      try {
        const jpeg = await sharp(await readFile(out)).jpeg({ quality: 85 }).toBuffer();
        const rubric = isDocLike ? docxRubric : pptxRubric;
        const criterionPrompt = requested.length
          ? `\n同时核验这些视觉标准：${JSON.stringify(requested)}。在 JSON 中增加 criteria 数组，每项含 criterion、status、evidence。status 为 passed/failed/unverified/not_applicable；只按本页实际证据判断。不适用于本页的项用 not_applicable 并说明原因，无法判断用 unverified，禁止无证据通过。每个编号恰好出现一次。`
          : "";
        const value = Layout.parse(parseJSON(await gateway.inspectImage(
          `${rubric}\n这是第 ${page} 页，共 ${total ?? "未知"} 页${page === total ? "（最后一页）" : ""}。${criterionPrompt}`,
          { data: jpeg, mime: "image/jpeg" }, "layout",
        )));
        report.checkedPages.push(page);
        report.checked = report.checkedPages.length;
        report.issues.push(...value.issues.map((x) => `第 ${page} 页：${x}`));
        report.suggestions.push(...value.suggestions.map((x) => `第 ${page} 页：${x}`));
        for (const { criterion } of requested) {
          const matches = value.criteria?.filter((x) => x.criterion === criterion) || [];
          const row = matches.length === 1 && matches[0]!.evidence.trim() ? matches[0]! : {
            criterion, status: "unverified" as const, evidence: "标准缺失、重复或缺少证据",
          };
          const prior = observations.get(criterion) || [];
          prior.push({ ...row, evidence: `第 ${page} 页：${row.evidence}` });
          observations.set(criterion, prior);
        }
      } catch (e) {
        if (isJobControlError(e) || budgetError(e)) throw e;
        report.failedPages.push(page);
        failures.push(`第 ${page} 页评审失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length) throw Error(failures.join("；"));
    if (!report.checked) throw Error("没有成功检查任何一页");
    // 渲染页面上的文字与文档原文比对：结尾或大段缺失是明确的丢内容，阻塞交付。
    if (rendered) {
      const { readSource } = await import("../competition/sources.js");
      const coverage = textCoverage(await readSource(file), rendered.text);
      report.textCoverage = coverage.status;
      report.textCoverageDetails = coverage.details;
      if (coverage.blocking) report.issues.push(coverage.details);
      else if (coverage.status === "mismatch") report.suggestions.push(coverage.details);
    }
    report.complete = total !== null && range(total).every((page) => report.checkedPages.includes(page));
    if (!report.complete) report.issues.push(`版面检查未完整覆盖：总 ${total} 页，已检 ${report.checkedPages.join("、")} 页`);
    summarize();
    report.issues = [...new Set(report.issues)];
    report.suggestions = [...new Set(report.suggestions)];
    return report;
  } catch (e) {
    if (isJobControlError(e) || budgetError(e)) throw e;
    if (e && typeof e === "object" && "page" in e && typeof e.page === "number") report.failedPages.push(e.page);
    report.failedPages = [...new Set(report.failedPages)].sort((a, b) => a - b);
    const message = e instanceof Error ? e.message : String(e);
    report.issues.push(message);
    summarize();
    throw Object.assign(Error(`版面检查失败：${message}（总页数 ${report.totalPages ?? "未知"}；已检页 ${report.checkedPages.join("、") || "无"}；失败页 ${report.failedPages.join("、") || "未定位"}）`), { report });
  } finally {
    await rendered?.dispose();
    if (dir) {
      // 清理失败不会覆盖真正的审查错误；原始文档从不删除。
      if (!isDocLike) await exec(officecli(), ["close", file], { timeout: 30_000, windowsHide: true }).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
/** 防止损坏文档无限探测；达到上限必须显式失败。 */
const maxPages = 500;
