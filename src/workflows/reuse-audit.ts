import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { load } from "cheerio";
import JSZip from "jszip";
import type { AppConfig } from "../core/config.js";
import type { Store } from "../core/store.js";
import { readSource } from "../competition/sources.js";
import { readXlsx, xlsxText } from "../artifacts/xlsx.js";
import { atomicWriteJson } from "./task-receipts.js";
import { assessTextReuse, textReuseNotApplicable, type TextReuseReference, type TextReuseReport } from "./originality.js";

export type { TextReuseReport } from "./originality.js";

export type ReuseAuditInput = {
  cfg: AppConfig; store: Store; jobId: string; taskId: string; round: number;
  kind: string; format: string; officialTemplate?: string | null; paths: string[];
  evidence: { url: string; title: string; text: string; kind: string }[];
  requiredTexts?: string[];
};
export type ReuseAuditRecord = {
  taskId: string; round: number; paths: string[]; checkedAt: string;
  artifactHashes: { path: string; sha256: string }[];
  report: TextReuseReport;
};

async function contained(root: string, path: string): Promise<string> {
  const [base, actual] = await Promise.all([realpath(root), realpath(path)]);
  const local = relative(base, actual);
  if (!local || local.startsWith("..") || isAbsolute(local))
    throw Error("复用检查拒绝任务目录外的文件");
  const info = await stat(actual);
  if (!info.isFile() || info.size > 15_000_000)
    throw Error("复用检查文件不是普通文件或超过15MB");
  return actual;
}

async function artifactText(path: string): Promise<string | null> {
  const ext = extname(path).toLowerCase();
  if ([".txt", ".md", ".docx", ".pdf"].includes(ext)) return readSource(path);
  if (ext === ".xlsx") return xlsxText(await readXlsx(await readFile(path)));
  if (ext !== ".pptx") return null;
  const zip = await JSZip.loadAsync(await readFile(path));
  const entries = Object.values(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (entries.length > 500) throw Error("复用检查超过500页限制");
  let bytes = 0;
  const texts: string[] = [];
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (size === undefined || size > 2_000_000 || (bytes += size) > 15_000_000)
      throw Error("幻灯片文本超过复用检查读取限制");
    const $ = load(await entry.async("string"), { xmlMode: true });
    texts.push($("a\\:t").toArray().map((el) => $(el).text()).join("\n"));
  }
  return texts.join("\n\n");
}

/** 读取当前真实交付文本及有限本地历史，不联网，不将低复用等同原创。 */
export async function auditTextReuse(input: ReuseAuditInput): Promise<TextReuseReport> {
  const { cfg, store, jobId, taskId, round } = input;
  const folder = join(cfg.dataDir, "jobs", jobId);
  let report: TextReuseReport;
  const artifactHashes: ReuseAuditRecord["artifactHashes"] = [];
  if (input.kind === "translation") report = textReuseNotApplicable("translation");
  else if (input.officialTemplate) report = textReuseNotApplicable("official_template");
  else {
    const limitations: string[] = [];
    const parts: string[] = [];
    let complete = true;
    for (const path of input.paths) {
      const actual = await contained(folder, path);
      artifactHashes.push({ path, sha256: createHash("sha256").update(await readFile(actual)).digest("hex") });
      const text = await artifactText(actual);
      if (text === null) { complete = false; limitations.push(`格式 ${extname(path)} 未执行正文复用检查；代码、画面与动态行为不在文本匹配范围`); }
      else parts.push(text);
    }
    const references: TextReuseReference[] = [];
    const seen = new Set<string>();
    let characters = 0;
    const add = (ref: TextReuseReference) => {
      if (!ref.text.trim()) return;
      const digest = createHash("sha256").update(ref.text).digest("hex");
      if (seen.has(digest)) return;
      if (references.length >= 40 || characters + ref.text.length > 800_000) {
        complete = false; limitations.push("参考语料超过40份或80万字符限制，未比较全部语料"); return;
      }
      seen.add(digest); characters += ref.text.length; references.push(ref);
    };
    // 同一页面会在资格审核、研究等阶段多次入库，id 以 URL 为准：只保留正文最长的一条，
    // 否则 assessTextReuse 会因参考 id 重复而中止整个任务。
    const sourceEvidence = new Map<string, { url: string; title: string; text: string }>();
    for (const e of input.evidence) {
      const prev = sourceEvidence.get(e.url);
      if (!prev || e.text.length > prev.text.length) sourceEvidence.set(e.url, e);
    }
    for (const e of sourceEvidence.values()) add({ id: `source:${e.url}`, title: e.title, text: e.text, kind: "source" });
    const history = store.recentSubmissionArtifacts(jobId, 21);
    if (history.length > 20) { complete = false; limitations.push("本地历史仅比较最近20个交付文件，较早文件未扫描"); }
    for (const previous of history.slice(0, 20)) {
      if (![".txt", ".md", ".docx", ".pdf", ".pptx", ".xlsx"].includes(extname(previous.path).toLowerCase())) continue;
      try {
        const actual = await contained(join(cfg.dataDir, "jobs", previous.jobId), previous.path);
        const text = await artifactText(actual);
        if (text !== null) add({ id: `history:${previous.jobId}:${relative(join(cfg.dataDir, "jobs", previous.jobId), actual)}`, title: previous.title, text, kind: "history" });
      } catch { complete = false; limitations.push(`历史任务 ${previous.jobId} 的交付文件不可读取，未纳入比较`); }
    }
    report = assessTextReuse(parts.join("\n\n"), references, { exemptTexts: input.requiredTexts });
    report.limitations = [...new Set([...report.limitations, ...limitations, "只比较本任务已获取的来源和有限本地历史；没有覆盖全网，也不判断改写、概念或算法层面的抄袭"])];
    if (!complete) {
      report.complete = false;
      if (report.status === "clear") report.status = "unverified";
      report.reason += "；存在未覆盖内容，不能据此断言不存在复用";
    }
  }
  const entry: ReuseAuditRecord = { taskId, round, paths: input.paths, checkedAt: new Date().toISOString(), artifactHashes, report };
  const indexPath = join(folder, "text-reuse.json");
  let entries: ReuseAuditRecord[] = [];
  try {
    const saved: unknown = JSON.parse(await readFile(indexPath, "utf8"));
    if (!Array.isArray(saved)) throw Error("复用检查历史结构损坏");
    entries = saved as ReuseAuditRecord[];
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const identity = JSON.stringify(artifactHashes);
  entries = entries.filter((x) => !(x.taskId === taskId && x.round === round && JSON.stringify(x.artifactHashes) === identity));
  await atomicWriteJson(indexPath, [...entries, entry]);
  return report;
}
