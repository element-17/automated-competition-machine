import { isJobControlError } from "../core/job-control.js";
import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import type { Store } from "../core/store.js";
import type { Brief, ModelGateway, SearchResult } from "../core/types.js";
import { parseJSON } from "../core/gateway.js";
import { searchLogged, saveSource } from "../competition/sources.js";
import { modelLabel } from "../agents/models.js";
import { Guard, budgetError, record, type Idea } from "./shared.js";

export type CandidateEvidence = {
  candidate: number;
  title: string;
  query: string;
  searchStatus: "available" | "empty" | "failed" | "unavailable";
  sources: {
    url: string;
    requestedUrl: string;
    title: string;
    excerpt: string;
    fetchedAt: string;
  }[];
  failures: { url: string; error: string }[];
  gaps: string[];
};
export type Choice = {
  selected: number;
  analysis: string;
  similarity_risks: string[];
};

/** 只把重新获取的正文作为比较资料；无结果和访问失败均不能证明原创。 */
export async function collectCandidateEvidence(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
  jobId: string,
  competitionId: string,
  ideas: Idea[],
): Promise<CandidateEvidence[]> {
  const fetched = new Map<
    string,
    Promise<CandidateEvidence["sources"][number]>
  >();
  const report = await Promise.all(
    ideas.map(async (idea, index) => {
      const query = `${idea.title} ${idea.problem} 竞赛 获奖作品`;
      const previous = (
        store.searches(competitionId) as {
          query: string;
          results: string;
          error: string | null;
        }[]
      )
        .filter((s) => s.query === query)
        .at(-1);
      let results: SearchResult[] = [];
      if (gateway.canSearch !== false && previous && !previous.error) {
        try {
          results = z
            .array(
              z.object({
                url: z.string(),
                title: z.string(),
                snippet: z.string().default(""),
              }),
            )
            .parse(JSON.parse(previous.results));
        } catch {
          results = await searchLogged(store, gateway, competitionId, query);
        }
      } else results = await searchLogged(store, gateway, competitionId, query);
      const latest = (
        store.searches(competitionId) as {
          query: string;
          error: string | null;
        }[]
      )
        .filter((s) => s.query === query)
        .at(-1);
      const searchStatus: CandidateEvidence["searchStatus"] =
        gateway.canSearch === false
          ? "unavailable"
          : latest?.error
            ? "failed"
            : results.length
              ? "available"
              : "empty";
      const sources: CandidateEvidence["sources"] = [],
        failures: CandidateEvidence["failures"] = [];
      for (const result of results.slice(0, 2)) {
        if (!fetched.has(result.url))
          fetched.set(
            result.url,
            (async () => {
              const existing = store
                .evidence(competitionId)
                .find((e) => e.url === result.url);
              const source =
                existing ||
                (await saveSource(
                  store,
                  competitionId,
                  result.url,
                  "novelty",
                  result.title,
                ));
              return {
                url: source.url,
                requestedUrl: result.url,
                title: source.title,
                excerpt: source.text.slice(0, 6000),
                fetchedAt: source.fetchedAt,
              };
            })(),
          );
        try {
          sources.push(await fetched.get(result.url)!);
        } catch (e) {
          failures.push({
            url: result.url,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const gaps: string[] = [];
      if (searchStatus !== "available")
        gaps.push(
          `候选 ${index + 1}「${idea.title}」相似作品检索${searchStatus === "unavailable" ? "不可用" : searchStatus === "failed" ? "失败" : "无结果"}，原创性尚未核实`,
        );
      else if (!sources.length)
        gaps.push(
          `候选 ${index + 1}「${idea.title}」只有搜索线索，没有可读取正文，原创性尚未核实`,
        );
      if (failures.length)
        gaps.push(
          `候选 ${index + 1} 有 ${failures.length} 个相似作品来源无法读取`,
        );
      return {
        candidate: index + 1,
        title: idea.title,
        query,
        searchStatus,
        sources,
        failures,
        gaps,
      };
    }),
  );
  await record(cfg, store, jobId, "candidate-evidence.json", report, null);
  return report;
}

export async function compareCandidates(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
  jobId: string,
  brief: Brief,
  ideas: Idea[],
  evidence: CandidateEvidence[],
  pairs: unknown[],
): Promise<{ choice: Choice; gaps: string[] }> {
  const gaps = evidence.flatMap((e) => e.gaps);
  if (!ideas.length)
    return {
      choice: {
        selected: 1,
        analysis: "没有生成候选方案",
        similarity_risks: [],
      },
      gaps,
    };
  let choice: Choice;
  try {
    const raw = await gateway.generate(
      "reviewer",
      `${Guard}\n任务：候选比较。以下是 ${ideas.length} 个候选方案，按规则适配、可行性、差异性和可验证性选择一个。必须结合下面实际获取的相似作品正文比较机制；词面相似度不是抄袭判定。无搜索结果、不可读网页或证据不足均不代表原创。不要编造来源。只输出 JSON {"selected":1,"analysis":"说明选择理由和证据限制","similarity_risks":["风险及对应来源URL或未核实项"]}，selected 必须在 1 到 ${ideas.length} 之间。规则：${JSON.stringify(brief)}\n候选：${JSON.stringify(ideas)}\n已获取的相似作品资料：${JSON.stringify(evidence)}\n词面相似度提示：${JSON.stringify(pairs)}`,
      "reviewer",
    );
    choice = z
      .object({
        selected: z.number().int().min(1).max(ideas.length),
        analysis: z.string().min(1),
        similarity_risks: z.array(z.string()).default([]),
      })
      .parse(parseJSON(raw));
  } catch (e) {
    if (isJobControlError(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    if (budgetError(message)) throw e;
    gaps.push("候选评审不可用或选择无效，按生成顺序降级，尚未完成方案比较");
    choice = {
      selected: 1,
      analysis: "候选评审不可用或选择无效，按生成顺序采用第一个候选",
      similarity_risks: [],
    };
    await record(
      cfg,
      store,
      jobId,
      "concept-review-error.json",
      { error: message, continued: true },
      null,
    );
  }
  gaps.push(...choice.similarity_risks.map((r) => `选题风险：${r}`));
  await record(
    cfg,
    store,
    jobId,
    "concept-review.json",
    { ...choice, evidencePath: "candidate-evidence.json" },
    modelLabel(cfg, "reviewer"),
  );
  return { choice, gaps: [...new Set(gaps)] };
}
