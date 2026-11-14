import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../dist/core/store.js";
import { Brief } from "../dist/core/types.js";
import {
  discoverCompetitions,
  runAutomatic,
  deliveryFormat,
} from "../dist/workflows/autonomous.js";
import { CONCEPT_ROUTES } from "../dist/workflows/concept-quality.js";

/** 候选分支并发调用，按提示词里的“本分支视角”定位，不能依赖调用顺序。 */
function conceptRoute(prompt) {
  const index = CONCEPT_ROUTES.findIndex((route) =>
    prompt.includes(route.slice(0, 10)),
  );
  return index >= 0 ? index + 1 : null;
}
import { renderWork, Work } from "../dist/artifacts/artifacts.js";
import { makeSoftware } from "../dist/artifacts/software.js";
import { makeVisual, VisualBrief } from "../dist/artifacts/visual.js";
import sharp from "sharp";
import {
  readTemplate,
  inspectTemplate,
  fillTemplateSlots,
} from "../dist/artifacts/templates.js";
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
} from "docx";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function setup(
  page = "<title>2026 创意竞赛</title><p>提交方案报告和演示文稿。</p>",
) {
  const dir = await mkdtemp(join(tmpdir(), "competition-auto-"));
  const store = new Store(dir);
  const cfg = {
    dataDir: dir,
    opencodeUrl: "http://127.0.0.1:4096",
    writer: { providerID: "google", id: "gemini-test" },
    reviewer: { providerID: "anthropic", id: "claude-test" },
    maxCalls: 40,
    searchProvider: "tinyfish",
    sources: [],
    profile: {},
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/contest`;
  return { dir, store, cfg, server, url };
}
const brief = (deliverables, requires_idea = true) => ({
  title: "2026 创意竞赛",
  edition: "2026",
  eligibility: null,
  deadline: null,
  ai_rules: null,
  scoring: null,
  deliverables,
  requires_idea,
  missing: [],
});
const item = (type, formats) => ({
  type,
  formats,
  quantity: null,
  limits: [],
  naming: null,
  attachments: [],
  submission: null,
  official_template: null,
});

test("候选生成预算耗尽会中断，补充预算后只生成缺失分支", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事"),
      job = store.createJob(id, "automatic", {}, 2);
    const gateway = makeGateway(brief([item("报告", ["txt"])])),
      original = gateway.generate;
    const attempts = new Map();
    gateway.generate = async (role, prompt) => {
      if (prompt.includes("为以下比赛独立提出一个作品方案")) {
        const angle = prompt.match(/本分支视角：([^。]+)/)[1];
        attempts.set(angle, (attempts.get(angle) || 0) + 1);
        store.reserveCalls(job, 1);
      }
      return original(role, prompt);
    };
    await assert.rejects(runAutomatic(cfg, store, gateway, job), /预算|上限/);
    assert.equal(store.job(job).state, "failed");
    // 三个分支并发，抢到预算的是哪两个不固定；只要求恰好两个已保存，恢复后不重做。
    const saved = new Map();
    for (const n of [1, 2, 3]) {
      try {
        saved.set(
          n,
          await readFile(join(dir, "jobs", job, `concept-${n}.json`), "utf8"),
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    assert.equal(saved.size, 2);
    store.setBudget(job, 4);
    const result = await runAutomatic(cfg, store, gateway, job, true);
    assert.equal(result.ideas.length, 3);
    assert.equal(store.job(job).state, "completed");
    assert.deepEqual([...attempts.values()].sort(), [1, 1, 2]);
    assert.equal(store.job(job).calls, 3);
    for (const [n, text] of saved)
      assert.equal(
        await readFile(join(dir, "jobs", job, `concept-${n}.json`), "utf8"),
        text,
      );
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("嵌套研究预算耗尽保留节点，恢复时继续研究而不重复来源追查", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事"),
      job = store.createJob(id, "automatic", {}, 1);
    const gateway = makeGateway(brief([item("报告", ["txt"])], false)),
      original = gateway.generate;
    let investigations = 0,
      followups = 0,
      searches = 0;
    gateway.search = async () => {
      searches++;
      return [];
    };
    gateway.generate = async (role, prompt) => {
      if (prompt.includes("提出最多三个具体的后续搜索词")) {
        followups++;
        store.reserveCalls(job, 1);
      }
      return original(role, prompt);
    };
    gateway.investigate = async () => {
      investigations++;
      store.reserveCalls(job, 2);
      return {
        text: JSON.stringify({ urls: [], missing: ["未找到公开作品"] }),
      };
    };
    await assert.rejects(runAutomatic(cfg, store, gateway, job), /预算|上限/);
    assert.equal(store.job(job).state, "failed");
    assert.equal(investigations, 1);
    store.setBudget(job, 5);
    await runAutomatic(cfg, store, gateway, job, true);
    assert.equal(store.job(job).state, "completed");
    assert.equal(investigations, 2);
    assert.equal(followups, 1);
    assert.equal(searches, 6);
    assert.equal(store.job(job).calls, 3);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function reviewJSON(prompt) {
  const match = /本次负责的标准：(\[[^\n]*?\])。JSON/.exec(prompt);
  return JSON.stringify({
    issues: [], suggestions: [], needs_input: [],
    criteria: (match ? JSON.parse(match[1]) : []).map(({ criterion }) => ({
      criterion, status: "passed",
      evidence: "产物正文包含基于当前资料的方案；演示页包含真实可检验方案标题。",
    })),
  });
}



function fixtureIdea(index) {
  const routes = [
    { audience: "无联网设备的校园服务窗口及排队学生", problem: "材料不齐的申请占用窗口时间，完整申请被反复等待", mechanism: "先用纸质清单核验材料，再按完整度和等候时间重排两条办理队列", verification: "交替时段对照先到先服务，记录平均等待分钟数及错分率；错分超过5%即停止重排" },
    { audience: "可每五分钟记录等待时间的校园服务窗口及排队学生", problem: "办理需求波动使固定窗口分配产生局部拥堵", mechanism: "每五分钟采样两队等待时长，连续两次超过十分钟便调整一个窗口的分流方向", verification: "留出一天对照固定窗口，并去掉反馈环节做消融；比较等待时长，错分率超过5%判失败" },
    { audience: "只能配置两个窗口且面对高低峰需求的校园服务中心", problem: "有限窗口无法同时满足短等待和复杂业务处理目标", mechanism: "枚举两个窗口的业务分配方案，推演高低需求场景，在人力上限内选择最坏等待最小的方案", verification: "与平均分配基线比较三种需求情景，改变到达率做敏感性分析，任一情景超过二十分钟判失败" },
  ];
  return { title: `方案${index}`, ...routes[(index - 1) % routes.length], evidence_urls: [] };
}
function fixtureText(_prompt, intro) {
  return `${intro}\n每五分钟记录窗口等待时长，连续超限时调整一个窗口的分流方向。与固定分流对照检查等待时间和错分率。这是验证计划，尚未产生实测结果。`;
}
function fixtureSlides() {
  const text = (value, y, size) => ({ text: value, x: 1, y, w: 10, h: 2, fontSize: size, color: "202832" });
  return [{ background: "FFFFFF", elements: [text("真实可检验方案", 1, 24), text("记录窗口等待时长并按现场反馈调整分流，检查等待时间和错分率。", 3, 18)] }];
}
function conceptReview(_prompt, overrides = {}) {
  return JSON.stringify({ selected: 2, analysis: "反馈方案更适合需求波动，效果尚未实测", similarity_risks: ["往届作品公开不足"], ...overrides });
}

function makeGateway(data, overrides = {}) {
  let index = 0;
  const calls = [];
  const g = {
    calls,
    search: async () => [],
    inspectImage: async () => JSON.stringify({ issues: [], suggestions: [] }),
    generate: async (role, prompt) => {
      calls.push({ role, prompt });
      if (overrides.generate) return overrides.generate(role, prompt, calls);
      if (prompt.includes("提出最多三个具体的后续搜索词")) return "[]";
      if (prompt.includes("读取来源并只输出一个 JSON 对象"))
        return JSON.stringify(data);
      if (prompt.includes("撰写中文赛事研究报告"))
        return "依据资料整理的赛事研究";
      if (prompt.includes("判断当前比赛是否适合"))
        return JSON.stringify({
          decision: "proceed",
          reason: "资格需要核实",
          evidence_url: null,
          evidence_quote: null,
        });
      if (prompt.includes("为以下比赛独立提出一个作品方案")) {
        index++;
        return JSON.stringify(fixtureIdea(conceptRoute(prompt) ?? index));
      }
      if (prompt.includes("任务：候选比较"))
        return conceptReview(prompt);
      // 规划：让测试覆盖真实规划链路，而不是依赖已删除的确定性兜底计划。
      if (prompt.includes("拆解成可以实际制作的文件任务"))
        return JSON.stringify({
          tasks: data.deliverables.map((d, i) => ({
            id: `d${i + 1}`,
            deliverable: i,
            title: d.type,
            kind: /ppt|幻灯|演示/i.test(d.type) ? "slides" : "document",
            format:
              data.deliverables[i].formats[0] ||
              (/ppt|幻灯|演示/i.test(d.type) ? "pptx" : "docx"),
            instructions: `按比赛规则完成「${d.type}」的完整内容`,
            acceptance: [`内容完整对应「${d.type}」`],
            reason: "测试用规划",
          })),
          packages: [],
          notes: [],
        });
      if (
        prompt.includes("从给定的完整来源中寻找比赛明确指定要翻译的原文") ||
        prompt.includes("从给定资料中寻找比赛指定要翻译的原文")
      )
        return JSON.stringify({ url: null, text: null, reason: "未公开" });
      if (prompt.includes("根据规则、证据与指定作品检查缺项"))
        return JSON.stringify({ issues: [], unsupported_claims: [] });
      if (prompt.includes("任务：作品验收")) return reviewJSON(prompt);
      if (prompt.includes("请针对这项比赛的指定交付物直接创作")) {
        if (prompt.includes('"kind":"slides"'))
          return JSON.stringify({
            kind: "slides",
            title: "作品演示",
            sources: [],
            slides: fixtureSlides(prompt),
          });
        return JSON.stringify({
          kind: "text",
          title: "方案",
          text: fixtureText(prompt, "基于当前资料提出的方案"),
          sources: [],
        });
      }
      throw Error("unexpected prompt " + prompt.slice(0, 100));
    },
  };
  return g;
}

test("自动发现覆盖多类赛事而不是固定翻译赛，并按 URL 去重", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const q = [];
    const g = {
      search: async (query) => {
        q.push(query);
        return [{ url, title: "比赛", snippet: "" }];
      },
      generate: async () => "",
    };
    const ids = await discoverCompetitions(store, g);
    assert.equal(q.length, 8);
    assert.ok(q.some((x) => x.includes("创新")));
    assert.ok(q.some((x) => x.includes("视频")));
    assert.ok(q.some((x) => x.includes("翻译")));
    assert.equal(ids.length, 1);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("自动发现跳过比赛平台首页并优先高校当届通知", async () => {
  const { dir, store, server } = await setup();
  try {
    const year = new Date().getFullYear();
    const g = {
      generate: async () => "",
      search: async () => [
        {
          url: "https://example.com/",
          title: "我爱竞赛网-高含金量竞赛平台",
          snippet: "",
        },
        {
          url: "https://example.edu.cn/archive",
          title: "设计类竞赛归档-高等院校竞赛活动报名系统",
          snippet: "",
        },
        { url: "https://example.com/a", title: "往届作品比赛", snippet: "" },
        {
          url: "https://news.example.edu.cn/b",
          title: `关于 ${year} 年创新比赛征集通知`,
          snippet: "",
        },
      ],
    };
    const ids = await discoverCompetitions(store, g, "大学生比赛");
    assert.equal(ids.length, 2);
    assert.match(store.competition(ids[0]).url, /example\.edu\.cn/);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("自动发现读取配置的赛事来源并保存来源访问记录", async () => {
  const { dir, store, server, url } = await setup(
    '<a href="/event">大学生创新大赛征集通知</a>',
  );
  try {
    const g = { search: async () => [], generate: async () => "" };
    const ids = await discoverCompetitions(store, g, "无结果查询", [url]);
    assert.equal(ids.length, 1);
    assert.match(store.competition(ids[0]).url, /\/event$/);
    assert.ok(store.searches(null).some((x) => x.query === `source:${url}`));
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("来源列表模式无需搜索密钥，跳过明显的获奖结果公告并记录检索缺口", async () => {
  const { dir, store, server, url } = await setup(
    '<a href="/event">大学生创新大赛征集通知</a><a href="/result">大学生创新大赛获奖公告</a>',
  );
  try {
    const g = {
      canSearch: false,
      search: async () => {
        throw Error("不应调用搜索");
      },
      generate: async () => "",
    };
    const ids = await discoverCompetitions(store, g, undefined, [url]);
    assert.equal(ids.length, 1);
    assert.match(store.competition(ids[0]).url, /\/event$/);
    assert.ok(
      store
        .searches(null)
        .some((x) => x.error?.includes("未配置全网关键词搜索")),
    );
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("独立方案并发生成，针对各方案查询相似作品", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "automatic", {}, 40);
    store.putEvidence({ id: "personal-observation", competitionId: id, url: "user://personal-observation", kind: "user", title: "用户现场观察", text: "用户材料独有线索：服务窗口周三下午只有一位工作人员，申请人集中补交纸质凭证。", fetchedAt: new Date().toISOString() });
    store.putEvidence({ id: "past-work", competitionId: id, url: "https://example.org/previous-work", kind: "official", title: "往届获奖作品", text: "往届模板专属句：星际知识推荐平台统一使用排行榜驱动叙事。", fetchedAt: new Date().toISOString() });
    const g = makeGateway(brief([item("报告", ["txt"])]));
    const original = g.generate;
    let active = 0,
      max = 0;
    g.generate = async (role, prompt) => {
      if (prompt.includes("为以下比赛独立提出一个作品方案")) {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 25));
        active--;
      }
      return original(role, prompt);
    };
    const queries = [];
    g.search = async (q) => {
      queries.push(q);
      return [];
    };
    await runAutomatic(cfg, store, g, job);
    assert.equal(max, 3);
    assert.equal(queries.filter((q) => q.includes("竞赛 获奖作品")).length, 0);
    // 查询由关键词组成（模型抽取，失败时规则兜底）；每个候选各发两条检索。
    assert.equal(queries.filter((q) => q.includes("现有方案")).length, 3);
    assert.equal(queries.filter((q) => q.includes("替代方案")).length, 3);
    // 单字泛词不得成为查询词（这类词只会命中百科词条并 403）。
    assert.ok(queries.every((q) => q.trim().length >= 4));
    const prompts = g.calls.filter((c) => c.prompt.includes("为以下比赛独立提出一个作品方案")).map((c) => c.prompt);
    assert.ok(prompts.every((p) => /场景约束/.test(p) && /工作机制/.test(p) && /验证方法/.test(p)));
    assert.ok(prompts.every((p) => p.includes("用户材料独有线索")), "用户提供的现场材料必须进入全部独立初稿");
    assert.ok(prompts.every((p) => !p.includes("往届模板专属句")), "往届作品不得成为初稿模板");
    assert.equal(new Set(prompts.map((p) => p.match(/本分支视角：([^。]+)/)[1])).size, 3);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("往届证据必须能在实际来源中核对，伪造摘录被剔除", async () => {
  const { dir, store, cfg, server, url } = await setup(
    "<title>比赛资料</title><p>获奖名单：海岸守护获得一等奖。</p>",
  );
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "research", {}, 20);
    const data = brief([item("报告", ["txt"])]);
    data.research = {
      past_winners: [{ url, quote: "海岸守护获得一等奖" }],
      past_works: [{ url, quote: "编造的完整参赛作品内容" }],
      judging: [],
      missing: [],
    };
    const g = makeGateway(data);
    const { runJob } = await import("../dist/workflows/workflow.js");
    await runJob(cfg, store, g, job);
    const research = store.competition(id).brief.research;
    assert.equal(research.past_winners.length, 1);
    assert.equal(research.past_works.length, 0);
    assert.match(research.missing.join(" "), /往届/);
    assert.ok(store.sourceAttempts(id).length > 0);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("规则提取字段类型错误时只重试结构修复", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "research", {}, 20);
    const g = makeGateway(brief([item("报告", ["txt"])]));
    const original = g.generate;
    let attempts = 0;
    g.generate = async (role, prompt) => {
      if (prompt.includes("读取来源并只输出一个 JSON 对象")) {
        attempts++;
        return JSON.stringify({
          ...brief([item("报告", ["txt"])]),
          eligibility: { scope: "在校学生" },
        });
      }
      if (prompt.includes("上一份规则档案不符合指定 JSON 字段类型")) {
        attempts++;
        return JSON.stringify({
          ...brief([item("报告", ["txt"])]),
          eligibility: "在校学生",
        });
      }
      return original(role, prompt);
    };
    const { runJob } = await import("../dist/workflows/workflow.js");
    await runJob(cfg, store, g, job);
    assert.equal(attempts, 2);
    assert.equal(store.competition(id).brief.eligibility, "在校学生");
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("研究流程调用 Claude Agent 追查并独立抓取返回的公开来源", async () => {
  const { dir, store, cfg, server, url } = await setup(
    "<title>公开作品</title><p>海岸守护获奖作品的公开演示内容。</p>",
  );
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "research", {}, 20);
    const g = makeGateway(brief([item("报告", ["txt"])]));
    let prompt = "";
    g.investigate = async (p) => {
      prompt = p;
      return {
        sessionId: "s1",
        text: JSON.stringify({
          urls: [{ url: `${url}?work=1`, title: "作品展示" }],
          missing: [],
        }),
        events: [],
      };
    };
    const { runJob } = await import("../dist/workflows/workflow.js");
    await runJob(cfg, store, g, job);
    assert.match(prompt, /往届获奖名单/);
    assert.ok(
      store
        .evidence(id)
        .some((e) => e.kind === "agent_research" && e.url.endsWith("?work=1")),
    );
    assert.equal(
      JSON.parse(
        await readFile(join(dir, "jobs", job, "claude-research.json"), "utf8"),
      ).sessionId,
      "s1",
    );
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PPT 逐页渲染：页数不符或渲染失败都抛错", async () => {
  const { dir, store, server } = await setup();
  try {
    const { previewSlides } = await import("../dist/artifacts/preview.js");
    // 没有真实 PPTX 时 officecli 读不出页数，必须报错而不是当作成功。
    await assert.rejects(
      previewSlides(join(dir, "missing.pptx"), 2),
      /officecli|页数|渲染/,
    );
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("自动完成研究、三种独立方案和多个交付物；评审 Agent 独立比较候选方案", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const competitionId = store.addCompetition(url, "2026 创意竞赛");
    const job = store.createJob(competitionId, "automatic", {}, 40);
    const gateway = makeGateway(
      brief([item("方案报告", ["docx"]), item("演示文稿", ["pptx"])]),
    );
    const result = await runAutomatic(cfg, store, gateway, job);
    assert.equal(store.job(job).state, "completed");
    assert.equal(result.ideas.length, 3);
    // 候选比较现在真的执行了（不再降级取第一个），桩模型选择第 2 个方案。
    assert.equal(result.choice.selected, 2);
    // 每个交付物在 final/ 和任务目录各留一份，因此各出现两次。
    assert.equal(result.outputs.filter((x) => x.endsWith(".docx")).length, 2);
    assert.equal(result.outputs.filter((x) => x.endsWith(".pptx")).length, 2);
    assert.ok(result.deliverables.every((d) => d.status === "submission"));
    const { readSource } = await import("../dist/competition/sources.js");
    const docText = await readSource(result.outputs.find((path) => path.endsWith(".docx")));
    const { default: PizZip } = await import("pizzip");
    const slides = new PizZip(await readFile(result.outputs.find((path) => path.endsWith(".pptx"))));
    const slideText = Object.entries(slides.files).filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(([, file]) => file.asText()).join(" ");
    assert.equal(result.choice.strategy, undefined, "最小选择不生成七项合同");
    assert.match(docText, /验证计划，尚未产生实测结果/);
    assert.match(slideText, /真实可检验方案/);
    assert.match(result.gaps.join(" "), /往届/);
    const concepts = gateway.calls.filter((x) =>
      x.prompt.includes("为以下比赛独立提出一个作品方案"),
    );
    assert.equal(concepts.length, 3);
    assert.ok(concepts.every((x) => x.role === "writer"));
    assert.ok(
      gateway.calls.some(
        (x) => x.role === "reviewer" && x.prompt.includes("任务：候选比较"),
      ),
    );
    // 独立分支不应看到其他候选的内容；不按调用顺序取某一条判断。
    assert.ok(concepts.every((x) => !/方案\d/.test(x.prompt)));
    const produced = gateway.calls.filter((x) =>
      x.prompt.includes("请针对这项比赛的指定交付物直接创作"),
    );
    assert.ok(produced.every((x) => x.role === "writer"));
    const report = JSON.parse(await readFile(result.outputs.at(-1), "utf8"));
    assert.equal(report.status, "needs_review");
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("翻译原文没公开时任务直接失败，不编造原文或作品", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "翻译大赛");
    const job = store.createJob(id, "automatic", {}, 30);
    const g = makeGateway(brief([item("翻译作品", ["docx"])], false));
    await assert.rejects(
      runAutomatic(cfg, store, g, job),
      /资料中没有找到比赛指定的翻译原文/,
    );
    assert.equal(store.job(job).state, "failed");
    assert.equal(
      g.calls.filter((x) => x.prompt.includes("为以下比赛独立提出一个作品方案"))
        .length,
      0,
    );
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("官方格式未核实时不猜格式，任务直接失败", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "征文通知");
    const job = store.createJob(id, "automatic", {}, 40);
    let idea = 0;
    const g = makeGateway(brief([item("征文论文", [])], false), {
      generate: async (role, prompt) => {
        if (prompt.includes("提出最多三个具体的后续搜索词")) return "[]";
        if (prompt.includes("读取来源并只输出一个 JSON 对象"))
          return JSON.stringify(brief([item("征文论文", [])], false));
        if (prompt.includes("撰写中文赛事研究报告")) return "研究报告";
        if (prompt.includes("判断当前比赛是否适合"))
          return JSON.stringify({
            decision: "proceed",
            reason: "待核实",
            evidence_url: null,
            evidence_quote: null,
          });
        if (prompt.includes("为以下比赛独立提出一个作品方案")) {
          idea++;
          return JSON.stringify({
            title: `方向${idea}`,
            audience: "学生",
            problem: "教学问题",
            mechanism: `方法${idea}`,
            verification: "待验证",
            evidence_urls: ["https://example.net/uncollected"],
          });
        }
        if (prompt.includes("任务：候选比较"))
          return conceptReview(prompt, { selected: 1, analysis: "可行", similarity_risks: [] });
        if (prompt.includes("请针对这项比赛的指定交付物直接创作"))
          return JSON.stringify({
            kind: "text",
            title: "教学实践构想",
            text: "## 摘要\n摘要。\n## 引言\n教学方案的具体论证。\n## 结论与局限\n结论。",
            sources: [],
          });
        if (
          prompt.includes("检查文字初稿") ||
          prompt.includes("复审修订后的文字草稿")
        )
          return JSON.stringify({ issues: [], unsupported_claims: [] });
        throw Error(`unexpected: ${prompt.slice(0, 80)}`);
      },
    });
    // 选题引用不影响中断，但官方格式没核实就必须停下，而不是猜一个格式继续做。
    await assert.rejects(
      runAutomatic(cfg, store, g, job),
      /提交文件格式未核实/,
    );
    assert.equal(store.job(job).state, "failed");
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("自动制作不再调用审核 Agent 判断作品资格", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "automatic", {}, 40);
    const base = makeGateway(brief([item("报告", ["txt"])]));
    const calls = base.calls;
    const result = await runAutomatic(cfg, store, base, job);
    assert.equal(result.gate.decision, "proceed");
    assert.ok(
      !calls.some(
        (x) =>
          x.role === "reviewer" && x.prompt.includes("判断当前比赛是否适合"),
      ),
    );
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("实际 PPTX 可生成并检查越界；未知格式不伪装成功", async () => {
  const { dir, store, server } = await setup();
  try {
    const work = Work.parse({
      kind: "slides",
      title: "自由布局",
      sources: [],
      slides: [
        {
          background: "FFFFFF",
          elements: [
            {
              text: "项目说明",
              x: 1,
              y: 1,
              w: 6,
              h: 1,
              fontSize: 24,
              color: "202832",
              bold: true,
            },
          ],
        },
      ],
    });
    const out = await renderWork(work, "pptx", dir);
    assert.equal((await readFile(out)).subarray(0, 2).toString(), "PK");
    assert.deepEqual(deliveryFormat("海报", ["png"]), {
      format: "png",
      kind: "image",
    });
    assert.deepEqual(deliveryFormat("电影", ["mp4"]), {
      format: null,
      kind: null,
    });
    const bad = Work.parse({
      ...work,
      slides: [
        {
          background: "FFFFFF",
          elements: [
            {
              text: "越界",
              x: 13,
              y: 0,
              w: 2,
              h: 1,
              fontSize: 20,
              color: "202832",
              bold: false,
            },
          ],
        },
      ],
    });
    await assert.rejects(renderWork(bad, "pptx", dir), /越界/);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("不把图片格式的翻译或文档格式的软件误判为已支持作品", () => {
  assert.deepEqual(deliveryFormat("翻译作品", ["png"]), {
    format: null,
    kind: null,
  });
  assert.deepEqual(deliveryFormat("软件源代码", ["docx"]), {
    format: null,
    kind: null,
  });
});

test("图片模型产出可被导出并叠加 Gemini 编写的文字", async () => {
  const { dir, store, server } = await setup();
  try {
    const base = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    let seen = "";
    const g = {
      search: async () => [],
      inspectImage: async () => JSON.stringify({ issues: [], suggestions: [] }),
      generate: async () => "",
      generateImage: async (p) => {
        seen = p;
        return { data: base, mime: "image/png" };
      },
    };
    const out = await makeVisual(
      g,
      VisualBrief.parse({ image_prompt: "校园设计", caption: "项目主题" }),
      "png",
      dir,
    );
    assert.equal((await sharp(out).metadata()).width, 800);
    assert.match(seen, /no text/i);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("纯文本 PDF 导出包含原始文字", async () => {
  const { dir, store, server } = await setup();
  try {
    const work = Work.parse({
      kind: "text",
      title: "方案",
      text: "自动生成的作品内容。",
      sources: [],
    });
    const out = await renderWork(work, "pdf", dir);
    assert.equal((await readFile(out)).subarray(0, 5).toString(), "%PDF-");
    const { readSource } = await import("../dist/competition/sources.js");
    assert.match(await readSource(out), /自动生成的作品内容/);
    assert.deepEqual(deliveryFormat("作品说明", ["pdf"]), {
      format: "pdf",
      kind: "text",
    });
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("软件制作调用代码执行器并使用 Gemini 文案，生成可解压的作品", async () => {
  const { dir, store, server } = await setup();
  try {
    let called = 0;
    const g = {
      search: async () => [],
      inspectImage: async () => JSON.stringify({ issues: [], suggestions: [] }),
      generate: async () => "",
      buildProject: async (folder, prompt) => {
        called++;
        assert.match(prompt, /所有面向用户的文字|用户可见文案/);
        await writeFile(
          join(folder, "index.html"),
          '<html><head><script src="copy.js"></script></head><body><main id="app"></main><script>document.getElementById("app").textContent=window.COMPETITION_COPY.title;</script></body></html>',
        );
      },
    };
    const out = await makeSoftware(
      g,
      { title: "校园工具", strings: { action: "立即使用" } },
      {},
      null,
      "zip",
      dir,
    );
    assert.equal(called, 1);
    assert.equal((await readFile(out)).subarray(0, 2).toString(), "PK");
    assert.deepEqual(deliveryFormat("软件作品", ["zip"]), {
      format: "zip",
      kind: "software",
    });
    assert.deepEqual(deliveryFormat("PPT", ["pdf"]), {
      format: null,
      kind: null,
    });
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("独立方案生成中断后保留已完成分支并继续制作", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "automatic", {}, 40);
    const base = makeGateway(brief([item("报告", ["txt"])]));
    const original = base.generate;
    let attempts = 0;
    base.generate = async (role, prompt) => {
      if (prompt.includes("为以下比赛独立提出一个作品方案")) {
        attempts++;
        if (attempts === 3) throw Error("临时模型故障");
      }
      return original(role, prompt);
    };
    const result = await runAutomatic(cfg, store, base, job);
    assert.equal(store.job(job).state, "completed");
    assert.equal(result.ideas.length, 2);
    assert.equal(attempts, 3);
    assert.ok(result.outputs.some((x) => x.endsWith(".txt")));
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("一个选题分支失败时保留其他分支并继续制作", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "automatic", {}, 40);
    const base = makeGateway(brief([item("报告", ["txt"])]));
    const original = base.generate;
    let failed = false;
    base.generate = async (role, prompt) => {
      if (
        !failed &&
        prompt.includes("本分支视角：从跨学科方法或相邻领域出发")
      ) {
        failed = true;
        throw Error("单个分支暂时不可用");
      }
      return original(role, prompt);
    };
    const result = await runAutomatic(cfg, store, base, job);
    assert.equal(store.job(job).state, "completed");
    assert.equal(result.ideas.length, 2);
    assert.ok(result.outputs.some((x) => x.endsWith(".txt")));
    assert.ok(result.gaps.length >= 0);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("自动流程把研究、写作和候选评审路由到不同 Agent", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事");
    const job = store.createJob(id, "automatic", {}, 40);
    const base = makeGateway(brief([item("报告", ["txt"])]));
    const routed = [];
    const original = base.generate;
    base.generate = async (role, prompt, agent) => {
      routed.push(agent || role);
      return original(role, prompt, agent);
    };
    await runAutomatic(cfg, store, base, job);
    assert.ok(routed.includes("writer"));
    assert.ok(routed.includes("research"));
    assert.ok(routed.includes("reviewer"));
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("有明确字段的官方 Word 模板可保留内容并填充；缺少字段拒绝生成", async () => {
  const { dir, store, server } = await setup();
  try {
    const source = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("官方竞赛模板"),
              new Paragraph("项目名称：{title}"),
              new Paragraph("摘要：{summary}"),
            ],
          },
        ],
      }),
    );
    const template = readTemplate(source);
    assert.deepEqual(template.tags.sort(), ["summary", "title"]);
    assert.throws(() => template.render({ title: "项目" }), /必填字段/);
    const result = template.render({
      title: "校园工具",
      summary: "改善办事体验",
    });
    const out = join(dir, "result.docx");
    await writeFile(out, result);
    const { readSource } = await import("../dist/competition/sources.js");
    const extracted = await readSource(out);
    assert.match(extracted, /官方竞赛模板/);
    assert.match(extracted, /校园工具/);
    assert.match(extracted, /改善办事体验/);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("往届获奖名单中出现作品线索后，会继续查找该作品的展示", async () => {
  const { dir, store, cfg, server, url } = await setup(
    "<title>2026 创意竞赛</title><p>往届名单：获奖作品“海岸守护”，团队“海蓝团队”。</p>",
  );
  try {
    const id = store.addCompetition(url, "创意竞赛");
    const job = store.createJob(id, "research", {}, 20);
    let round = 0;
    const queries = [];
    const g = {
      search: async (q) => {
        queries.push(q);
        return [];
      },
      generate: async (role, prompt) => {
        if (prompt.includes("提出最多三个具体的后续搜索词")) {
          round++;
          if (round === 1) return '["创意竞赛 往届 获奖名单"]';
          assert.match(prompt, /海岸守护/);
          return '["海岸守护 海蓝团队 作品展示"]';
        }
        if (prompt.includes("读取来源并只输出一个 JSON 对象"))
          return JSON.stringify(brief([item("方案报告", ["docx"])]));
        return "研究报告";
      },
    };
    const { runJob } = await import("../dist/workflows/workflow.js");
    await runJob(cfg, store, g, job);
    assert.ok(queries.includes("海岸守护 海蓝团队 作品展示"));
    assert.equal(store.searches(id).length, 8);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("重复自动扫描已完成赛事时跳过模型调用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "competition-skip-"));
  let port = 0;
  let modelCalls = 0;
  const api = createServer((req, res) => {
    if (req.url === "/contest") {
      res.setHeader("content-type", "text/html");
      res.end("<title>创意比赛通知</title><p>提交报告。</p>");
      return;
    }
    if (req.url === "/api/info") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "2.2.0" }));
      return;
    }
    modelCalls++;
    res.statusCode = 500;
    res.end("unexpected");
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  port = api.address().port;
  const url = `http://127.0.0.1:${port}/contest`;
  const store = new Store(dir);
  const competition = store.addCompetition(url, "创意比赛通知");
  const job = store.createJob(competition, "automatic", {}, 30);
  store.setJob(job, "completed");
  store.close();
  try {
    const env = {
      ...process.env,
      OPENCODE_URL: `http://127.0.0.1:${port}`,
      COMPETE_DATA_DIR: dir,
    };
    delete env.OPENCODE_PASSWORD;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["dist/cli.js", "auto", "--url", url],
      { cwd: process.cwd(), env, timeout: 20000 },
    );
    assert.match(stdout, /已处理过所有候选/);
    assert.equal(modelCalls, 0);
  } finally {
    api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("选题证据与风险进入规划提示和最终结果，不在制作节点被丢弃", async () => {
  const { dir, store, cfg, server, url } = await setup(
    "<p>相似作品使用了相同场景，仍需进一步区分机制。</p>",
  );
  try {
    const id = store.addCompetition(url, "赛事"),
      job = store.createJob(id, "automatic", {}, 40);
    const g = makeGateway(brief([item("报告", ["txt"])]));
    const original = g.generate;
    let sawPlan = false;
    g.search = async (q) =>
      q.includes("替代方案")
        ? [
            {
              url: `${url}?novelty=1`,
              title: "相似作品",
              snippet: "不用于证据",
            },
          ]
        : [];
    g.generate = async (role, prompt) => {
      if (prompt.includes("抽取") && prompt.includes("keywords"))
        return JSON.stringify({
          keywords: ["方案场景对象", "方案核心方法", "校园服务"],
        });
      if (prompt.includes("任务：候选比较")) {
        assert.match(prompt, /相似作品使用了相同场景/);
        return conceptReview(prompt, { analysis: "选择方案2，但验证尚未完成", similarity_risks: ["方案2需要补充差异化验证"] });
      }
      if (prompt.includes("拆解成可以实际制作的文件任务")) {
        sawPlan = true;
        assert.match(prompt, /方案2需要补充差异化验证/);
        return original(role, prompt);
      }
      if (prompt.includes("请针对这项比赛的指定交付物直接创作"))
        assert.match(prompt, /方案2需要补充差异化验证/);
      return original(role, prompt);
    };
    const result = await runAutomatic(cfg, store, g, job);
    assert.equal(sawPlan, true);
    assert.equal(result.choice.selected, 2);
    assert.match(result.gaps.join(" "), /方案2需要补充差异化验证/);
    const final = JSON.parse(await readFile(result.outputs.at(-1), "utf8"));
    assert.match(final.gaps.join(" "), /方案2需要补充差异化验证/);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("无占位符的官方表格模板按“标签：空单元格”填写，留空字段不阻断交付", async () => {
  const { dir, store, server } = await setup();
  try {
    const source = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("官方报名表"),
              new Table({
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph("团队名称：")] }),
                      new TableCell({ children: [new Paragraph("")] }),
                    ],
                  }),
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph("参赛赛题：")] }),
                      new TableCell({ children: [new Paragraph("")] }),
                    ],
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    );
    const inspection = inspectTemplate(source);
    assert.deepEqual(inspection.tags, []);
    assert.deepEqual(
      inspection.slots.map((s) => s.label),
      ["团队名称", "参赛赛题"],
    );
    const ids = Object.fromEntries(inspection.slots.map((s) => [s.label, s.id]));
    const filled = fillTemplateSlots(source, {
      [ids["团队名称"]]: "创新实验室",
      [ids["参赛赛题"]]: "蚂蚁搬家",
    });
    const out = join(dir, "filled.docx");
    await writeFile(out, filled.data);
    const { readSource } = await import("../dist/competition/sources.js");
    const text = await readSource(out);
    assert.match(text, /创新实验室/);
    assert.match(text, /蚂蚁搬家/);
    assert.match(text, /团队名称/, "保留原标签");
    assert.equal(filled.filled.length, 2);
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("已填写个人信息写进正文，缺实测资料仍阻止交付", async () => {
  const dir = await mkdtemp(join(tmpdir(), "profile-"));
  const store = new Store(dir);
  try {
    const id = store.addCompetition("https://example.edu.cn/p", "赛事");
    store.setBrief(id, brief([item("方案报告", ["txt"])]));
    const job = store.createJob(id, "automatic", {}, 40);
    const cfg = {
      dataDir: dir,
      execution: { productionRounds: 2, plannerRounds: 2 },
      writer: { providerID: "google", id: "gemini-test" },
      reviewer: { providerID: "anthropic", id: "claude-test" },
      maxCalls: 40,
      sources: [],
      profile: { name: "程磊", school: "东北师范大学" },
    };
    let prompt = "";
    const g = {
      search: async () => [],
      inspectImage: async () => JSON.stringify({ issues: [], suggestions: [] }),
      generate: async (role, p) => {
        if (p.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [
              {
                id: "report",
                deliverable: 0,
                title: "报告",
                kind: "document",
                format: "txt",
                instructions: "写完整报告",
                acceptance: ["内容完整"],
              },
            ],
            packages: [],
            notes: [],
          });
        if (p.includes("任务：作品验收")) return JSON.stringify({ issues: [] });
        if (p.includes("直接创作")) {
          prompt = p;
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text: "作者：【待补充：姓名】，单位：【待补充：学校】，另有【待补充：实测数据】。",
            sources: [],
            needs_input: ["作者姓名", "学校", "实测数据"],
          });
        }
        throw Error("unexpected");
      },
    };
    const { runOrchestration } = await import(
      "../dist/workflows/orchestrator.js"
    );
    await assert.rejects(runOrchestration(cfg, store, g, {
      jobId: job,
      competitionId: id,
      idea: {
        title: "识物助盲",
        audience: "视障人士",
        problem: "识别日常物品",
        mechanism: "离线图像识别",
        verification: "识别率测试",
        evidence_urls: [],
      },
    }), /缺少完成作品所需资料：实测数据/);
    assert.match(prompt, /用户资料（已由用户提供/);
    assert.match(prompt, /姓名：程磊/);
    const folder = join(dir, "jobs", job);
    const states = (await readdir(folder)).filter((name) => /-r\d+-state\.json$/.test(name));
    assert.ok(states.length > 0, "失败后保留逐轮产物");
    const state = JSON.parse(await readFile(join(folder, states[0]), "utf8"));
    const text = await readFile(state.attempt.paths[0], "utf8");
    assert.match(text, /作者：程磊/);
    assert.match(text, /单位：东北师范大学/);
    assert.match(text, /【待补充：实测数据】/, "缺失真实资料不伪造");
    await assert.rejects(readFile(join(folder, "deliverables.json")), { code: "ENOENT" });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("明确核心雷同只修正所选候选，恢复不重复初稿和已完成修正", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事"), job = store.createJob(id, "automatic", {}, 40);
    const gateway = makeGateway(brief([item("报告", ["txt"])]));
    const original = gateway.generate;
    let initial = 0, rewrites = 0, reviews = 0, fail = true;
    const queryCounts = new Map();
    gateway.search = async (q) => { queryCounts.set(q, (queryCounts.get(q) || 0) + 1); return []; };
    gateway.generate = async (role, prompt) => {
      if (prompt.includes("为以下比赛独立提出一个作品方案")) {
        const idea = JSON.parse(await original(role, prompt));
        initial++;
        // 让分支 1 和 2 核心机制相同；按分支视角判断，避免并发顺序导致不稳定。
        if ([1, 2].includes(conceptRoute(prompt))) idea.mechanism = "按固定优先级分配人工资源";
        return JSON.stringify(idea);
      }
      if (prompt.includes("任务：定向重写重复候选")) {
        rewrites++;
        assert.match(prompt, /仅重写候选 2/);
        return JSON.stringify({ title: "反馈分流", audience: "有等待时间观测的窗口", problem: "需求波动引发拥堵", mechanism: "根据等待时长闭环调整资源分配", verification: "与固定分配基线比较并消融反馈，统计等待时长与错误率", evidence_urls: [] });
      }
      if (prompt.includes("任务：候选比较")) {
        reviews++;
        if (reviews === 2 && fail) throw Error("调用预算上限，暂停复审");
        return conceptReview(prompt, reviews === 1 ? { core_duplicate: { candidate: 2, otherCandidate: 1, reason: "两者均按同一固定优先级分配人工资源，所选方案无增量", instructions: "针对需求波动引入现场反馈" } } : {});
      }
      return original(role, prompt);
    };
    await assert.rejects(runAutomatic(cfg, store, gateway, job), /预算上限/);
    assert.equal(initial, 3);
    assert.equal(rewrites, 1);
    const blocked = JSON.parse(await readFile(join(dir, "jobs", job, "concept-review.json"), "utf8"));
    assert.equal(blocked.selected, 2);
    assert.equal(blocked.core_duplicate.candidate, 2);
    assert.equal(blocked.rewrites[0].candidate, 2);
    fail = false;
    const result = await runAutomatic(cfg, store, gateway, job, true);
    assert.equal(initial, 3);
    assert.equal(rewrites, 1);
    assert.equal(reviews, 3);
    assert.ok([...queryCounts.values()].every((n) => n === 1));
    assert.equal(result.ideas[0].mechanism, "按固定优先级分配人工资源");
    assert.equal(result.ideas[1].mechanism, "根据等待时长闭环调整资源分配");
    assert.equal(result.choice.selected, 2);
    assert.equal(result.candidateEvidence[1].title, "反馈分流");
    const saved = JSON.parse(await readFile(join(dir, "jobs", job, "concept-2.json"), "utf8"));
    assert.equal(saved.mechanism, "按固定优先级分配人工资源", "保留独立初稿，不覆盖分支缓存");
  } finally { server.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("一次修正后仍被明确指出核心雷同时失败，不默认成功", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事"), job = store.createJob(id, "automatic", {}, 40);
    const gateway = makeGateway(brief([item("报告", ["txt"])]));
    const original = gateway.generate;
    let initial = 0, rewrites = 0;
    gateway.generate = async (role, prompt) => {
      if (prompt.includes("为以下比赛独立提出一个作品方案")) {
        const idea = JSON.parse(await original(role, prompt));
        if (++initial <= 2) idea.mechanism = "同一个固定打分流程";
        return JSON.stringify(idea);
      }
      if (prompt.includes("任务：定向重写重复候选")) {
        rewrites++;
        return JSON.stringify({ title: `换个标题${rewrites}`, audience: "学生", problem: "分配问题", mechanism: "同一个固定打分流程", verification: "记录分配误差", evidence_urls: [] });
      }
      if (prompt.includes("任务：候选比较")) return conceptReview(prompt, { core_duplicate: { candidate: 2, otherCandidate: 1, reason: "两者核心均为同一个固定打分流程，仍没有增量", instructions: "改变实际分配规则" } });
      return original(role, prompt);
    };
    await assert.rejects(runAutomatic(cfg, store, gateway, job), /已完成1轮定向修正.*仍有明确核心雷同/);
    assert.equal(rewrites, 1);
    assert.ok(!gateway.calls.some((c) => c.prompt.includes("拆解成可以实际制作的文件任务")));
  } finally { server.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("未选候选相似和来源不确定不返工，直接进入创作", async () => {
  const { dir, store, cfg, server, url } = await setup();
  try {
    const id = store.addCompetition(url, "赛事"), job = store.createJob(id, "automatic", {}, 40);
    const gateway = makeGateway(brief([item("报告", ["txt"])]));
    const original = gateway.generate;
    let initial = 0, reviews = 0;
    gateway.generate = async (role, prompt) => {
      if (prompt.includes("为以下比赛独立提出一个作品方案")) {
        const idea = JSON.parse(await original(role, prompt));
        if (++initial !== 2) idea.mechanism = "其他两个分支完全相同的机制";
        return JSON.stringify(idea);
      }
      if (prompt.includes("任务：候选比较")) {
        reviews++;
        return conceptReview(prompt, { analysis: "候选1和3核心相同，选择候选2；无公开来源，比较 uncertain", core_duplicate: { candidate: 1, otherCandidate: 3, reason: "未选分支相同", instructions: "无需影响所选方案" } });
      }
      if (prompt.includes("任务：定向重写")) assert.fail("不应重写未选分支");
      return original(role, prompt);
    };
    const result = await runAutomatic(cfg, store, gateway, job);
    assert.equal(result.choice.selected, 2);
    assert.equal(reviews, 1);
    assert.ok(result.outputs.some((path) => path.endsWith(".txt")));
  } finally { server.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
