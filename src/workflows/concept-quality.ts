import { createHash } from "node:crypto";
import { z } from "zod";
import type { Brief } from "../core/types.js";
import type { Idea } from "./shared.js";
import type { CandidateEvidence } from "./concepts.js";

export const conceptFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const CONCEPT_ROUTES = [
  "从真实使用者痛点和具体场景出发。关注场景约束，提出简洁可行的工作机制和验证方法",
  "从跨学科方法或相邻领域出发。用一种不同的观察或处理方法解决问题，说明它改变了什么",
  "从低资源限制和实际效果出发。选择资源允许的替代方案，明确取舍及如何检验效果",
] as const;
const CREATIVE_ROUTES = [
  "从具体人物、现场细节和真实材料出发，选择能承载主题的叙事视角或视觉焦点",
  "从材料之间的冲突或不同视角出发，用时间结构、对照或意象组织作品",
  "从媒介和表达限制出发，选择精练的结构、节奏或画面关系，突出一个值得表达的主题",
] as const;
export function conceptRoutes(brief: Brief): readonly string[] {
  return /征文|小说|诗歌|散文|文学|故事|绘画|视觉|海报|摄影|短片|剧本|艺术|creative writing|photography/i.test(
    `${brief.title} ${brief.deliverables.map((d) => d.type).join(" ")}`,
  ) ? CREATIVE_ROUTES : CONCEPT_ROUTES;
}

const text = z.string().trim().min(1);
/** 模型偶尔把数组字段写成一段文本：按换行/分号拆开即可，语义无损；其余类型原样交 zod 判定。 */
const arrayish = z.preprocess(
  (v) => {
    if (typeof v === "string") {
      const items = v
        .split(/\r?\n|；|;/)
        .map((x) => x.trim())
        .filter(Boolean);
      return items;
    }
    return v;
  },
  z.array(text).optional(),
);
/** 可选写作方向；兼容旧字段，但不是必须逐条证明或逐字复述的合同。 */
export const Strategy = z.object({
  problem: text.optional(),
  audience: text.optional(),
  mechanism: text.optional(),
  differentiators: arrayish,
  tradeoffs: arrayish,
  validation: arrayish,
  evidenceLimits: arrayish,
});
export type Choice = {
  selected: number;
  analysis: string;
  similarity_risks: string[];
  strategy?: z.infer<typeof Strategy>;
};
export const ConceptReview = z.object({
  selected: z.number().int().positive(),
  analysis: text,
  similarity_risks: z.array(text).max(3).default([]),
  strategy: Strategy.nullable().optional(),
  core_duplicate: z.object({
    candidate: z.number().int().positive(),
    otherCandidate: z.number().int().positive().optional(),
    sourceUrl: text.optional(),
    reason: text,
    instructions: text,
  }).nullable().optional(),
});
export type ConceptReview = z.infer<typeof ConceptReview>;
export type Rewrite = { candidate: number; instructions: string };
export class DuplicateCandidatesError extends Error {
  constructor(public readonly rewrites: Rewrite[]) {
    super(`所选候选核心机制雷同：${rewrites.map((r) => `候选${r.candidate}：${r.instructions}`).join("；")}`);
    this.name = "DuplicateCandidatesError";
  }
}

/** 只处理影响所选方案的明确核心雷同，不用词面相似度或证据缺口判抄袭。 */
export function validateConceptReview(
  review: ConceptReview, ideas: Idea[], evidence: CandidateEvidence[],
): Rewrite[] {
  if (!Number.isInteger(review.selected) || review.selected < 1 || review.selected > ideas.length)
    throw Error("候选选择缺失或越界，不能默认选择第一项");
  const duplicate = review.core_duplicate;
  if (!duplicate || duplicate.candidate !== review.selected) return [];
  if (duplicate.otherCandidate !== undefined &&
      (duplicate.otherCandidate === review.selected || duplicate.otherCandidate > ideas.length))
    throw Error("核心雷同指向的其他候选无效");
  if (duplicate.sourceUrl && !evidence.find((e) => e.candidate === review.selected)?.sources.some(
    (s) => s.url === duplicate.sourceUrl || s.requestedUrl === duplicate.sourceUrl,
  )) throw Error("核心雷同必须指向已获取的来源");
  if (!duplicate.otherCandidate && !duplicate.sourceUrl)
    throw Error("核心雷同必须指出具体来源或其他候选");
  return [{ candidate: review.selected, instructions: `${duplicate.reason}；${duplicate.instructions}` }];
}

export const REVIEW_FORMAT = `只输出严格 JSON，正常比较只需 {"selected":1,"analysis":"简要说明为什么适合创作，以及重要限制","similarity_risks":["最多3条具体风险或改进"]}。similarity_risks 可省略或为空。无需逐候选打分、全量候选对举证、逐网页 finding 或固定 limitations。
strategy 可省略；需要时仅补充简洁写作方向，可使用 problem/audience/mechanism/differentiators/tradeoffs/validation/evidenceLimits 中有用的字段，数组可空，不必逐字复制候选。
无搜索结果、比较 uncertain、一般 overlap 或其他未选候选重复，不阻止选择。只在所选方案与具体候选或已获取来源的核心机制等同且没有实质增量、会影响创作时，附加 core_duplicate:{"candidate":选中编号,"otherCandidate":其他候选编号或省略,"sourceUrl":"已获取来源URL或省略","reason":"具体等同机制与缺少增量的原因","instructions":"一条定向改进要求"}。这不是普通相似风险；必须指出 otherCandidate 或 sourceUrl，selected 仍填合法编号。至多一次定向修正，不为了证明原创反复重写。检索有限不能证明原创，也不能据此断言抄袭。`;
