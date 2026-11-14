import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Store } from "../dist/core/store.js";

// 与 layout-check 回归测试相同，仅替换该模块捕获的渲染器，不依赖本机 Office。
let renderer;
const originalExec = childProcess.execFile;
const fakeExec = () => { throw Error("expected promisified exec"); };
fakeExec[promisify.custom] = (...args) => renderer(...args);
childProcess.execFile = fakeExec;
syncBuiltinESMExports();
await import("../dist/artifacts/layout-check.js");
childProcess.execFile = originalExec;
syncBuiltinESMExports();
const { Plan, runOrchestration, strategyPrompt } = await import("../dist/workflows/orchestrator.js");

const idea = { title: "离线调度", problem: "低资源排队", audience: "社区志愿者", mechanism: "按等待时间与容量逐项分配", verification: "与先到先服务对比", evidence_urls: [] };
const selection = { selected: 1, analysis: "适合有限人工", strategy: {
  problem: idea.problem, audience: idea.audience, mechanism: idea.mechanism,
  differentiators: ["容量满后优先保留等待最久者"], tradeoffs: ["牺牲即时吞吐以保证等待公平"],
  validation: ["与先到先服务用同组输入比较等待时长"], evidenceLimits: ["没有全网原创性比较和真实实验记录"],
} };
const body = "社区志愿者处理低资源排队，按等待时间与容量逐项分配。容量满后优先保留等待最久者，牺牲即时吞吐以保证等待公平。验证计划以同组输入对比先到先服务的等待时长，超过三轮未服务为失败。";
const task = { id: "report", deliverable: 0, title: "报告", kind: "document", format: "txt", instructions: "完整报告正文", acceptance: ["内容完整"] };
const item = { type: "方案报告", formats: ["txt"], quantity: null, limits: [], naming: null, attachments: [], submission: null, official_template: null };
const brief = { title: "机制设计赛", edition: "2026", eligibility: null, deadline: null, ai_rules: null, scoring: null, deliverables: [item], requires_idea: true, missing: [], citations: [], research: { past_winners: [], past_works: [], judging: [], missing: [] } };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "creative-quality-"));
  const store = new Store(dir);
  const cfg = { dataDir: dir, execution: { productionRounds: 2, plannerRounds: 2 }, writer: { providerID: "google", id: "gemini-test" }, reviewer: { providerID: "anthropic", id: "claude-test" }, maxCalls: 40, sources: [], profile: {} };
  const competitionId = store.addCompetition("https://example.edu.cn/contest", "机制设计赛");
  store.setBrief(competitionId, brief);
  const jobId = store.createJob(competitionId, "automatic", {}, 40);
  return { dir, store, cfg, input: { competitionId, jobId, idea, selection }, close: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}
function gateway({ review, output = () => body, planTask = task } = {}) {
  const calls = { plans: [], writes: [], reviews: [], layouts: [] };
  return { calls, search: async () => [], inspectImage: async (prompt) => {
    calls.layouts.push(prompt);
    return JSON.stringify({ issues: [], suggestions: [] });
  }, generate: async (_role, prompt) => {
    if (prompt.includes("拆解成可以实际制作的文件任务")) { calls.plans.push(prompt); return JSON.stringify({ tasks: [planTask] }); }
    if (prompt.includes("任务：作品验收")) {
      calls.reviews.push(prompt);
      return JSON.stringify({ issues: [], criteria: [{ criterion: 0, status: "passed", evidence: "实际正文完整" }], ...review?.(prompt, calls) });
    }
    if (prompt.includes("直接创作")) { calls.writes.push(prompt); return JSON.stringify({ kind: "text", title: "报告", text: output(calls), sources: [], needs_input: [] }); }
    throw Error(`unexpected prompt ${prompt.slice(0, 60)}`);
  } };
}

test("strategy 仅为可选创作 brief，普通 plan/review 完成且不要求原创证明", async () => {
  for (const value of [selection, { selected: 1, analysis: "适合创作" }, { strategy: {} }, undefined]) {
    const c = await setup();
    const g = gateway({ review: () => ({ suggestions: ["可进一步比较同类方案，原创性尚未核实"] }) });
    try {
      const input = { ...c.input, selection: value };
      const result = await runOrchestration(c.cfg, c.store, g, input);
      assert.equal(result.deliverables[0].status, "submission");
      assert.equal(g.calls.writes.length, 1);
      assert.equal(g.calls.reviews.length, 1);
      assert.match(g.calls.reviews[0], /没有来源、未覆盖外部作品或原创性未知本身不是缺陷/);
      assert.match(g.calls.reviews[0], /事实主张仍须有真实资料支持/);
      for (const prompt of [...g.calls.plans, ...g.calls.writes, ...g.calls.reviews])
        assert.doesNotMatch(prompt, /qualityContract|strategy\.differentiators|\[L\d+\]|observations:/);
      await runOrchestration(c.cfg, c.store, g, input);
      assert.equal(g.calls.writes.length, 1);
      assert.equal(g.calls.reviews.length, 1);
    } finally { await c.close(); }
  }
});

