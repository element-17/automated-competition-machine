import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { Brief } from "../dist/core/types.js";
import {
  candidateQueries,
  collectCandidateEvidence,
  compareCandidates,
} from "../dist/workflows/concepts.js";


function conceptReview(prompt, overrides = {}) {
  const lines = prompt.split(String.fromCharCode(10));
  const candidates = JSON.parse(lines.find((l) => l.startsWith("候选：")).slice(3));
  const evidence = JSON.parse(lines.find((l) => l.startsWith("已获取的相似作品资料：")).slice(11));
  const selected = overrides.selected ?? Math.min(2, candidates.length);
  const idea = candidates[selected - 1];
  const check = (idea, field) => ({ status: "passed", basis: { field, quote: idea[field] }, reason: `该${field}包含可执行方案，可结合规则对照检查` });
  const comparisons = candidates.flatMap((left, i) => candidates.slice(i + 1).map((right, offset) => ({
    left: i + 1, right: i + offset + 2, verdict: "distinct",
    leftMechanism: left.mechanism, rightMechanism: right.mechanism,
    mechanismDifference: `${left.mechanism}与${right.mechanism}的处理步骤和行动依据不同`,
    constraintDifference: `${left.audience}与${right.audience}的资源约束不同`,
    validationDifference: `${left.verification}与${right.verification}使用不同对照和失败边界`,
    rewriteCandidate: null, rewriteInstructions: "",
  })));
  return JSON.stringify({
    selected, analysis: "第二个机制适配当前约束，效果尚未实测", similarity_risks: ["往届作品公开不足"],
    strategy: { problem: idea.problem, audience: idea.audience, mechanism: idea.mechanism, differentiators: [idea.mechanism], tradeoffs: ["采样需要时间，效果仍需实测"], validation: [idea.verification], evidenceLimits: ["未核实所有往届作品"] },
    quality: candidates.map((idea, i) => ({ candidate: i + 1, fit: check(idea, "problem"), feasibility: check(idea, "mechanism"), validation: check(idea, "verification") })),
    comparisons,
    sourceComparisons: evidence.map((e) => ({ candidate: e.candidate, status: e.sources.length ? "compared" : "unverified", findings: e.sources.map((source) => ({ url: source.url, quote: source.excerpt, relation: "uncertain", reason: "正文披露的工作机制有限，尚不足判断候选原创性" })), limitations: ["正文没有完整对照实验，无法证明原创"] })),
    ...overrides,
  });
}

