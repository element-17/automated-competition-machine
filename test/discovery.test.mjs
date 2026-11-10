import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { OfficialGateway } from "../dist/core/gateway.js";
import {
  discoverCompetitions,
  competitionKey,
  plannedQueries,
  builtinQueries,
  SCREEN_RECORD,
  screenResults,
  SCREEN_RECHECK_MS,
  SCREEN_FAILURE_COOLDOWN_MS,
} from "../dist/competition/discovery.js";
import { saveSearchConfig, searchDefaults } from "../dist/core/config.js";

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "discovery-"));
  return { dir, store: new Store(dir) };
}

test("SearXNG 发现搜索按配置翻页并带时间范围和语言", async () => {
  const { dir, store } = await temp();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    seen.push(u);
    const page = Number(u.searchParams.get("pageno"));
    return new Response(
      JSON.stringify({
        results:
          page <= 2
            ? [{ url: `https://a.edu.cn/${page}`, title: "比赛", content: "" }]
            : [],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    const cfg = {
      search: {
        ...searchDefaults,
        provider: "searxng",
        url: "http://127.0.0.1:1",
        pages: 3,
        timeRange: "month",
      },
    };
    const g = new OfficialGateway(cfg);
    const rs = await g.search("赛事", { pages: 3, timeRange: "month" });
    assert.equal(rs.length, 2);
    assert.deepEqual(
      seen.map((u) => u.searchParams.get("pageno")),
      ["1", "2", "3"],
    );
    assert.equal(seen[0].searchParams.get("time_range"), "month");
    assert.equal(seen[0].searchParams.get("language"), "zh-CN");
    seen.length = 0;
    await g.search("研究");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].searchParams.get("time_range"), null);
  } finally {
    globalThis.fetch = original;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SearXNG 未开启 JSON 时给出配置提示", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("forbidden", { status: 403 });
  try {
    await assert.rejects(
      new OfficialGateway({
        search: { provider: "searxng", url: "http://127.0.0.1:1" },
      }).search("x"),
      /search\.formats/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("内置搜索词轮换，自定义搜索词每次都使用", async () => {
  const { dir, store } = await temp();
  try {
    const settings = {
      ...searchDefaults,
      queriesPerRun: 4,
      queries: ["自定义 摄影大赛"],
    };
    const first = plannedQueries(store, settings, 2026);
    assert.equal(first.length, 4);
    assert.equal(first[0], "自定义 摄影大赛");
    for (const q of first) store.search(null, q, []);
    const second = plannedQueries(store, settings, 2026);
    assert.equal(second[0], "自定义 摄影大赛");
    assert.ok(second.slice(1).every((q) => !first.includes(q)));
    assert.ok(builtinQueries(2026).length >= 20);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("每个网站每次新增数量有上限，已收录赛事不占名额", async () => {
  const { dir, store } = await temp();
  try {
    const big = Array.from({ length: 10 }, (_, i) => ({
      url: `https://big.edu.cn/n${i}`,
      title: `校内创新比赛${i}通知`,
      snippet: "",
    }));
    const other = {
      url: "https://other.org/a",
      title: "设计大赛征集",
      snippet: "",
    };
    const g = { search: async () => [...big, other], generate: async () => "" };
    const ids = await discoverCompetitions(store, g, "比赛", [], {
      perHost: 3,
    });
    assert.equal(ids.length, 4);
    assert.ok(
      ids.some((id) => store.competition(id).url.includes("other.org")),
    );
    const again = await discoverCompetitions(store, g, "比赛", [], {
      perHost: 3,
    });
    assert.equal(again.length, 7);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("不同学校转发的同一届赛事只收录一条", async () => {
  assert.equal(
    competitionKey(
      "关于举办第18届全国大学生广告艺术大赛 安徽理工大学校级选拔赛的通知",
    ),
    competitionKey("第十八届全国大学生广告艺术大赛江苏理工学院校赛通知"),
  );
  assert.notEqual(
    competitionKey("第18届全国大学生广告艺术大赛"),
    competitionKey("第19届全国大学生广告艺术大赛"),
  );
  assert.equal(competitionKey("2026 大学生设计大赛征集"), null);
  const { dir, store } = await temp();
  try {
    const g = {
      search: async () => [
        {
          url: "https://a.edu.cn/1",
          title: "关于举办第18届全国大学生广告艺术大赛校级选拔赛的通知",
          snippet: "",
        },
        {
          url: "https://b.edu.cn/2",
          title: "第十八届全国大学生广告艺术大赛 校内赛",
          snippet: "",
        },
      ],
      generate: async () => "",
    };
    assert.equal((await discoverCompetitions(store, g, "广告")).length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("搜索结果评估按批调用评审模型，剔除明显无关结果并记录理由", async () => {
  const { dir, store } = await temp();
  try {
    const results = Array.from({ length: 25 }, (_, i) => ({
      url: `https://s${i}.edu.cn/a`,
      title: i === 3 ? "某大赛百科词条比赛" : `第${i}场创新比赛通知`,
      snippet: "",
    }));
    const calls = [];
    const g = {
      search: async () => results,
      generate: async (role, prompt, agent) => {
        calls.push({ role, agent });
        const items = JSON.parse(prompt.slice(prompt.lastIndexOf("\n[") + 1));
        return JSON.stringify(
          items.map((x) => ({
            i: x.i,
            keep: !x.title.includes("百科"),
            reason: x.title.includes("百科") ? "百科词条" : "",
          })),
        );
      },
    };
    const ids = await discoverCompetitions(store, g, "比赛", [], {
      perHost: 50,
    });
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every((c) => c.role === "reviewer" && c.agent === "screener"),
    );
    assert.equal(ids.length, 24);
    assert.ok(ids.every((id) => !store.competition(id).title.includes("百科")));
    const rec = store.searches(null).find((x) => x.query === SCREEN_RECORD);
    const data = JSON.parse(rec.results);
    assert.equal(data.checked, 25);
    assert.equal(data.dropped[0].reason, "百科词条");
    calls.length = 0;
    await discoverCompetitions(store, g, "比赛", [], { perHost: 50 });
    assert.equal(calls.length, 0, "已收录的结果不重复评估");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("评估失败只保留未审核候选，关闭初筛也不代表正式通过", async () => {
  const { dir, store } = await temp();
  try {
    const results = [
      { url: "https://a.edu.cn/1", title: "创新比赛通知", snippet: "" },
      { url: "https://b.edu.cn/2", title: "设计大赛征集", snippet: "" },
    ];
    const broken = {
      search: async () => results,
      generate: async () => {
        throw Error("第二模型调用失败：网络错误");
      },
    };
    const ids = await discoverCompetitions(store, broken, "比赛");
    assert.equal(ids.length, 2);
    const rec = store.searches(null).find((x) => x.query === SCREEN_RECORD);
    assert.match(rec.error, /未审核候选/);
    const data = JSON.parse(rec.results);
    assert.equal(data.checked, 0);
    assert.equal(data.unreviewed.length, 2);
    assert.ok(data.decisions.every((d) => d.status === "unreviewed"));
    for (const id of ids) store.addCandidate(id);
    assert.ok(store.queue().every((q) => q.state === "candidate" && q.reviewStatus === "unreviewed"));
    assert.deepEqual(new Set(store.queueReviewCandidates(10).map((q) => q.competitionId)), new Set(ids));
    store.acquireWorker("discovery-test", 60_000);
    assert.equal(store.claimQueue("discovery-test", 10), null);
    store.releaseWorker("discovery-test");
    const { dir: d2, store: s2 } = await temp();
    try {
      let called = 0;
      const g = {
        search: async () => results,
        generate: async () => {
          called++;
          return "[]";
        },
      };
      assert.equal(
        (await discoverCompetitions(s2, g, "比赛", [], { screen: false }))
          .length,
        2,
      );
      assert.equal(called, 0);
    } finally {
      s2.close();
      await rm(d2, { recursive: true, force: true });
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const lastScreen = (store) => JSON.parse(store.searches(null).filter((r) => r.query === SCREEN_RECORD).at(-1).results);
const screenItems = (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf("\n[") + 1));

test("剔除结果同次去重，近期复用不延长有效期，到期重新评估", async (t) => {
  const { dir, store } = await temp();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T00:00:00Z") });
  try {
    const item = { url: "https://a.edu.cn/reused", title: "设计大赛通知", snippet: "尚未开放报名" };
    let calls = 0, keep = false;
    const g = { search: async () => [item, { ...item, url: `${item.url}#top` }],
      generate: async (_role, prompt) => {
        calls++;
        assert.equal(screenItems(prompt).length, 1);
        return JSON.stringify([{ i: 0, keep, reason: keep ? "现已开放" : "尚未开始本届征集" }]);
      } };
    assert.equal((await discoverCompetitions(store, g, "比赛")).length, 0);
    const initial = lastScreen(store).decisions[0];
    assert.match(initial.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(initial.recheckReason, "first_seen");
    t.mock.timers.tick(SCREEN_RECHECK_MS - 1);
    assert.equal((await discoverCompetitions(store, g, "比赛")).length, 0);
    assert.equal(calls, 1);
    assert.equal(lastScreen(store).decisions[0].checkedAt, initial.checkedAt);
    t.mock.timers.tick(1);
    keep = true;
    assert.equal((await discoverCompetitions(store, g, "比赛")).length, 1);
    assert.equal(calls, 2);
    assert.equal(lastScreen(store).decisions[0].recheckReason, "expired");
    assert.equal(lastScreen(store).decisions[0].status, "retained");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("同 URL 标题或摘要变化重评，空白变化与近期相同指纹不重复调用", async () => {
  const { dir, store } = await temp();
  try {
    const item = { url: "https://a.edu.cn/changed", title: "设计大赛 通知", snippet: "旧届征集已结束" };
    let calls = 0;
    const g = { generate: async (_role, prompt) => {
      calls++;
      return JSON.stringify(screenItems(prompt).map(({ i }) => ({ i, keep: false, reason: "尚非当前有效公告" })));
    } };
    await screenResults(store, g, [item, item]);
    const initial = lastScreen(store).decisions[0].fingerprint;
    await screenResults(store, g, [{ ...item, title: " 设计大赛  通知 " }]);
    assert.equal(calls, 1);
    const changed = { ...item, snippet: "新增本届报名时间" };
    await screenResults(store, g, [changed]);
    assert.equal(calls, 2);
    assert.notEqual(lastScreen(store).decisions[0].fingerprint, initial);
    assert.equal(lastScreen(store).decisions[0].recheckReason, "content_changed");
    await screenResults(store, g, [changed]);
    await screenResults(store, g, [item]);
    assert.equal(calls, 2, "近期各内容版本均可复用");
    await screenResults(store, g, [{ ...changed, title: "新一届设计大赛通知" }]);
    assert.equal(calls, 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧剔除记录没有时间或指纹时保守重评并取代旧决定", async () => {
  const { dir, store } = await temp();
  try {
    const item = { url: "https://a.edu.cn/legacy", title: "创新比赛通知", snippet: "新一届正在报名" };
    store.search(null, SCREEN_RECORD, { checked: 1, dropped: [{ url: item.url, reason: "旧信息" }] });
    let calls = 0;
    const g = { generate: async () => { calls++; return JSON.stringify([{ i: 0, keep: true, reason: "当前公告" }]); } };
    assert.equal((await screenResults(store, g, [item])).size, 0);
    assert.equal(lastScreen(store).decisions[0].recheckReason, "legacy_record");
    assert.equal((await screenResults(store, g, [item])).size, 0);
    assert.equal(calls, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("空数组、漏项、重复及越界序号均记为整批未审核，不默认通过", async () => {
  const { dir, store } = await temp();
  try {
    const responses = [[], [{ i: 0, keep: false }],
      [{ i: 0, keep: false }, { i: 0, keep: true }],
      [{ i: 0, keep: false }, { i: 2, keep: true }],
      [{ i: -1, keep: false }, { i: 1, keep: true }]];
    for (let n = 0; n < responses.length; n++) {
      const items = [0, 1].map((i) => ({ url: `https://a.edu.cn/invalid-${n}-${i}`, title: "比赛通知", snippet: "" }));
      const rejected = await screenResults(store, { generate: async () => JSON.stringify(responses[n]) }, items);
      assert.equal(rejected.size, 0);
      const rec = lastScreen(store);
      assert.equal(rec.checked, 0);
      assert.equal(rec.unreviewed.length, 2);
      assert.ok(rec.decisions.every((d) => d.status === "unreviewed"));
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("初筛失败冷却后可重试，未调用的后续批次明确标记未审核", async (t) => {
  const { dir, store } = await temp();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-10T00:00:00Z") });
  try {
    const items = Array.from({ length: 3 }, (_, i) => ({ url: `https://a.edu.cn/failure-${i}`, title: "比赛通知", snippet: "" }));
    let calls = 0, fail = true;
    const g = { generate: async (_role, prompt) => {
      calls++;
      if (fail) throw Error("模型调用失败");
      return JSON.stringify(screenItems(prompt).map(({ i }) => ({ i, keep: false, reason: "无有效公告" })));
    } };
    await screenResults(store, g, items, 2);
    assert.equal(calls, 1);
    assert.equal(lastScreen(store).attempted, 2);
    assert.equal(lastScreen(store).unreviewed.length, 3);
    assert.match(lastScreen(store).unreviewed[2].reason, /未执行/);
    await screenResults(store, g, items, 2);
    assert.equal(calls, 1);
    assert.equal(lastScreen(store).checked, 0);
    t.mock.timers.tick(SCREEN_FAILURE_COOLDOWN_MS);
    fail = false;
    assert.equal((await screenResults(store, g, items, 2)).size, 3);
    assert.equal(calls, 3);
    assert.equal(lastScreen(store).checked, 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("保存搜索设置只改写 search 与 sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-cfg-"));
  const file = join(dir, "config.json");
  try {
    await writeFile(
      file,
      JSON.stringify({ maxCalls: 20, search: { provider: "sources" } }),
    );
    saveSearchConfig(
      file,
      { ...searchDefaults, provider: "searxng", url: "http://127.0.0.1:8080" },
      ["https://a.edu.cn/list"],
    );
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.maxCalls, 20);
    assert.equal(saved.search.provider, "searxng");
    assert.deepEqual(saved.sources, ["https://a.edu.cn/list"]);
    assert.throws(
      () =>
        saveSearchConfig(file, { ...searchDefaults, provider: "searxng" }, []),
      /search\.url/,
    );
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).search.url,
      "http://127.0.0.1:8080",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
