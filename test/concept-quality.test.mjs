import test from "node:test";
import assert from "node:assert/strict";
import { ConceptReview, conceptFingerprint, validateConceptReview } from "../dist/workflows/concept-quality.js";

const ideas = [
  { title: "规则排队", audience: "离线窗口", problem: "排队耗时", mechanism: "按人工核验优先级重排队列", verification: "对照原队列记录时间与错误率", evidence_urls: [] },
  { title: "反馈调节", audience: "在线窗口", problem: "需求波动", mechanism: "采样等待时长并闭环调整窗口分流", verification: "留出日期并消融反馈测量延迟", evidence_urls: [] },
];
function fixture(candidates = ideas) {
  const evidence = candidates.map((idea, i) => ({ candidate: i + 1, title: idea.title, fingerprint: conceptFingerprint(idea), query: "test", queries: [], searchStatus: "empty", sources: [], failures: [], gaps: ["无结果不能证明原创"] }));
  const check = (idea, field) => ({ status: "passed", basis: { field, quote: idea[field] }, reason: `明确的${field}可以用于对照评估` });
  const review = ConceptReview.parse({
    selected: 2, analysis: "候选2的反馈过程适用于需求波动，效果尚未实测", similarity_risks: ["公开来源尚未核实"],
    strategy: { problem: candidates[1].problem, audience: candidates[1].audience, mechanism: candidates[1].mechanism, differentiators: ["观察值改变下一次分流行为"], tradeoffs: ["需要采样且有反馈延迟"], validation: ["留出日期对照固定分流基线，测等待时长"], evidenceLimits: ["未获得外部正文"] },
    quality: candidates.map((idea, i) => ({ candidate: i + 1, fit: check(idea, "problem"), feasibility: check(idea, "mechanism"), validation: check(idea, "verification") })),
    comparisons: [{ left: 1, right: 2, verdict: "distinct", leftMechanism: candidates[0].mechanism, rightMechanism: candidates[1].mechanism, mechanismDifference: "固定规则重排与观测反馈控制不同", constraintDifference: "离线固定人力与在线可观测队列不同", validationDifference: "流程对照与反馈消融不同", rewriteCandidate: null, rewriteInstructions: "" }],
    sourceComparisons: candidates.map((_, i) => ({ candidate: i + 1, status: "unverified", findings: [], limitations: ["搜索无结果，不能认定原创"] })),
  });
  return { review, evidence, candidates };
}

test("不同机制且逐候选依据、全量比较完整才通过", () => {
  const f = fixture();
  assert.deepEqual(validateConceptReview(f.review, f.candidates, f.evidence), []);
});

test("同词换标题的相同机制即使被评审误报 distinct 也阻止选择", () => {
  const f = fixture([ideas[0], { ...ideas[0], title: "全新智能窗口" }]);
  const rewrites = validateConceptReview(f.review, f.candidates, f.evidence);
  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0].candidate, 2);
  assert.match(rewrites[0].instructions, /机制正文相同/);
});

test("只换领域标签的机制明确重复时要求指定候选重写", () => {
  const f = fixture();
  f.review.selected = null;
  f.review.strategy = null;
  Object.assign(f.review.comparisons[0], { verdict: "duplicate", rewriteCandidate: 2, rewriteInstructions: "将同一打分推荐流程改为观测反馈并增加消融验证", mechanismDifference: "同一打分推荐流程仅替换学校和医院标签" });
  assert.equal(validateConceptReview(f.review, f.candidates, f.evidence)[0].candidate, 2);
  f.review.comparisons[0].rewriteCandidate = null;
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /指定其中一个候选/);
});

test("缺候选对、缺质量依据或差异不确定均不通过", () => {
  let f = fixture();
  f.review.comparisons = [];
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /全量候选对/);
  f = fixture();
  f.review.quality[1].feasibility.basis.quote = "不存在的机制";
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /质量依据/);
  f = fixture();
  f.review.comparisons[0].verdict = "uncertain";
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /尚无足够比较证据/);
});

test("外部比较必须覆盖正文且逐字引用已获取 URL", () => {
  const f = fixture();
  const url = "https://example.org/previous";
  f.evidence[0].sources.push({ url, requestedUrl: url, title: "往届", excerpt: "使用固定优先级重排队列", fetchedAt: "2026-01-01" });
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /缺少已获取来源/);
  f.review.sourceComparisons[0] = { candidate: 1, status: "compared", findings: [{ url, quote: "固定优先级重排队列", relation: "overlap", reason: "与候选1的规则排队机制相近" }], limitations: ["未披露现场效果"] };
  assert.deepEqual(validateConceptReview(f.review, f.candidates, f.evidence), []);
  f.review.sourceComparisons[0].findings[0].quote = "已经证明独一无二";
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /准确引用/);
  f.review.analysis = "参见 https://unfetched.example/work";
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /未获取的 URL/);
});

test("失效证据和未达质量要求的选择不能通过", () => {
  let f = fixture();
  f.evidence[1].fingerprint = "old";
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /指纹已失效/);
  f = fixture();
  f.review.quality[1].validation.status = "unverified";
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /未达到质量要求/);
  f = fixture();
  f.review.strategy.mechanism = "擅自换成新机制";
  assert.throws(() => validateConceptReview(f.review, f.candidates, f.evidence), /质量合同必须绑定/);
});