const ideas = [1, 2].map((i) => ({
  title: `方案${i}`,
  audience: "学生",
  problem: `问题${i}`,
  mechanism: `机制${i}`,
  verification: "待验证",
  evidence_urls: [],
}));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "concept-evidence-"));
  const store = new Store(dir);
  const cfg = { dataDir: dir };
  const id = store.addCompetition("https://example.org/contest", "竞赛");
  const brief = Brief.parse({ title: "竞赛" });
  store.setBrief(id, brief);
  const job = store.createJob(id, "automatic", {}, 40);
  return {
    dir,
    store,
    cfg,
    id,
    brief,
    job,
    done: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("候选比较读取真实相似作品正文，保留候选与查询映射并复用成功搜索", async () => {
  const ctx = await setup();
  let fetches = 0;
  let searches = 0;
  const server = createServer((req, res) => {
    fetches++;
    res.setHeader("content-type", "text/html");
    res.end(
      "<title>往届作品</title><p>往届作品已采用机制1，无法据此证明方案2原创。</p>",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/work`;
  try {
    const g = {
      search: async (q) => {
        searches++;
        return [{ url, title: "往届作品", snippet: "搜索摘要不是证据" }];
      },
      generate: async (role, prompt) => {
        assert.match(prompt, /往届作品已采用机制1/);
        assert.doesNotMatch(prompt, /搜索摘要不是证据/);
        assert.match(prompt, /1 到 2/);
        return conceptReview(prompt, { analysis: "候选1的机制已出现在来源中，候选2仍需核验", similarity_risks: [`候选1重复风险 ${url}`] });
      },
    };
    const evidence = await collectCandidateEvidence(
      ctx.cfg,
      ctx.store,
      g,
      ctx.job,
      ctx.id,
      ideas,
    );
    assert.deepEqual(
      evidence.map((e) => e.candidate),
      [1, 2],
    );
    assert.equal(fetches, 1);
    assert.equal(searches, 6);
    const result = await compareCandidates(
      ctx.cfg,
      ctx.store,
      g,
      ctx.job,
      ctx.brief,
      ideas,
      evidence,
      [],
    );
    assert.equal(result.choice.selected, 2);
    assert.match(result.gaps.join(" "), /重复风险/);
    await collectCandidateEvidence(
      ctx.cfg,
      ctx.store,
      g,
      ctx.job,
      ctx.id,
      ideas,
    );
    assert.equal(searches, 6);
    assert.equal(fetches, 1);
    const stored = JSON.parse(
      await readFile(
        join(ctx.dir, "jobs", ctx.job, "candidate-evidence.json"),
        "utf8",
      ),
    );
    assert.equal(stored[0].sources[0].url, url);
    assert.match(stored[1].query, /问题2 学生/);
    assert.equal(stored[1].queries.length, 3);
    assert.ok(stored[1].queries.every((q) => q.fingerprint.length === 64));
  } finally {
    server.close();
    await ctx.done();
  }
});

test("没有候选时直接失败，不伪造第一项选择", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      compareCandidates(
        ctx.cfg,
        ctx.store,
        { generate: async () => assert.fail("没有候选不得调用评审") },
        ctx.job,
        ctx.brief,
        [],
        [],
        [],
      ),
      /没有生成候选方案/,
    );
  } finally {
    await ctx.done();
  }
});

test("只剩一个候选时越界选择直接失败；检索不可用保留证据缺口", async () => {
  const ctx = await setup();
  try {
    const g = {
      canSearch: false,
      search: async () => {
        throw Error("不可调用");
      },
      generate: async (_, prompt) =>
        JSON.stringify({ ...JSON.parse(conceptReview(prompt)), selected: 3 }),
    };
    const evidence = await collectCandidateEvidence(
      ctx.cfg,
      ctx.store,
      g,
      ctx.job,
      ctx.id,
      ideas.slice(1),
    );
    assert.equal(evidence[0].candidate, 1);
    assert.equal(evidence[0].title, "方案2");
    assert.equal(evidence[0].searchStatus, "unavailable");
    // 越界选择不再降级取第一个：直接失败，暴露评审输出问题。
    await assert.rejects(
      compareCandidates(
        ctx.cfg,
        ctx.store,
        g,
        ctx.job,
        ctx.brief,
        ideas.slice(1),
        evidence,
        [],
      ),
      /候选方案比较失败/,
    );
  } finally {
    await ctx.done();
  }
});

test("网页读取失败不会拿摘要冒充正文，恢复时重试网页但不重复搜索", async () => {
  const ctx = await setup();
  let okay = false,
    queries = 0;
  const server = createServer((req, res) => {
    if (!okay) {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end("<p>恢复后可读作品正文</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/work`;
  try {
    const g = {
      generate: async () => "",
      search: async () => {
        queries++;
        return [{ url, title: "作品", snippet: "摘要声称绝对原创" }];
      },
    };
    const first = await collectCandidateEvidence(
      ctx.cfg,
      ctx.store,
      g,
      ctx.job,
      ctx.id,
      ideas.slice(0, 1),
    );
    assert.equal(first[0].sources.length, 0);
    assert.equal(first[0].failures.length, 1);
    assert.match(first[0].gaps.join(" "), /没有可读取正文/);
    okay = true;
    const second = await collectCandidateEvidence(
      ctx.cfg,
      ctx.store,
      g,
      ctx.job,
      ctx.id,
      ideas.slice(0, 1),
    );
    assert.equal(queries, 3);
    assert.match(second[0].sources[0].excerpt, /恢复后可读/);
  } finally {
    server.close();
    await ctx.done();
  }
});

test("主要关键词不依赖自造标题且更名不改变主要查询", () => {
  const first = candidateQueries(ideas[0]);
  const renamed = candidateQueries({ ...ideas[0], title: "炫酷独创宇宙平台" });
  assert.deepEqual(first.slice(0, 2), renamed.slice(0, 2));
  assert.ok(first[0].includes(ideas[0].problem));
  assert.ok(first[0].includes(ideas[0].audience));
  assert.ok(first[1].includes(ideas[0].mechanism));
  assert.doesNotMatch(first.slice(0, 2).join(" "), /方案1/);
});

test("搜索预算异常必须传播，不能作为无结果继续", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(collectCandidateEvidence(ctx.cfg, ctx.store, { search: async () => { throw Error("调用预算耗尽"); } }, ctx.job, ctx.id, ideas.slice(0, 1)), /预算耗尽/);
  } finally { await ctx.done(); }
});

test("每候选最多四篇正文，重定向成功和评审在恢复后不重复调用", async () => {
  const ctx = await setup();
  let searches = 0, fetches = 0, reviews = 0;
  const server = createServer((req, res) => {
    fetches++;
    if (req.url.startsWith("/alias/")) { res.writeHead(302, { location: req.url.replace("/alias/", "/actual/") }); res.end(); return; }
    res.setHeader("content-type", "text/html");
    res.end("<p>固定规则分流与反馈调整是不同处理过程</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gateway = { search: async () => { searches++; return Array.from({ length: 8 }, (_, i) => ({ url: `${base}/alias/${i}`, title: `作品${i}`, snippet: "不作证据" })); }, generate: async (_, prompt) => { reviews++; return conceptReview(prompt); } };
  try {
    const first = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas);
    assert.ok(first.every((e) => e.sources.length === 4));
    assert.equal(fetches, 8);
    await compareCandidates(ctx.cfg, ctx.store, gateway, ctx.job, ctx.brief, ideas, first, []);
    const second = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas);
    await compareCandidates(ctx.cfg, ctx.store, gateway, ctx.job, ctx.brief, ideas, second, []);
    assert.equal(fetches, 8);
    assert.equal(searches, 6);
    assert.equal(reviews, 1);
    const changed = [ideas[0], { ...ideas[1], mechanism: "新的对照推演机制" }];
    const third = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, changed, second);
    assert.equal(third[0], second[0]);
    assert.notEqual(third[1].fingerprint, second[1].fingerprint);
    assert.equal(searches, 7);
    assert.equal(fetches, 8);
  } finally { server.close(); await ctx.done(); }
});

test("搜索和评审暂停异常原样传播，不转为失败证据或重写", async () => {
  const ctx = await setup();
  const { JobControlError } = await import("../dist/core/job-control.js");
  const pause = new JobControlError("pause");
  try {
    await assert.rejects(collectCandidateEvidence(ctx.cfg, ctx.store, { search: async () => { throw pause; } }, ctx.job, ctx.id, ideas), (error) => error === pause);
    const evidence = await collectCandidateEvidence(ctx.cfg, ctx.store, { search: async () => [] }, ctx.job, ctx.id, ideas);
    await assert.rejects(compareCandidates(ctx.cfg, ctx.store, { generate: async () => { throw pause; } }, ctx.job, ctx.brief, ideas, evidence, []), (error) => error === pause);
  } finally { await ctx.done(); }
});
