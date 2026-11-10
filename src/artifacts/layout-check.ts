/**
 * 版面审查：用 officecli 把 docx/pptx 渲染成真实页面，交给排版 Agent 看图，
 * 只找肉眼可见的版面缺陷。失败一律抛错——不能渲染就不能声称版式合格。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { load } from "cheerio";
import { z } from "zod";
import type { ModelGateway } from "../core/types.js";
import { parseJSON } from "../core/gateway.js";
import { isJobControlError } from "../core/job-control.js";
import { budgetError } from "../workflows/shared.js";

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
  textCoverage: "unverified" | "not_applicable";
  textCoverageDetails: string;
  auxiliaryText?: { status: "matched" | "mismatch"; details: string };
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
      ...(extname(file).toLowerCase() === ".docx" ? ["--render", "native"] : [])], {
      timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000,
    });
  } catch (e) {
    if (pageOutOfRange(e, page)) return false;
    throw Error(`渲染 ${file} 第 ${page} 页失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!(await readFile(out)).length) throw Error(`渲染 ${file} 第 ${page} 页生成空图片`);
  return true;
}

const docxRubric = `任务：排版审查。现在看到的是 Word 文档渲染后的真实页面（长文档会分页，看到的是其中一页）。只指出肉眼可见、会影响阅读的版面缺陷：Markdown 表格符号（竖线、横线）被当成普通文字显示而没有变成表格；单独成行的分隔线或代码围栏符号；星号、井号等未转换的 Markdown 标记；标题层级在字号和缩进上明显不连贯；文字溢出页面边界、元素互相重叠或在页面中间被裁掉；图片缺失、位置错乱或没有图题；同类元素样式明显不统一。

不要仅根据“这一页最后一行是不是半句话”判断内容被截断：分页可以断在句子中间。需检查实际可见的文字被裁切、重叠、异常空页和最后一页明显丢件；不能据此声称已逐字核对全文。程序另有辅助文本检查，但不同渲染后端的文本不证明截图完整。

不评价内容质量，不因措辞、标点或个人偏好提意见。每条写清楚现象和改法，最多 5 条，没有缺陷时 issues 为空数组。只输出 JSON {"issues":["阻塞版面缺陷"],"suggestions":["可选改进"]}。`;
const pptxRubric = `任务：幻灯片版面审查。现在看到的是 PPT 渲染后的真实一页。只指出肉眼可见、会影响观感的版面缺陷：文字溢出页面或文本框、文字互相重叠、文字与图片重叠遮挡；元素明显越界或被裁掉；同一页字号、颜色、对齐混乱；标题缺失或每页位置不一致；图片拉伸变形、模糊或占位失败；整页几乎空白或文字小到看不清。不评价内容观点和措辞。每条写清楚现象和改法，最多 5 条，没有缺陷时 issues 为空数组。只输出 JSON {"issues":["阻塞版面缺陷"],"suggestions":["可选改进"]}。`;

/** Word 显式重分页，与原生截图使用同一后端；PPT 由 stats 提供真实页数。 */
async function pageCount(file: string): Promise<number | null> {
  const { stdout } = await exec(officecli(), ["view", file, "stats",
    ...(extname(file).toLowerCase() === ".docx" ? ["--page-count"] : [])], {
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
): Promise<LayoutReport> {
  const report: LayoutReport = {
    issues: [], suggestions: [], checked: 0, totalPages: null,
    checkedPages: [], failedPages: [], complete: false,
    textCoverage: extname(file).toLowerCase() === ".docx" ? "unverified" : "not_applicable",
    textCoverageDetails: extname(file).toLowerCase() === ".docx"
      ? "原生截图逐页视觉检查；未从这些截图逐字提取全文，HTML文字比对仅为辅助证据"
      : "幻灯片由逐页视觉检查核验，不做Word全文比对",
  };
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
    await requireOffice();
    const sharp = (await import("sharp")).default;
    dir = await mkdtemp(join(tmpdir(), "layout-"));
    const reported = await pageCount(file);
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
        const exists = await shot(file, page, out);
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
        const rubric = extname(file).toLowerCase() === ".pptx" ? pptxRubric : docxRubric;
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
    // HTML 与原生截图不是同一个后端，只记录整篇辅助比对，不能拿它证明原生截图逐字完整。
    if (extname(file).toLowerCase() === ".docx") {
      const loss = await renderedTextGap(file);
      report.auxiliaryText = {
        status: loss ? "mismatch" : "matched",
        details: loss || "整篇HTML包含原文核验片段；此结果仅为辅助，不证明原生截图逐字完整",
      };
      if (loss) report.suggestions.push(`辅助HTML文本比对差异：${loss}；需结合原生页面复核，不据此判定原生截图缺字`);
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
    if (dir) {
      // 清理失败不会覆盖真正的审查错误；原始文档从不删除。
      await exec(officecli(), ["close", file], { timeout: 30_000, windowsHide: true }).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
/** 防止损坏文档无限探测；达到上限必须显式失败。 */
const maxPages = 500;

/** 读取整篇辅助HTML。静态源含脚本，必须去掉非正文节点，不能按原生页数截取。 */
async function renderedText(file: string): Promise<string> {
  try {
    const { stdout } = await exec(
      officecli(),
      ["view", file, "html"],
      { timeout: 60_000, windowsHide: true, maxBuffer: 16_000_000 },
    );
    if (!/<(?:html|body|div|p|span|table)\b/i.test(stdout)) throw Error("渲染器未返回页面 HTML");
    const $ = load(stdout);
    $("script,style,noscript,template").remove();
    return $("body").text().replace(/\s+/g, "");
  } catch (e) {
    throw Error(`全文辅助渲染检查失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 整篇HTML辅助对比原文；不同后端的差异只报告，不能证明原生截图丢字或完整。 */
async function renderedTextGap(file: string): Promise<string | null> {
  const { readSource } = await import("../competition/sources.js");
  const full = (await readSource(file)).replace(/\s+/g, "");
  const rendered = await renderedText(file);
  if (full && !rendered) throw Error("全文渲染检查未提取到任何可见文字");
  if (!full || rendered.includes(full)) return null;
  if (full.length < 200) return "渲染出的页面没有包含完整正文，需要调整段落或分页设置后重新导出";
  // 末尾 24 字是判断“是否丢了结尾”的最短可靠依据。
  const tail = full.slice(-24);
  if (rendered.includes(tail)) return null;
  // 结尾找不到时再确认中后段是否也缺失，避免只因为空格/字符差异误判。
  const probe = full.slice(Math.floor(full.length * 0.8), Math.floor(full.length * 0.8) + 24);
  if (probe && !rendered.includes(probe))
    return `渲染出的页面没有包含文档后段内容（文档共 ${full.length} 字，渲染约 ${rendered.length} 字）：分页时丢失了末尾内容，需要调整段落或分页设置后重新导出`;
  return `渲染出的最后一页缺少文档结尾（“${tail}”）：分页时把结尾挤出了页面，需要调整段落或分页设置后重新导出`;
}
