import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isJobControlError } from "../core/job-control.js";
import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import type { Store } from "../core/store.js";
import type { Brief, ModelGateway, SearchResult } from "../core/types.js";
import { parseJSON } from "../core/gateway.js";
import { saveSource } from "../competition/sources.js";
import { modelLabel } from "../agents/models.js";
import { Guard, budgetError, cached, record, type Idea } from "./shared.js";
import {
  conceptFingerprint, ConceptReview, DuplicateCandidatesError,
  REVIEW_FORMAT, validateConceptReview, type Choice,
} from "./concept-quality.js";
export type { Choice } from "./concept-quality.js";

export type CandidateEvidence = {
  candidate: number;
  title: string;
  fingerprint: string;
  collectedAt?: string;
  /** 首个查询词；没有可检索关键词时为空，表示跳过检索并如实记录。 */
  query?: string;
  queries: { query: string; fingerprint: string; searchStatus: "available" | "empty" | "failed" | "unavailable" }[];
  searchStatus: "available" | "empty" | "failed" | "unavailable";
  sources: { url: string; requestedUrl: string; title: string; excerpt: string; fetchedAt: string;
    ranges?: { start: number; end: number }[]; originalLength?: number; truncated?: boolean }[];
  failures: { url: string; error: string }[];
  gaps: string[];
};
const Source = z.object({ url: z.string(), requestedUrl: z.string(), title: z.string(), text: z.string().min(1).refine((value) => !!value.trim()), fetchedAt: z.string() });
const Results = z.array(z.object({ url: z.string(), title: z.string(), snippet: z.string().default("") }));
const WEEK = 7 * 24 * 60 * 60 * 1000;
const EMPTY_TTL = 6 * 60 * 60 * 1000;
const fresh = (date: string | undefined, ttl: number) => {
  const age = Date.now() - Date.parse(date || "");
  return age >= 0 && age < ttl;
};

/**
 * 泛化词不能当检索词：它们单独出现时搜索引擎只会返回百科词条，
 * 抓取既浪费调用又必然 403（如“市”“装置”“传统”“借鉴”）。
 */
const genericTerms = new Set([
  "现有", "方案", "方法", "作品", "传统", "装置", "系统", "技术", "设计", "研究",
  "问题", "需求", "用户", "场景", "机制", "模式", "结构", "功能", "实现", "应用",
  "分析", "优化", "提高", "降低", "支持", "基于", "通过", "以及", "并且", "同时",
  "可以", "需要", "进行", "具有", "采用", "使用", "相关", "整体", "部分", "过程",
  "结果", "效果", "目标", "内容", "阶段", "情况", "条件", "基础", "核心", "关键",
  "借鉴", "参考", "改进", "创新", "优势", "不足", "常见", "一般", "通常", "主要",
]);

/**
 * 中文虚词是天然的短语边界；按它们切分比定长切块更接近真实的检索关键词，
 * 不会产生“的申请占”“用窗口时”这类碎片。
 */
