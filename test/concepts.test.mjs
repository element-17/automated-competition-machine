import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { Brief } from "../dist/core/types.js";
import {
  collectCandidateEvidence,
  compareCandidates,
} from "../dist/workflows/concepts.js";

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
        return JSON.stringify({
          selected: 2,
          analysis: "候选1的机制已出现在来源中，候选2仍需核验",
          similarity_risks: [`候选1重复风险 ${url}`],
        });
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
    assert.equal(searches, 2);
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
    assert.equal(searches, 2);
    assert.equal(fetches, 1);
    const stored = JSON.parse(
      await readFile(
        join(ctx.dir, "jobs", ctx.job, "candidate-evidence.json"),
        "utf8",
      ),
    );
    assert.equal(stored[0].sources[0].url, url);
    assert.match(stored[1].query, /方案2/);
  } finally {
    server.close();
    await ctx.done();
  }
});

test("只剩一个候选时越界选择降级；检索不可用始终保留证据缺口", async () => {
  const ctx = await setup();
  try {
    const g = {
      canSearch: false,
      search: async () => {
        throw Error("不可调用");
      },
      generate: async () =>
        JSON.stringify({
          selected: 3,
          analysis: "不存在的第三个候选",
          similarity_risks: [],
        }),
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
    const result = await compareCandidates(
      ctx.cfg,
      ctx.store,
      g,
      ctx.job,
      ctx.brief,
      ideas.slice(1),
      evidence,
      [],
    );
    assert.equal(result.choice.selected, 1);
    assert.match(result.gaps.join(" "), /原创性尚未核实/);
    assert.match(result.gaps.join(" "), /选择无效/);
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
    assert.equal(queries, 1);
    assert.match(second[0].sources[0].excerpt, /恢复后可读/);
  } finally {
    server.close();
    await ctx.done();
  }
});
