import { createHash } from "node:crypto";
import { z } from "zod";
import type { Idea } from "./shared.js";
import type { CandidateEvidence } from "./concepts.js";

export const conceptFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const CONCEPT_ROUTES = [
  "从真实使用者痛点和具体场景出发。场景约束：材料中明确的本地条件、资源与冲突；工作机制：以一个具体人的行动或一项具体流程展开，技术作品优先流程/结构重排与可解释规则，叙事或视觉作品从当事者视角和可见细节组织；验证方法：技术作品与现行流程对照，创作作品核对事实来源、叙事因果及受众理解，不能虚构访谈或测试",
  "从跨学科方法或相邻领域出发。场景约束：信息缺失、视角偏差或需求变化；工作机制：引入一种有依据的不同观察方式，技术作品采用观测—解释—反馈修正，叙事或视觉作品采用不同视角、时间组织或材料之间的对照，禁止只换名称；验证方法：解释这种机制改变了什么，技术作品设消融对照，创作作品检验材料选择与结构是否支持主题，不强塞算法术语",
  "从低资源限制和可验证的实际效果出发。场景约束：至少两个价值或目标之间的真实取舍；工作机制：从替代方案或不同因果路径出发，技术作品做约束下反事实推演，叙事或视觉作品通过独立冲突结构、意象或媒介选择表达，不能复述前两路线；验证方法：与合理替代方案比较，说明舍弃什么、保留什么及失败边界，依据比赛类型检查，不虚构实测结果",
] as const;

const text = z.string().trim().min(1);
const field = z.enum(["audience", "problem", "mechanism", "verification"]);
const assessment = z.object({
  status: z.enum(["passed", "failed", "unverified"]),
  basis: z.object({ field, quote: text }),
  reason: text,
});
export const Strategy = z.object({
  problem: text,
  audience: text,
  mechanism: text,
  differentiators: z.array(text).min(1),
  tradeoffs: z.array(text).min(1),
  validation: z.array(text).min(1),
  evidenceLimits: z.array(text).min(1),
});
export type Choice = {
  selected: number;
  analysis: string;
  similarity_risks: string[];
  strategy?: z.infer<typeof Strategy>;
};
export const ConceptReview = z.object({
  selected: z.number().int().positive().nullable(),
  analysis: text,
  similarity_risks: z.array(text),
  strategy: Strategy.nullable(),
  quality: z.array(z.object({
    candidate: z.number().int().positive(),
    fit: assessment,
    feasibility: assessment,
    validation: assessment,
  })),
  comparisons: z.array(z.object({
    left: z.number().int().positive(),
    right: z.number().int().positive(),
    verdict: z.enum(["distinct", "duplicate", "uncertain"]),
    leftMechanism: text,
    rightMechanism: text,
    mechanismDifference: text,
    constraintDifference: text,
    validationDifference: text,
    rewriteCandidate: z.number().int().positive().nullable(),
    rewriteInstructions: z.string(),
  })),
  sourceComparisons: z.array(z.object({
    candidate: z.number().int().positive(),
    status: z.enum(["compared", "unverified"]),
    findings: z.array(z.object({
      url: text,
      quote: text,
      relation: z.enum(["overlap", "different", "uncertain"]),
      reason: text,
    })),
    limitations: z.array(text).min(1),
  })),
});
export type ConceptReview = z.infer<typeof ConceptReview>;
export type Rewrite = { candidate: number; instructions: string };
export class DuplicateCandidatesError extends Error {
  constructor(public readonly rewrites: Rewrite[]) {
    super(`候选机制实质重复，不能选择：${rewrites.map((r) => `候选${r.candidate}：${r.instructions}`).join("；")}`);
    this.name = "DuplicateCandidatesError";
  }
}

const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function completeIds(ids: number[], count: number, label: string) {
  if (ids.length !== count || new Set(ids).size !== count || ids.some((id) => id < 1 || id > count))
    throw Error(`${label}必须逐候选覆盖且不得重复`);
}

