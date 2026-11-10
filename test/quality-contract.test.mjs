import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { Plan, runOrchestration, strategyContract, strategyPrompt, qualityPlanProblems, checkedQualityContract } from "../dist/workflows/orchestrator.js";

const idea = { title: "离线调度", problem: "低资源排队", audience: "社区志愿者", mechanism: "按等待时间与容量逐项分配", verification: "与先到先服务对比", evidence_urls: [] };
const selection = { selected: 1, analysis: "适合有限人工", similarity_risks: [], strategy: {
  problem: idea.problem, audience: idea.audience, mechanism: idea.mechanism,
  differentiators: ["容量满后优先保留等待最久者"], tradeoffs: ["牺牲即时吞吐以保证等待公平"],
  validation: ["与先到先服务用同组输入比较等待时长，超过三轮未服务为失败"], evidenceLimits: ["没有全网原创性比较和真实实验记录"],
} };
const contract = strategyContract(selection);
const body = "社区志愿者处理低资源排队，按等待时间与容量逐项分配。容量满后优先保留等待最久者，牺牲即时吞吐以保证等待公平。验证计划以同组输入对比先到先服务的等待时长，超过三轮未服务为失败；尚无实验记录，原创性未核实。";
const task = { id: "report", deliverable: 0, title: "报告", kind: "document", format: "txt", instructions: "完整报告正文", acceptance: ["内容完整"], qualityContract: contract.map(({ id, requirement }) => ({ id, implementation: `正文具体落实：${requirement}` })) };
const item = { type: "方案报告", formats: ["txt"], quantity: null, limits: [], naming: null, attachments: [], submission: null, official_template: null };
const brief = { title: "机制设计赛", edition: "2026", eligibility: null, deadline: null, ai_rules: null, scoring: null, deliverables: [item], requires_idea: true, missing: [], citations: [], research: { past_winners: [], past_works: [], judging: [], missing: [] } };
const rows = (text = body, location = "L3") => contract.map(({ id }) => ({ id, status: "passed", evidence: { kind: "text", location, quote: text }, reason: "正文展示了约定的具体实现与证据边界" }));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "quality-contract-"));
  const store = new Store(dir);
  const cfg = { dataDir: dir, execution: { productionRounds: 2, plannerRounds: 2 }, writer: { providerID: "google", id: "gemini-test" }, reviewer: { providerID: "anthropic", id: "claude-test" }, maxCalls: 40, sources: [], profile: {} };
  const competitionId = store.addCompetition("https://example.edu.cn/contest", "机制设计赛");
  store.setBrief(competitionId, brief);
  const jobId = store.createJob(competitionId, "automatic", {}, 40);
  return { dir, store, cfg, input: { competitionId, jobId, idea, selection }, close: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}
function gateway({ review, output = () => body, planTask = task } = {}) {
  const calls = { plans: [], writes: [], reviews: [] };
  return { calls, search: async () => [], generate: async (_role, prompt) => {
    if (prompt.includes("拆解成可以实际制作的文件任务")) { calls.plans.push(prompt); return JSON.stringify({ tasks: [planTask] }); }
    if (prompt.includes("任务：作品验收")) {
      calls.reviews.push(prompt);
      return JSON.stringify({ issues: [], criteria: [{ criterion: 0, status: "passed", evidence: "实际正文" }], ...(review ? review(prompt, calls) : { qualityContract: rows() }) });
    }
    if (prompt.includes("直接创作")) { calls.writes.push(prompt); return JSON.stringify({ kind: "text", title: "报告", text: output(calls), sources: [], needs_input: [] }); }
    throw Error(`unexpected prompt ${prompt.slice(0, 60)}`);
  } };
}

