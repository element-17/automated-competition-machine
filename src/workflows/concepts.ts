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
  query: string;
  queries: { query: string; fingerprint: string; searchStatus: "available" | "empty" | "failed" | "unavailable" }[];
  searchStatus: "available" | "empty" | "failed" | "unavailable";
  sources: { url: string; requestedUrl: string; title: string; excerpt: string; fetchedAt: string }[];
  failures: { url: string; error: string }[];
  gaps: string[];
};
const Source = z.object({
  url: z.string(), requestedUrl: z.string(), title: z.string(), excerpt: z.string().min(1), fetchedAt: z.string(),
});
const Results = z.array(z.object({ url: z.string(), title: z.string(), snippet: z.string().default("") }));

/** 问题/人群与工作机制是主要线索，自造标题仅作为补充。 */
export function candidateQueries(idea: Idea): string[] {
  const terms = (value: string) => value.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);
  return [...new Set([
    `${terms(idea.problem)} ${terms(idea.audience)} 现有方案 作品`,
    `${terms(idea.mechanism)} 替代方案 现有方法`,
    `${terms(idea.title)} 竞赛 获奖作品`,
  ])];
}

/** 只把实际正文作为比较资料；缓存成功查询与 URL，失败不转化成原创证据。 */
export async function collectCandidateEvidence(
  cfg: AppConfig, store: Store, gateway: ModelGateway, jobId: string,
  competitionId: string, ideas: Idea[], previousEvidence: CandidateEvidence[] = [],
): Promise<CandidateEvidence[]> {
  const fetched = new Map<string, Promise<CandidateEvidence["sources"][number]>>();
  const searched = new Map<string, Promise<{ results: SearchResult[]; searchStatus: CandidateEvidence["searchStatus"] }>>();
  const search = (query: string) => {
    const fingerprint = conceptFingerprint(query);
    if (!searched.has(fingerprint)) searched.set(fingerprint, (async () => {
      const previous = (store.searches(competitionId) as { query: string; results: string; error: string | null }[])
        .filter((s) => s.query === query && !s.error).at(-1);
      if (previous) {
        const parsed = (() => { try { return Results.safeParse(JSON.parse(previous.results)); } catch { return null; } })();
        if (parsed?.success) return { results: parsed.data, searchStatus: parsed.data.length ? "available" as const : "empty" as const };
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
    if (previous) return previous;
    const queries: CandidateEvidence["queries"] = [];
    const buckets: SearchResult[][] = [];
    for (const query of candidateQueries(idea)) {
      const { results, searchStatus } = await search(query);
      queries.push({ query, fingerprint: conceptFingerprint(query), searchStatus });
      buckets.push(results);
    }
    // 轮转三个查询的排名，防止第一条结果挤掉其他机制线索。每候选最多尝试四个正文。
    const results = new Map<string, SearchResult>();
    for (let rank = 0; rank < Math.max(0, ...buckets.map((b) => b.length)) && results.size < 4; rank++) {
      for (const bucket of buckets) {
        const result = bucket[rank];
        if (!result || results.size >= 4) continue;
        try { const url = new URL(result.url); url.hash = ""; results.set(url.href, { ...result, url: url.href }); } catch { /* 非 URL 不可作为正文来源。 */ }
      }
    }
    const sources: CandidateEvidence["sources"] = [], failures: CandidateEvidence["failures"] = [];
    for (const result of results.values()) {
      if (!fetched.has(result.url)) fetched.set(result.url, cached(
        cfg, store, jobId, `concept-source-${conceptFingerprint(result.url)}.json`, Source, null,
        async () => {
          const existing = store.evidence(competitionId).find((e) => e.url === result.url && e.text.trim());
          const source = existing || await saveSource(store, competitionId, result.url, "novelty", result.title);
          return { url: source.url, requestedUrl: result.url, title: source.title, excerpt: source.text.slice(0, 6000).trim(), fetchedAt: source.fetchedAt };
        },
      ));
      try {
        const source = await fetched.get(result.url)!;
        if (!sources.some((s) => s.url === source.url)) sources.push(source);
      } catch (e) {
        if (isJobControlError(e) || budgetError(e)) throw e;
        failures.push({ url: result.url, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const searchStatus: CandidateEvidence["searchStatus"] = queries.some((q) => q.searchStatus === "available") ? "available"
      : queries.some((q) => q.searchStatus === "failed") ? "failed"
      : queries.every((q) => q.searchStatus === "unavailable") ? "unavailable" : "empty";
    const gaps = queries.filter((q) => q.searchStatus !== "available").map((q) =>
      `候选 ${index + 1}「${idea.title}」查询「${q.query}」${q.searchStatus === "failed" ? "失败" : q.searchStatus === "unavailable" ? "不可用" : "无结果"}，原创性尚未核实`);
    if (!sources.length) gaps.push(`候选 ${index + 1}「${idea.title}」没有可读取正文，原创性尚未核实`);
    if (failures.length) gaps.push(`候选 ${index + 1} 有 ${failures.length} 个相似作品来源无法读取`);
    return { candidate: index + 1, title: idea.title, fingerprint, query: queries[0]!.query, queries, searchStatus, sources, failures, gaps };
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
  brief: Brief, ideas: Idea[], evidence: CandidateEvidence[], pairs: unknown[],
): Promise<{ choice: Choice; gaps: string[] }> {
  if (!ideas.length) throw Error("没有生成候选方案，不能进行选题或继续制作");
  try {
    const fingerprint = conceptFingerprint({ version: 1, brief, ideas, evidence });
    const review = await cached(cfg, store, jobId, `concept-comparison-${fingerprint}.json`, ConceptReview, modelLabel(cfg, "reviewer"), async () => {
      const parsed = ConceptReview.parse(parseJSON(await gateway.generate(
        "reviewer",
        `${Guard}\n任务：候选比较。按规则适配、可行性、机制差异和可验证性评估每个候选。selected 必须在 1 到 ${ideas.length} 之间，存在重复或证据不足时必须为 null。${REVIEW_FORMAT}\n规则：${JSON.stringify(brief)}\n候选：${JSON.stringify(ideas)}\n已获取的相似作品资料：${JSON.stringify(evidence)}\n词面相似度提示（不能代替机制比较）：${JSON.stringify(pairs)}`,
        "reviewer",
      )));
      validateConceptReview(parsed, ideas, evidence);
      return parsed;
    });
    const rewrites = validateConceptReview(review, ideas, evidence);
    await record(cfg, store, jobId, "concept-review.json", { ...review, ...(rewrites.length ? { selected: null, strategy: null, rewrites } : {}), fingerprint, evidencePath: "candidate-evidence.json" }, modelLabel(cfg, "reviewer"));
    if (rewrites.length) throw new DuplicateCandidatesError(rewrites);
    const choice: Choice = { selected: review.selected!, analysis: review.analysis, similarity_risks: review.similarity_risks, strategy: review.strategy! };
    const selectedSources = review.sourceComparisons.find((c) => c.candidate === choice.selected)!;
    choice.strategy!.evidenceLimits = [...new Set([...choice.strategy!.evidenceLimits, ...selectedSources.limitations, ...evidence.find((e) => e.candidate === choice.selected)!.gaps])];
    const gaps = [...evidence.flatMap((e) => e.gaps), ...choice.similarity_risks.map((r) => `选题风险：${r}`)];
    return { choice, gaps: [...new Set(gaps)] };
  } catch (e) {
    if (isJobControlError(e) || budgetError(e) || e instanceof DuplicateCandidatesError) throw e;
    throw Error(`候选方案比较失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
