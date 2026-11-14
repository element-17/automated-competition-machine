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
  relevantExcerpt,
} from "../dist/workflows/concepts.js";


function conceptReview(_prompt, overrides = {}) {
  return JSON.stringify({ selected: 2, analysis: "第二个机制适配当前约束，效果尚未实测", similarity_risks: ["往届作品公开不足"], ...overrides });
}

/**
 * 关键词抽取提示词的固定回答：让测试实际走模型抽取的关键词路径。
 * 关键词要随 mechanism 变化，否则改了机制仍会命中同一批缓存查询，测不出重查行为。
 */
const keywordReply = (prompt) => {
  const title = /"title":"([^"]*)"/.exec(prompt)?.[1] || "作品";
  const mechanism = /"mechanism":"([^"]*)"/.exec(prompt)?.[1] || "";
  return JSON.stringify({
    keywords: [`${title}相关对象`, mechanism ? `${mechanism}方法` : `${title}相关方法`, "校园场景"],
  });
};
const isKeywordPrompt = (prompt) => prompt.includes("抽取") && prompt.includes("keywords");

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
        if (isKeywordPrompt(prompt)) return keywordReply(prompt);
        if (isKeywordPrompt(prompt)) return keywordReply(prompt);
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
    assert.equal(searches, 4);
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
    assert.equal(searches, 4);
    assert.equal(fetches, 1);
    const stored = JSON.parse(
      await readFile(
        join(ctx.dir, "jobs", ctx.job, "candidate-evidence.json"),
        "utf8",
      ),
    );
    assert.equal(stored[0].sources[0].url, url);
    // 查询来自关键词抽取，必须包含该候选自己的内容，而不是别的候选。
    assert.match(stored[1].query, /方案2/);
    assert.equal(stored[1].queries.length, 2);
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
        isKeywordPrompt(prompt)
          ? keywordReply(prompt)
          : JSON.stringify({ ...JSON.parse(conceptReview(prompt)), selected: 3 }),
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
      generate: async (_, prompt) =>
        isKeywordPrompt(prompt) ? keywordReply(prompt) : "",
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
    assert.equal(queries, 2);
    assert.match(second[0].sources[0].excerpt, /恢复后可读/);
  } finally {
    server.close();
    await ctx.done();
  }
});

test("主要关键词不依赖自造标题且更名不改变主要查询", () => {
  // 用真实方案内容；占位词（问题1/机制1）本就该被过滤，不发无意义查询。
  const idea = {
    title: "方案1",
    audience: "校园服务窗口的排队学生",
    problem: "材料不齐的申请占用窗口时间",
    mechanism: "纸质清单核验材料后按等候时间重排队列",
    verification: "对照记录平均等待分钟数",
    evidence_urls: [],
  };
  const first = candidateQueries(idea);
  const renamed = candidateQueries({ ...idea, title: "炫酷独创宇宙平台" });
  assert.deepEqual(first, renamed, "更名不影响检索词");
  assert.ok(first.length >= 1);
  assert.doesNotMatch(first.join(" "), /炫酷独创宇宙平台/);
  // 泛词与单字不得进入查询。
  assert.doesNotMatch(first.join(" "), /(?:^|\s)(?:市|装置|传统|借鉴|方案|系统)(?:\s|$)/);
  // 纯占位内容不产生查询，避免抓取必然 403 的百科词条。
  assert.deepEqual(candidateQueries(ideas[0]), []);
});

test("搜索预算异常必须传播，不能作为无结果继续", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(collectCandidateEvidence(ctx.cfg, ctx.store, {
      search: async () => { throw Error("调用预算耗尽"); },
      generate: async (_, prompt) => keywordReply(prompt),
    }, ctx.job, ctx.id, ideas.slice(0, 1)), /预算耗尽/);
  } finally { await ctx.done(); }
});

test("每候选最多三篇正文，重定向成功和评审在恢复后不重复调用", async () => {
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
  const gateway = { search: async () => { searches++; return Array.from({ length: 8 }, (_, i) => ({ url: `${base}/alias/${i}`, title: `作品${i}`, snippet: "不作证据" })); }, generate: async (_, prompt) => isKeywordPrompt(prompt) ? keywordReply(prompt) : (reviews++, conceptReview(prompt)) };
  try {
    const first = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas);
    assert.ok(first.every((e) => e.sources.length === 3));
    assert.equal(fetches, 6);
    await compareCandidates(ctx.cfg, ctx.store, gateway, ctx.job, ctx.brief, ideas, first, []);
    const second = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas);
    await compareCandidates(ctx.cfg, ctx.store, gateway, ctx.job, ctx.brief, ideas, second, []);
    assert.equal(fetches, 6);
    assert.equal(searches, 4);
    assert.equal(reviews, 1);
    const changed = [ideas[0], { ...ideas[1], mechanism: "新的对照推演机制" }];
    const third = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, changed, second);
    assert.equal(third[0], second[0]);
    assert.notEqual(third[1].fingerprint, second[1].fingerprint);
    // 改过的候选有新的关键词，两条查询都要重查（旧的 4 条已缓存）。
    assert.equal(searches, 6);
    assert.equal(fetches, 6);
  } finally { server.close(); await ctx.done(); }
});

