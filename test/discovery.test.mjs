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

test("评估失败或关闭时保留全部结果", async () => {
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
    assert.equal((await discoverCompetitions(store, broken, "比赛")).length, 2);
    assert.match(
      store.searches(null).find((x) => x.query === SCREEN_RECORD).error,
      /全部保留/,
    );
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