test("策略进入 planner/writer；合同完整通过才完成，策略变化使缓存失效", async () => {
  const c = await setup(); const g = gateway();
  try {
    const result = await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(result.deliverables[0].status, "submission");
    assert.equal(result.deliverables[0].review.qualityContract.length, contract.length);
    for (const p of [...g.calls.plans, ...g.calls.writes]) {
      assert.match(p, /strategy\.differentiators\.1/); assert.match(p, /不能声称实测有效/); assert.match(p, /核心差异未实现/);
    }
    assert.equal(g.calls.reviews.length, 1);
    await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(g.calls.writes.length, 1);
    c.input.selection = { ...selection, strategy: { ...selection.strategy, tradeoffs: ["公平优先，限制每轮吞吐"] } };
    await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(g.calls.plans.length, 2); assert.equal(g.calls.writes.length, 2);
  } finally { await c.close(); }
});

for (const [label, mutate] of [
  ["缺合同", () => ({})],
  ["重复ID", () => ({ qualityContract: rows().map((r, i, all) => i === 1 ? all[0] : r) })],
  ["捏造quote", () => ({ qualityContract: rows("不存在的已测提升百分比") })],
  ["错误定位", () => ({ qualityContract: rows(body, "L1") })],
]) test(`${label}只修复一次后同标准返工；失败不登记完成`, async () => {
  const c = await setup(); const g = gateway({ review: mutate });
  try {
    await assert.rejects(runOrchestration(c.cfg, c.store, g, c.input), /仍未通过验收.*qualityContract/);
    assert.equal(g.calls.writes.length, 2); assert.equal(g.calls.reviews.length, 4);
    assert.match(g.calls.writes[1], /策略合同验收失败/);
    assert.ok(!c.store.artifacts(c.input.jobId).some((a) => a.kind === "submission"));
    assert.ok(!(await readdir(join(c.dir, "jobs", c.input.jobId))).includes("orchestration.json"));
  } finally { await c.close(); }
});

test("核心差异只有口号必须返工，真正落实后成功", async () => {
  const c = await setup();
  const g = gateway({ output: (calls) => calls.writes.length === 1 ? "本方案创新独特，公平高效。" : body,
    review: (_p, calls) => ({ qualityContract: calls.writes.length === 1 ? rows("本方案创新独特，公平高效。").map((r) => r.id === "strategy.differentiators.1" ? { id: r.id, status: "failed", reason: "核心差异未实现，仅有口号；须落实容量满后保留等待最久者的规则" } : r) : rows() }) });
  try {
    const result = await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(result.deliverables[0].rounds, 2); assert.equal(g.calls.reviews.length, 2);
    assert.match(g.calls.writes[1], /核心差异未实现，仅有口号/);
    assert.match(await readFile(result.deliverables[0].artifactPaths[0], "utf8"), /容量满后优先保留等待最久者/);
    assert.ok(result.deliverables[0].checks.some((x) => x.id === "strategy.differentiators.1" && x.status === "passed"));
  } finally { await c.close(); }
});