const phraseBreaks = /[的地得在和与及用把被对从向给为以而或等中上下里时后前，,。.；;：:、()（）【】\[\]"'“”!？?\s]+/;

/** 从一段描述里挑出有检索价值的关键词；泛词和过短片段一律丢弃。 */
function queryTerms(value: string, limit: number): string[] {
  const out: string[] = [];
  for (const piece of value.normalize("NFKC").split(phraseBreaks)) {
    const text = piece.trim();
    if (text.length < 2) continue;
    // 英文技术名词原样保留；中文超过 8 字仍按定长兜底切分。
    if (/[A-Za-z]/.test(text))
      for (const word of text.split(/[^A-Za-z0-9+#-]+/))
        if (word.length >= 2 && !genericTerms.has(word.toLowerCase())) out.push(word);
    for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
      if (genericTerms.has(run) || run.length < 2) continue;
      if (run.length <= 8) { out.push(run); continue; }
      for (let i = 0; i + 4 <= run.length; i += 4) {
        const chunk = run.slice(i, i + 4);
        if (!genericTerms.has(chunk)) out.push(chunk);
      }
    }
  }
  return [...new Set(out)].slice(0, limit);
}

/** 优先问题和机制，不为自造标题额外搜索；至少两个有效词才发查询，否则跳过检索。 */
export function candidateQueries(idea: Idea): string[] {
  const problem = queryTerms(`${idea.problem} ${idea.audience}`, 6);
  const mechanism = queryTerms(idea.mechanism, 6);
  const queries: string[] = [];
  if (problem.length >= 2) queries.push(`${problem.join(" ")} 现有方案`);
  if (mechanism.length >= 2) queries.push(`${mechanism.join(" ")} 替代方案`);
  return [...new Set(queries)];
}

/** 从整篇正文选取与机制/约束相关的段落；区间使用原文 UTF-16 索引 [start,end)。 */
export function relevantExcerpt(text: string, idea: Idea) {
  const terms = new Set<string>();
  for (const word of `${idea.mechanism} ${idea.problem} ${idea.audience}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (/[\p{Script=Han}]/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
    } else if (word.length > 2) terms.add(word);
  }
  const chunks: { start: number; end: number; score: number }[] = [];
  for (const paragraph of text.matchAll(/[^\n]+/g)) {
    for (let offset = 0; offset < paragraph[0].length; offset += 1000) {
      const start = paragraph.index! + offset, end = Math.min(start + 1200, paragraph.index! + paragraph[0].length);
      const part = text.slice(start, end).toLowerCase();
      chunks.push({ start, end, score: [...terms].filter((term) => part.includes(term)).length });
    }
  }
  const selected = chunks.sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 4).sort((a, b) => a.start - b.start);
  const ranges: { start: number; end: number }[] = [];
  for (const { start, end } of selected) {
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return {
    excerpt: ranges.map((r) => text.slice(r.start, r.end)).join("\n[…]\n"),
    ranges, originalLength: text.length,
    truncated: ranges.reduce((n, r) => n + r.end - r.start, 0) < text.length,
  };
}

const QueryWords = z.object({ keywords: z.array(z.string().trim().min(2).max(20)).min(2).max(8) });

/**
 * 让模型把方案压成真正的检索关键词：规则切分无法可靠识别中文词边界，
 * 而且相似作品检索只需要少数几个能命中的名词短语。失败时返回 null 交给规则兜底。
 */
async function modelQueryKeywords(
  gateway: ModelGateway, idea: Idea,
): Promise<string[] | null> {
  try {
    const raw = await gateway.generate(
      "reviewer",
      `从下面的作品方案中抽取用于检索“已有类似作品/现有方案”的检索关键词。只输出 JSON {"keywords":["关键词",...]}。要求：3-6 个，每个 2-12 字，必须是具体的对象、机构、技术、材料或方法名词（如“养老机构”“机械旋钮”“路径规划”）；不要输出“方案”“系统”“传统”“装置”“问题”“用户”这类泛词，不要输出整句，不要编号。
方案：${JSON.stringify({ title: idea.title, audience: idea.audience, problem: idea.problem, mechanism: idea.mechanism })}`,
      "reviewer",
    );
    const words = QueryWords.parse(parseJSON(raw)).keywords
      .map((x) => x.trim())
      .filter((x) => x.length >= 2 && !genericTerms.has(x));
    return words.length >= 2 ? words : null;
  } catch (e) {
    if (isJobControlError(e) || budgetError(e)) throw e;
    return null;
  }
}

/** 查询和正文继续复用；旧空结果六小时后重查，成功结果及正文保留七天。 */
export async function collectCandidateEvidence(
  cfg: AppConfig, store: Store, gateway: ModelGateway, jobId: string,
  competitionId: string, ideas: Idea[], previousEvidence: CandidateEvidence[] = [],
): Promise<CandidateEvidence[]> {
  const fetched = new Map<string, Promise<z.infer<typeof Source>>>();
  const searched = new Map<string, Promise<{ results: SearchResult[]; searchStatus: CandidateEvidence["searchStatus"] }>>();
  const search = (query: string) => {
    const fingerprint = conceptFingerprint(query);
    if (!searched.has(fingerprint)) searched.set(fingerprint, (async () => {
      const previous = (store.searches(competitionId) as { query: string; results: string; searched_at: string; error: string | null }[])
        .filter((s) => s.query === query && !s.error).at(-1);
      if (previous) {
        const parsed = (() => { try { return Results.safeParse(JSON.parse(previous.results)); } catch { return null; } })();
        if (parsed?.success && fresh(previous.searched_at, parsed.data.length ? WEEK : EMPTY_TTL))
          return { results: parsed.data, searchStatus: parsed.data.length ? "available" as const : "empty" as const };
      }
      if (gateway.canSearch === false) {
        store.search(competitionId, query, [], "来源列表模式未配置全网关键词搜索");
        return { results: [], searchStatus: "unavailable" as const };
      }
      try {
        const results = Results.parse(await gateway.search(query));
        store.search(competitionId, query, results);
        return { results, searchStatus: results.length ? "available" as const : "empty" as const };
      } catch (e) {
        if (isJobControlError(e) || budgetError(e)) throw e;
        store.search(competitionId, query, [], e instanceof Error ? e.message : String(e));
        return { results: [], searchStatus: "failed" as const };
      }
    })());
    return searched.get(fingerprint)!;
  };
  const branches = await Promise.allSettled(ideas.map(async (idea, index) => {
    const fingerprint = conceptFingerprint(idea);
    const previous = previousEvidence.find((e) => e.fingerprint === fingerprint && e.candidate === index + 1);
    if (previous && !previous.failures.length && previous.queries.every((q) => q.searchStatus !== "failed") &&
        fresh(previous.collectedAt, previous.queries.every((q) => q.searchStatus === "available") ? WEEK : EMPTY_TTL) &&
        previous.sources.every((s) => fresh(s.fetchedAt, WEEK))) return previous;
    const queries: CandidateEvidence["queries"] = [];
    const buckets: SearchResult[][] = [];
    // 优先用模型抽取的关键词；抽不出时退回规则切分（至少两个有效词才检索）。
    const keywords = await modelQueryKeywords(gateway, idea);
    const plannedQueries = keywords
      ? [`${keywords.join(" ")} 现有方案 类似作品`, `${keywords.slice(0, 4).join(" ")} 替代方案`]
      : candidateQueries(idea);
    for (const query of plannedQueries) {
      const { results, searchStatus } = await search(query);
      queries.push({ query, fingerprint: conceptFingerprint(query), searchStatus });
      buckets.push(results);
    }
    const results = new Map<string, SearchResult>();
    for (let rank = 0; rank < Math.max(0, ...buckets.map((b) => b.length)) && results.size < 3; rank++) {
      for (const bucket of buckets) {
        const result = bucket[rank];
        if (!result || results.size >= 3) continue;
        try { const url = new URL(result.url); url.hash = ""; results.set(url.href, { ...result, url: url.href }); } catch { /* 无效 URL 不作为来源。 */ }
      }
    }
    const sources: CandidateEvidence["sources"] = [], failures: CandidateEvidence["failures"] = [];
    for (const result of results.values()) {
      if (!fetched.has(result.url)) fetched.set(result.url, (async () => {
        const name = `concept-source-v2-${conceptFingerprint(result.url)}.json`;
        try {
          const source = Source.parse(JSON.parse(await readFile(join(cfg.dataDir, "jobs", jobId, name), "utf8")));
          if (fresh(source.fetchedAt, WEEK)) return source;
        } catch (e) {
          if (!(e instanceof z.ZodError) && !(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const existing = store.evidence(competitionId).find((e) => e.url === result.url && e.text.trim() && fresh(e.fetchedAt, WEEK));
        const source = existing || await saveSource(store, competitionId, result.url, "novelty", result.title);
        const raw = Source.parse({ ...source, requestedUrl: result.url });
        await record(cfg, store, jobId, name, raw, null);
        return raw;
      })());
      try {
        const source = await fetched.get(result.url)!;
        if (!sources.some((s) => s.url === source.url)) {
          const { text, ...metadata } = source;
          sources.push({ ...metadata, ...relevantExcerpt(text, idea) });
        }
      } catch (e) {
        if (isJobControlError(e) || budgetError(e)) throw e;
        failures.push({ url: result.url, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const searchStatus: CandidateEvidence["searchStatus"] = queries.some((q) => q.searchStatus === "available") ? "available"
      : queries.some((q) => q.searchStatus === "failed") ? "failed"
      : queries.every((q) => q.searchStatus === "unavailable") ? "unavailable" : "empty";
    const gaps = [];
    if (!sources.length) gaps.push(`候选 ${index + 1}「${idea.title}」没有可读取正文，相似作品比较范围有限`);
    if (failures.length) gaps.push(`候选 ${index + 1} 有 ${failures.length} 个相似作品来源无法读取`);
    return { candidate: index + 1, title: idea.title, fingerprint, collectedAt: new Date().toISOString(), query: queries[0]?.query, queries, searchStatus, sources, failures, gaps };
  }));
  const failure = branches.find((b): b is PromiseRejectedResult => b.status === "rejected" && (isJobControlError(b.reason) || budgetError(b.reason)))
    || branches.find((b): b is PromiseRejectedResult => b.status === "rejected");
  if (failure) throw failure.reason;
  const report = branches.map((b) => (b as PromiseFulfilledResult<CandidateEvidence>).value);
  await record(cfg, store, jobId, "candidate-evidence.json", report, null);
  return report;
}

export async function compareCandidates(
  cfg: AppConfig, store: Store, gateway: ModelGateway, jobId: string,
  brief: Brief, ideas: Idea[], evidence: CandidateEvidence[], _pairs: unknown[] = [],
): Promise<{ choice: Choice; gaps: string[] }> {
  if (!ideas.length) throw Error("没有生成候选方案，不能进行选题或继续制作");
  try {
    // 抓取/汇总时间变化不使相同正文的比较失效。
    const comparisonEvidence = evidence.map(({ collectedAt: _collectedAt, sources, ...e }) => ({
      ...e, sources: sources.map(({ fetchedAt: _fetchedAt, ...source }) => source),
    }));
    const fingerprint = conceptFingerprint({ version: 2, brief, ideas, evidence: comparisonEvidence });
    const review = await cached(cfg, store, jobId, `concept-comparison-${fingerprint}.json`, ConceptReview, modelLabel(cfg, "reviewer"), async () => {
      const parsed = ConceptReview.parse(parseJSON(await gateway.generate(
        "reviewer",
        `${Guard}\n任务：候选比较。选出最值得进入创作的方案，考虑规则适配、可行性和表达价值；selected 必须在 1 到 ${ideas.length} 之间。${REVIEW_FORMAT}\n规则：${JSON.stringify(brief)}\n候选：${JSON.stringify(ideas)}\n已获取的相似作品资料：${JSON.stringify(comparisonEvidence)}`,
        "reviewer",
      )));
      validateConceptReview(parsed, ideas, evidence);
      return parsed;
    });
    const rewrites = validateConceptReview(review, ideas, evidence);
    await record(cfg, store, jobId, "concept-review.json", { ...review, ...(rewrites.length ? { rewrites } : {}), fingerprint, evidencePath: "candidate-evidence.json" }, modelLabel(cfg, "reviewer"));
    if (rewrites.length) throw new DuplicateCandidatesError(rewrites);
    const choice: Choice = { selected: review.selected, analysis: review.analysis, similarity_risks: review.similarity_risks,
      ...(review.strategy ? { strategy: review.strategy } : {}) };
    const gaps = [...(evidence.find((e) => e.candidate === choice.selected)?.gaps || []), ...choice.similarity_risks.map((r) => `选题风险：${r}`)];
    return { choice, gaps: [...new Set(gaps)] };
  } catch (e) {
    if (isJobControlError(e) || budgetError(e) || e instanceof DuplicateCandidatesError) throw e;
    throw Error(`候选方案比较失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