test("搜索和评审暂停异常原样传播，不转为失败证据或重写", async () => {
  const ctx = await setup();
  const { JobControlError } = await import("../dist/core/job-control.js");
  const pause = new JobControlError("pause");
  try {
    await assert.rejects(collectCandidateEvidence(ctx.cfg, ctx.store, { search: async () => { throw pause; }, generate: async (_, prompt) => keywordReply(prompt) }, ctx.job, ctx.id, ideas), (error) => error === pause);
    const evidence = await collectCandidateEvidence(ctx.cfg, ctx.store, { search: async () => [] }, ctx.job, ctx.id, ideas);
    await assert.rejects(compareCandidates(ctx.cfg, ctx.store, { generate: async () => { throw pause; } }, ctx.job, ctx.brief, ideas, evidence, []), (error) => error === pause);
  } finally { await ctx.done(); }
});

test("正文后段的机制可以找到，摘录记录原文区间和截断状态", () => {
  const text = ("赛事背景和历史沿革，以下是宣传性文字。".repeat(100) + "\n").repeat(6) + "仅两个离线窗口：按人工核验优先级重排队列，记录等候时间与错分率。";
  const excerpt = relevantExcerpt(text, { ...ideas[0], problem: "排队耗时", audience: "两个离线窗口", mechanism: "按人工核验优先级重排队列" });
  assert.match(excerpt.excerpt, /按人工核验优先级重排队列/);
  assert.ok(excerpt.ranges.some((range) => range.start > 6000));
  assert.equal(excerpt.originalLength, text.length);
  assert.equal(excerpt.truncated, true);
  assert.equal(excerpt.excerpt, excerpt.ranges.map((r) => text.slice(r.start, r.end)).join("\n[…]\n"));
  assert.ok(excerpt.excerpt.length < 6000);
  assert.equal(relevantExcerpt("完整短正文", ideas[0]).truncated, false);
});

test("无来源与不确定不阻塞最小选择；未变化的恢复不重复调用", async () => {
  const ctx = await setup();
  let searches = 0, reviews = 0;
  const gateway = { search: async () => { searches++; return []; }, generate: async (_, prompt) => isKeywordPrompt(prompt) ? keywordReply(prompt) : (reviews++, JSON.stringify({ selected: 2, analysis: "来源未获取，差异 uncertain；仍选择适合场景的方案2" })) };
  try {
    const first = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas);
    const selected = await compareCandidates(ctx.cfg, ctx.store, gateway, ctx.job, ctx.brief, ideas, first);
    assert.equal(selected.choice.selected, 2);
    assert.equal(selected.choice.strategy, undefined);
    const second = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas);
    await compareCandidates(ctx.cfg, ctx.store, gateway, ctx.job, ctx.brief, ideas, second);
    assert.equal(searches, 4);
    assert.equal(reviews, 1);
    assert.match(selected.gaps.join(" "), /比较范围有限/);
  } finally { await ctx.done(); }
});

test("旧空结果过期后可重查，即使传入旧候选证据", async () => {
  const ctx = await setup();
  let searches = 0;
  const gateway = { search: async () => { searches++; return []; }, generate: async (_, prompt) => keywordReply(prompt) };
  try {
    const first = await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas);
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    ctx.store.db.prepare("UPDATE searches SET searched_at = ?").run(old);
    first.forEach((e) => e.collectedAt = old);
    await collectCandidateEvidence(ctx.cfg, ctx.store, gateway, ctx.job, ctx.id, ideas, first);
    assert.equal(searches, 8);
  } finally { await ctx.done(); }
});

test("比较解析失败显式失败，不默认首项；评审预算异常传播", async () => {
  const ctx = await setup();
  try {
    for (const output of ["not JSON", '{"analysis":"missing selected"}', '{"selected":0,"analysis":"invalid"}'])
      await assert.rejects(compareCandidates(ctx.cfg, ctx.store, { generate: async () => output }, ctx.job, ctx.brief, ideas, []), /候选方案比较失败/);
    const error = Error("调用预算耗尽");
    await assert.rejects(compareCandidates(ctx.cfg, ctx.store, { generate: async () => { throw error; } }, ctx.job, ctx.brief, ideas, []), (e) => e === error);
  } finally { await ctx.done(); }
});