test("大量复用真实来源先阻塞，重做论证后才进入内容评审", async () => {
  const c = await setup();
  const copied = Array.from({ length: 450 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
  c.store.putEvidence({ id: "reuse-source", competitionId: c.input.competitionId,
    url: "https://example.edu.cn/prior-work", title: "已有作品", text: copied,
    kind: "novelty", fetchedAt: new Date().toISOString() });
  const g = gateway({ output: (calls) => calls.writes.length === 1 ? copied : body });
  try {
    const result = await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(result.deliverables[0].rounds, 2);
    assert.equal(g.calls.reviews.length, 1, "明显复用不能靠模型空issues通过");
    assert.match(g.calls.writes[1], /文字复用阻塞/);
    assert.match(g.calls.writes[1], /不能只作同义词替换/);
    const reports = JSON.parse(await readFile(join(c.dir, "jobs", c.input.jobId, "text-reuse.json"), "utf8"));
    assert.equal(reports[0].report.status, "blocked");
    assert.notEqual(reports[1].report.status, "blocked");
    assert.equal(await readFile(result.deliverables[0].artifactPaths[0], "utf8").then((x) => x.includes(copied)), false);
  } finally { await c.close(); }
});

test("无strategy或固定赛题仍按旧协议完成，不合成策略", async () => {
  for (const value of [undefined, { analysis: "固定赛题", strategy: null }]) {
    const c = await setup(); const { qualityContract, ...legacyTask } = task;
    const g = gateway({ planTask: legacyTask, review: () => ({}) });
    try {
      const result = await runOrchestration(c.cfg, c.store, g, { ...c.input, idea: null, selection: value });
      assert.equal(result.deliverables[0].status, "submission"); assert.equal(g.calls.reviews.length, 1);
      assert.ok(!g.calls.reviews[0].includes("必须增加 qualityContract"));
    } finally { await c.close(); }
  }
});

test("规划合同缺失不开始制作；译文与官方模板显式豁免", async () => {
  const c = await setup(); const { qualityContract, ...legacyTask } = task;
  const g = gateway({ planTask: legacyTask });
  try {
    await assert.rejects(runOrchestration(c.cfg, c.store, g, c.input), /qualityContract/);
    assert.equal(g.calls.plans.length, 2); assert.equal(g.calls.writes.length, 0);
    const parsed = Plan.parse({ tasks: [{ ...legacyTask, kind: "translation" }] });
    assert.deepEqual(qualityPlanProblems(parsed, selection, brief), []);
    assert.deepEqual(qualityPlanProblems({ tasks: [legacyTask] }, selection, { ...brief, deliverables: [{ ...item, official_template: "https://example.edu.cn/form.docx" }] }), []);
    assert.match(strategyPrompt(selection), /not_applicable/);
  } finally { await c.close(); }
});

test("图片必须是真实画面证据；软件只能引用本轮已有截图观察", () => {
  const e = { kind: "visual", source: "image:1", location: "画面中部机构连接处", observation: "入口与两个分流槽相连，右侧容量较小" };
  const visualRows = rows().map((r) => ({ ...r, evidence: e }));
  assert.equal(checkedQualityContract(selection, visualRows, { text: "", imageSource: "image:1" }).length, contract.length);
  assert.throws(() => checkedQualityContract(selection, rows(), { text: body, imageSource: "image:1" }), /quote/);
  assert.throws(() => checkedQualityContract(selection, visualRows, { text: body, observations: [] }), /画面证据/);
  const shot = { ...e, source: "screenshot:1" };
  assert.equal(checkedQualityContract(selection, visualRows.map((r) => ({ ...r, evidence: shot })), { text: "", observations: [shot] }).length, contract.length);
  assert.throws(() => checkedQualityContract(selection, visualRows.map((r) => ({ ...r, evidence: { ...e, quote: "假文字" } })), { text: "", imageSource: "image:1" }));
  assert.match(strategyPrompt(selection, "image"), /不要求把 tradeoffs\/validation 全文画在图上/);
  assert.match(strategyPrompt(selection, "software"), /可运行的输入处理输出/);
  assert.match(strategyPrompt(selection, "slides"), /PPT 按页落实/);
});


test("一次结构修复可补齐真实局部证据，不必重做作品", async () => {
  const c = await setup();
  const g = gateway({ review: (_p, calls) => calls.reviews.length === 1 ? {} : { qualityContract: rows() } });
  try {
    const result = await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(result.deliverables[0].rounds, 1);
    assert.equal(g.calls.writes.length, 1); assert.equal(g.calls.reviews.length, 2);
    assert.match(g.calls.reviews[1], /上次验收结构或引用无效/);
  } finally { await c.close(); }
});

test("合同unverified不放行，超长整页quote不是局部证据", async () => {
  assert.throws(() => checkedQualityContract(selection, rows("正文".repeat(250)), { text: "正文".repeat(250) }));
  const c = await setup();
  const g = gateway({ review: () => ({ qualityContract: rows().map((r) => r.id === "strategy.validation.1"
    ? { id: r.id, status: "unverified", reason: "未提供可执行的失败阈值，无法验证此项" } : r) }) });
  try {
    await assert.rejects(runOrchestration(c.cfg, c.store, g, c.input), /仍未通过验收.*unverified/);
    assert.equal(g.calls.reviews.length, 2); assert.equal(g.calls.writes.length, 2);
    assert.ok(!c.store.artifacts(c.input.jobId).some((a) => a.kind === "submission"));
  } finally { await c.close(); }
});