test("brief 只取至多三个特色并适配媒介，旧计划额外字段可读但不再校验合同", () => {
  const prompt = strategyPrompt({ strategy: { ...selection.strategy, differentiators: ["特点甲", "特点乙", "特点丙", "特点丁"] } }, "image");
  assert.match(prompt, /特点丙/);
  assert.doesNotMatch(prompt, /特点丁|全网原创性比较|validation/);
  assert.match(prompt, /不强塞文字或多格/);
  assert.equal(strategyPrompt(selection, "translation"), "");
  assert.match(strategyPrompt(selection, "software"), /可运行的输入处理输出与交互/);
  assert.equal(Plan.parse({ tasks: [{ ...task, qualityContract: [{ id: "obsolete", implementation: "旧约定" }] }] }).tasks[0].qualityContract, undefined);
});

test("实际核心机制只有口号仍返工，修复后通过同一内容评审", async () => {
  const c = await setup();
  const issue = "正文只有公平高效口号，缺少容量满时的排队分配规则，请补齐具体规则";
  const g = gateway({ output: (calls) => calls.writes.length === 1 ? "本方案创新独特，公平高效。" : body,
    review: (_p, calls) => calls.writes.length === 1 ? { issues: [issue] } : {} });
  try {
    const result = await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(result.deliverables[0].rounds, 2);
    assert.equal(g.calls.reviews.length, 2);
    assert.ok(g.calls.writes[1].includes(issue));
    assert.match(await readFile(result.deliverables[0].artifactPaths[0], "utf8"), /容量满后优先保留等待最久者/);
  } finally { await c.close(); }
});

test("本地长匹配进入正常评审，合理引用不直接阻塞或要求重写", async () => {
  const c = await setup();
  const quote = Array.from({ length: 450 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
  c.store.putEvidence({ id: "reuse-source", competitionId: c.input.competitionId,
    url: "https://example.edu.cn/prior-work", title: "引用的规则原文", text: quote,
    kind: "novelty", fetchedAt: new Date().toISOString() });
  const g = gateway({ output: () => `以下引用规则原文（来源：https://example.edu.cn/prior-work）：\n“${quote}”\n${body}` });
  try {
    const result = await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(result.deliverables[0].status, "submission");
    assert.equal(g.calls.writes.length, 1);
    assert.equal(g.calls.reviews.length, 1);
    assert.match(g.calls.reviews[0], /本地文字复用风险摘要/);
    assert.ok(g.calls.reviews[0].includes(quote.slice(0, 100)));
    const reports = JSON.parse(await readFile(join(c.dir, "jobs", c.input.jobId, "text-reuse.json"), "utf8"));
    assert.ok(reports[0].report.matches.length > 0, "必须保留自动匹配风险");
    assert.notEqual(reports[0].report.status, "clear");
  } finally { await c.close(); }
});

test("有 strategy 时内容通过后版面中断可恢复；已存内容和版面不重评，文件改动使收据失效", async () => {
  const c = await setup();
  const g = gateway({ planTask: { ...task, format: "docx" } });
  c.store.setBrief(c.input.competitionId, { ...brief, deliverables: [{ ...item, formats: ["docx"] }] });
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();
  renderer = async (_command, args) => {
    if (args[0] === "--version" || args[0] === "close") return { stdout: "ok", stderr: "" };
    if (args[2] === "stats") return { stdout: "Pages: 1", stderr: "" };
    if (args[2] === "screenshot") { await writeFile(args[args.indexOf("-o") + 1], png); return { stdout: "", stderr: "" }; }
    throw Error(`unexpected command ${args}`);
  };
  const { renderers } = await import("../dist/artifacts/doc-render.js");
  const { readSource } = await import("../dist/competition/sources.js");
  renderers.docx = async (file) => ({ pages: 1, text: [await readSource(file).catch(() => "")],
    png: async () => png, dispose: async () => {} });
  const inspect = g.inspectImage;
  let interrupt = true;
  g.inspectImage = async (prompt) => {
    if (interrupt) throw Error("模型调用预算耗尽");
    return inspect(prompt);
  };
  try {
    await assert.rejects(runOrchestration(c.cfg, c.store, g, c.input), /预算/);
    const folder = join(c.dir, "jobs", c.input.jobId);
    const statePath = join(folder, (await readdir(folder)).find((name) => name.endsWith("-r1-state.json")));
    const savedContent = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(savedContent.review.pass, true);
    assert.equal(savedContent.review.visual, false);
    interrupt = false;
    const result = await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(result.deliverables[0].status, "submission");
    assert.equal(g.calls.writes.length, 1);
    assert.equal(g.calls.reviews.length, 1, "恢复只补未完成的版面验收");
    assert.equal(g.calls.layouts.length, 1);
    const completed = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(completed.review.visual, true);
    completed.review.qualityContract = [{ id: "obsolete", status: "unverified" }];
    await writeFile(statePath, JSON.stringify(completed));
    await rm(join(folder, "orchestration.json"));
    await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(g.calls.reviews.length, 1, "轮次检查点可含旧额外字段，不触发内容重评");
    assert.equal(g.calls.layouts.length, 1, "已有通过的版面结论无需重评");
    await writeFile(result.deliverables[0].artifactPaths[0], "损坏文件");
    await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(g.calls.reviews.length, 2, "实际文件变化后重新验收");
    assert.equal(g.calls.layouts.length, 2);
    c.input.selection = { ...selection, strategy: { ...selection.strategy, mechanism: "先按等待时长排序，再分配剩余容量" } };
    await runOrchestration(c.cfg, c.store, g, c.input);
    assert.equal(g.calls.plans.length, 2, "创作输入变化后计划缓存失效");
    assert.equal(g.calls.writes.length, 2);
    assert.equal(g.calls.reviews.length, 3);
  } finally { await c.close(); }
});