/** 校验引用、覆盖范围和实际机制；返回明确重复，缺证据与不确定不能触发随意改写。 */
export function validateConceptReview(
  review: ConceptReview,
  ideas: Idea[],
  evidence: CandidateEvidence[],
): Rewrite[] {
  completeIds(review.quality.map((q) => q.candidate), ideas.length, "质量评估");
  completeIds(review.sourceComparisons.map((q) => q.candidate), ideas.length, "来源比较");
  completeIds(evidence.map((e) => e.candidate), ideas.length, "候选证据");
  for (const e of evidence) {
    if (e.fingerprint !== conceptFingerprint(ideas[e.candidate - 1]))
      throw Error(`候选${e.candidate}证据指纹已失效，必须重新获取`);
  }
  for (const q of review.quality) {
    const idea = ideas[q.candidate - 1]!;
    for (const check of [q.fit, q.feasibility, q.validation])
      if (!idea[check.basis.field].includes(check.basis.quote))
        throw Error(`候选${q.candidate}质量依据不在对应字段正文中`);
    if (q.feasibility.basis.field !== "mechanism" || q.validation.basis.field !== "verification")
      throw Error(`候选${q.candidate}必须分别引用机制和验证方案作为质量依据`);
  }
  const allowedUrls = new Set(evidence.flatMap((e) => e.sources.map((s) => s.url)));
  const inspectText = (value: unknown): void => {
    if (typeof value === "string") {
      if (/^(独一无二|绝对原创|完全原创|全球首创)[。！!]*$/.test(value.trim()))
        throw Error("评审不能用笼统原创断言代替具体比较依据");
      for (const match of value.matchAll(/https?:\/\/[^\s<>"'，。；、）)\]}]+/gu)) {
        const url = match[0].replace(/[.,;!?]+$/, "");
        if (!allowedUrls.has(url)) throw Error(`评审引用未获取的 URL：${url}`);
      }
    } else if (Array.isArray(value)) value.forEach(inspectText);
    else if (value && typeof value === "object") Object.values(value).forEach(inspectText);
  };
  inspectText(review);
  for (const comparison of review.sourceComparisons) {
    const sources = evidence.find((e) => e.candidate === comparison.candidate)!.sources;
    for (const finding of comparison.findings) {
      const source = sources.find((s) => s.url === finding.url);
      if (!source || !source.excerpt.includes(finding.quote))
        throw Error(`候选${comparison.candidate}来源比较缺少已获取正文中的准确引用`);
    }
    if (sources.length) {
      if (comparison.status !== "compared" || sources.some((s) => !comparison.findings.some((f) => f.url === s.url)))
        throw Error(`候选${comparison.candidate}缺少已获取来源的比较证据`);
    } else if (comparison.status !== "unverified" || comparison.findings.length)
      throw Error(`候选${comparison.candidate}无正文，不得把检索失败或无结果当作原创证据`);
  }
  const seen = new Set<string>();
  const rewrites = new Map<number, string[]>();
  const uncertainties: string[] = [];
  const addRewrite = (candidate: number, instructions: string) =>
    rewrites.set(candidate, [...(rewrites.get(candidate) || []), instructions]);
  for (const pair of review.comparisons) {
    const { left, right } = pair;
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    if (left === right || left > ideas.length || right > ideas.length || seen.has(key))
      throw Error("候选对比较存在越界、自比或重复");
    seen.add(key);
    if (pair.leftMechanism !== ideas[left - 1]!.mechanism || pair.rightMechanism !== ideas[right - 1]!.mechanism)
      throw Error(`候选对${key}没有准确引用双方机制，不能确认实质差异`);
    const identical = normalize(pair.leftMechanism) === normalize(pair.rightMechanism);
    if (pair.verdict === "duplicate") {
      if (![left, right].includes(pair.rewriteCandidate!) || !pair.rewriteInstructions.trim())
        throw Error(`重复候选对${key}必须指定其中一个候选及具体重写要求`);
      addRewrite(pair.rewriteCandidate!, `与候选${pair.rewriteCandidate === left ? right : left}重复：${pair.mechanismDifference}；${pair.rewriteInstructions}`);
    } else if (identical) {
      addRewrite(right, `与候选${left}的机制正文相同，必须改变工作机制、场景约束和验证方法，而不是改标题或领域标签`);
    } else if (pair.verdict === "uncertain") {
      uncertainties.push(`候选对${key}：${pair.mechanismDifference}`);
    } else if (pair.rewriteCandidate !== null) throw Error(`非重复候选对${key}不得指定重写`);
  }
  if (seen.size !== ideas.length * (ideas.length - 1) / 2)
    throw Error("缺少全量候选对的实质差异比较证据");
  if (uncertainties.length) throw Error(`候选差异尚无足够比较证据：${uncertainties.join("；")}`);
  if (rewrites.size) return [...rewrites].map(([candidate, instructions]) => ({ candidate, instructions: instructions.join("；") }));
  if (review.selected === null || review.selected > ideas.length)
    throw Error("候选选择缺失或越界，不能默认选择第一项");
  const selectedQuality = review.quality.find((q) => q.candidate === review.selected)!;
  const failed = [selectedQuality.fit, selectedQuality.feasibility, selectedQuality.validation].filter((q) => q.status !== "passed");
  if (failed.length) throw Error(`所选候选未达到质量要求：${failed.map((q) => q.reason).join("；")}`);
  const idea = ideas[review.selected - 1]!;
  if (!review.strategy || ["problem", "audience", "mechanism"].some((key) => review.strategy![key as "problem" | "audience" | "mechanism"] !== idea[key as "problem" | "audience" | "mechanism"]))
    throw Error("质量合同必须绑定所选候选的问题、受众和机制原文");
  return [];
}

export const REVIEW_FORMAT = `只输出严格 JSON：
{"selected":1,"analysis":"具体选择理由与限制","similarity_risks":["具体风险"],"strategy":{"problem":"所选 problem 原文","audience":"所选 audience 原文","mechanism":"所选 mechanism 原文","differentiators":["机制层面的差异及理由"],"tradeoffs":["实现代价与取舍"],"validation":["基线、指标、可执行步骤、失败阈值"],"evidenceLimits":["未核实事实与证据边界"]},"quality":[{"candidate":1,"fit":{"status":"passed","basis":{"field":"problem","quote":"该字段原文摘录"},"reason":"与具体规则及场景的适配依据"},"feasibility":{"status":"passed","basis":{"field":"mechanism","quote":"原文摘录"},"reason":"输入、资源、步骤、输出是否可实现"},"validation":{"status":"passed","basis":{"field":"verification","quote":"原文摘录"},"reason":"对照、指标、失败条件是否可执行"}}],"comparisons":[{"left":1,"right":2,"verdict":"distinct","leftMechanism":"左候选 mechanism 完整原文","rightMechanism":"右候选 mechanism 完整原文","mechanismDifference":"具体输入处理输出及因果过程的区别或重复依据","constraintDifference":"场景约束区别及其是否改变工作机制","validationDifference":"验证方法和失败条件的区别","rewriteCandidate":null,"rewriteInstructions":""}],"sourceComparisons":[{"candidate":1,"status":"unverified","findings":[],"limitations":["没有可读取正文，原创性未核实"]}]}
quality 和 sourceComparisons 必须覆盖每个候选；quality 各状态只能 passed/failed/unverified。comparisons 必须覆盖所有无序候选对，verdict 只能 distinct/duplicate/uncertain。相同机制、同流程只换标题/领域标签必须 duplicate，指定一个 rewriteCandidate 与具体重写要求；存在 duplicate/uncertain 时 selected 与 strategy 必须为 null。不确定就明确 uncertain，不能编造差异。不比较措辞；不得为了凑差异宣称独一无二。逐条比较实际获得的来源正文，findings 每项为 {url,quote,relation,reason}，relation 只能 overlap/different/uncertain，quote 必须逐字出自所给 excerpt，引用只准已获取的 sources.url。每个已获取来源至少一条 finding，status 为 compared；无正文只能 unverified 且 findings 为空。每个候选至少一项 limitations；检索无结果/失败不能证明原创。所选候选的三项 quality 必须全部 passed，strategy 数组均不得为空；禁止降低标准或默认选择首项。`;
