import test from "node:test";
import assert from "node:assert/strict";
import { ConceptReview, Strategy, conceptRoutes, validateConceptReview } from "../dist/workflows/concept-quality.js";

const ideas = [
  { title: "规则排队", audience: "离线窗口", problem: "排队耗时", mechanism: "按人工核验优先级重排队列", verification: "对照原队列记录时间与错误率", evidence_urls: [] },
  { title: "反馈调节", audience: "在线窗口", problem: "需求波动", mechanism: "采样等待时长并闭环调整窗口分流", verification: "留出日期测量延迟", evidence_urls: [] },
];
const review = (extra = {}) => ConceptReview.parse({ selected: 2, analysis: "反馈调整更适合需求波动", ...extra });

test("旧最小 selected+analysis 可直接选择，无来源不要求证明原创", () => {
  const value = review();
  assert.deepEqual(value.similarity_risks, []);
  assert.equal(value.strategy, undefined);
  assert.deepEqual(validateConceptReview(value, ideas, []), []);
});

test("Strategy 是可选方向，旧字段和空数组正常，不要求逐字复制", () => {
  const value = review({ strategy: { problem: "聚焦高峰排队", mechanism: "用观测反馈调整分流", audience: "办事学生", differentiators: [], tradeoffs: [], validation: [], evidenceLimits: [] } });
  assert.deepEqual(validateConceptReview(value, ideas, []), []);
  assert.deepEqual(Strategy.parse({ mechanism: "只提供一个写作方向" }), { mechanism: "只提供一个写作方向" });
  assert.deepEqual(validateConceptReview(review({ strategy: null }), ideas, []), []);
});

test("uncertain 和一般 overlap 作为限制，不阻塞有效选择", () => {
  const value = review({ analysis: "与公开来源存在 overlap，核心差异尚 uncertain，先展开可行方案", similarity_risks: ["暂缺现场效果记录"], comparisons: [{ verdict: "uncertain" }], sourceComparisons: [{ findings: [{ relation: "overlap" }] }] });
  assert.deepEqual(validateConceptReview(value, ideas, []), []);
  assert.equal("comparisons" in value, false);
});

test("仅所选方案的具体核心雷同要求定向修正", () => {
  const duplicate = { candidate: 2, otherCandidate: 1, reason: "只是将同一固定打分队列更名，没有改变处理过程", instructions: "改为根据现场等待时长调整分流" };
  assert.deepEqual(validateConceptReview(review({ core_duplicate: duplicate }), ideas, []), [{ candidate: 2, instructions: `${duplicate.reason}；${duplicate.instructions}` }]);
  assert.deepEqual(validateConceptReview(review({ core_duplicate: { ...duplicate, candidate: 1, otherCandidate: 2 } }), ideas, []), []);
});

test("其他未选候选相同也不返工，不用字符串自动判抄袭", () => {
  const candidates = [ideas[0], ideas[1], { ...ideas[0], title: "相同的另一分支" }];
  assert.deepEqual(validateConceptReview(review(), candidates, []), []);
  assert.deepEqual(validateConceptReview(review(), [ideas[0], ideas[0]], []), []);
});

test("明确与已获取来源机制等同且无增量可以修正，不要求逐网页 finding", () => {
  const url = "https://example.org/work";
  const duplicate = { candidate: 2, sourceUrl: url, reason: "同样按两次采样调整分流，输入、触发规则和输出完全一致，无增量", instructions: "针对离线窗口改变分流触发方式" };
  const evidence = [{ candidate: 2, sources: [{ url, requestedUrl: url, excerpt: "两次采样后调整分流" }] }];
  assert.equal(validateConceptReview(review({ core_duplicate: duplicate }), ideas, evidence)[0].candidate, 2);
  assert.throws(() => validateConceptReview(review({ core_duplicate: duplicate }), ideas, []), /已获取的来源/);
});

test("选择编号和明确修正目标必须有效，不默认首项", () => {
  for (const selected of [null, 0, -1, 1.5, "2"])
    assert.equal(ConceptReview.safeParse({ selected, analysis: "选择理由" }).success, false);
  assert.throws(() => validateConceptReview(review({ selected: 3 }), ideas, []), /越界/);
  assert.throws(() => validateConceptReview(review({ core_duplicate: { candidate: 2, reason: "相同", instructions: "修改" } }), ideas, []), /具体来源或其他候选/);
  assert.throws(() => validateConceptReview(review({ core_duplicate: { candidate: 2, otherCandidate: 2, reason: "相同", instructions: "修改" } }), ideas, []), /其他候选无效/);
  assert.equal(ConceptReview.safeParse({ selected: 2, analysis: " " }).success, false);
  assert.equal(ConceptReview.safeParse({ selected: 2, analysis: "理由", similarity_risks: ["一", "二", "三", "四"] }).success, false);
});

test("非技术作品使用创作语境路线，不强塞技术验证", () => {
  const routes = conceptRoutes({ title: "征文与海报创作", deliverables: [] });
  assert.equal(routes.length, 3);
  assert.match(routes.join(" "), /人物|叙事|媒介/);
  assert.doesNotMatch(routes.join(" "), /基线|消融|算法/);
  assert.match(conceptRoutes({ title: "校园服务创新", deliverables: [] })[0], /真实使用者痛点/);
});
