import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OfficialGateway, EmptyModelResponseError } from "../dist/core/gateway.js";
import { readModelCalls, readModelMetrics } from "../dist/core/model-metrics.js";
import { Store } from "../dist/core/store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";


// 每份 fixture 产物实际展开合同；验收只从本次产物行中取局部原文。
function contractRows(prompt) {
  const prefix = "策略质量合同（硬性要求，返工不得删减或降低）：";
  const line = prompt.split(/\r?\n/).find((line) => line.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : [];
}
function fixtureIdea(index) {
  const routes = [
    { audience: "无联网设备的校园服务窗口及排队学生", problem: "材料不齐的申请占用窗口时间，完整申请被反复等待", mechanism: "先用纸质清单核验材料，再按完整度和等候时间重排两条办理队列", verification: "交替时段对照先到先服务，记录平均等待分钟数及错分率；错分超过5%即停止重排" },
    { audience: "可每五分钟记录等待时间的校园服务窗口及排队学生", problem: "办理需求波动使固定窗口分配产生局部拥堵", mechanism: "每五分钟采样两队等待时长，连续两次超过十分钟便调整一个窗口的分流方向", verification: "留出一天对照固定窗口，并去掉反馈环节做消融；比较等待时长，错分率超过5%判失败" },
    { audience: "只能配置两个窗口且面对高低峰需求的校园服务中心", problem: "有限窗口无法同时满足短等待和复杂业务处理目标", mechanism: "枚举两个窗口的业务分配方案，推演高低需求场景，在人力上限内选择最坏等待最小的方案", verification: "与平均分配基线比较三种需求情景，改变到达率做敏感性分析，任一情景超过二十分钟判失败" },
  ];
  return { title: `方案${index}`, ...routes[(index - 1) % routes.length], evidence_urls: [] };
}
function contractSections(prompt) {
  return contractRows(prompt).map(({ id, requirement }) => {
    const [, field, n] = id.split(".");
    const headings = { problem: "需求边界", audience: "使用场景", mechanism: "工作机制", differentiators: "机制对照", tradeoffs: "资源取舍", validation: "验证步骤", evidenceLimits: "证据边界" };
    const detail = {
      problem: "分别记录排队和补材料耗时，定位瓶颈；不处理校外业务。",
      audience: "入口核验纸质材料，异常申请保留人工办理通道。",
      mechanism: "输入到达时间和窗口状态，按上述规则输出队列，并记录调整原因。",
      differentiators: "对照组固定窗口；实验组保留逐次分配记录，辨别改变来自哪一步。",
      tradeoffs: "仅在规定时点更新，未核验申请不得自动改道，以控制额外劳动。",
      validation: "核对两组业务难度，达到失败阈值即停止分流。这是验证计划，尚未产生实测结果。",
      evidenceLimits: "不宣称已查证原创，不编造测试成绩。",
    };
    assert.ok(headings[field], `未知合同项 ${id}`);
    return { id, heading: `${headings[field]}${n ? ` ${n}` : ""}：`, text: `${headings[field]}${n ? ` ${n}` : ""}：${requirement}。${detail[field]}` };
  });
}
function planContract(prompt, kind = "document") {
  const sections = contractSections(prompt);
  return sections.length ? { qualityContract: sections.map(({ id, heading }, i) => ({
    id, implementation: kind === "slides" ? `第${i + 2}页“${heading}”给出具体步骤、约束及检查依据，验收该页实际文本` : `正文“${heading}”段落实具体步骤和检查依据，逐段核对实际内容`,
  })) } : {};
}
function reviewContract(prompt) {
  const sections = contractSections(prompt);
  if (!sections.length) return {};
  const material = prompt.split("产物内容：\n")[1] || "";
  const lines = [...material.matchAll(/^\[(L\d+)\] (.*)$/gm)].map(([, location, text]) => ({ location, text }));
  return { qualityContract: sections.map(({ id, heading }) => {
    const requirement = contractRows(prompt).find((row) => row.id === id).requirement;
    for (const { location, text } of lines) {
      let fragments = [text];
      if (text.startsWith('[{"page":')) fragments = JSON.parse(text).flatMap((slide) => slide.text);
      const actual = fragments.find((part) => part.startsWith(heading) && part.includes(requirement));
      if (actual && actual.length <= 400) return { id, status: "passed", reason: `本次产物“${heading}”的具体步骤和边界落实该项要求`, evidence: { kind: "text", location, quote: actual } };
    }
    return { id, status: "failed", reason: `本次实际产物缺少“${heading}”的具体实现或有效局部证据` };
  }) };
}
function fixtureText(prompt, intro) {
  return [intro, ...contractSections(prompt).map((section) => section.text)].join("\n");
}
function fixtureSlides(prompt) {
  const text = (value, y, size, bold = false) => ({ text: value, x: 1, y, w: 10, h: size === 24 ? 0.8 : 4.5, fontSize: size, color: "202832", bold });
  return [{ background: "FFFFFF", elements: [text("真实可检验方案", 1, 24, true)] }, ...contractSections(prompt).map(({ heading, text: body }) => ({ background: "FFFFFF", elements: [text(heading.slice(0, -1), 0.5, 24, true), text(body, 1.5, 16)] }))];
}

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
    strategy: { problem: idea.problem, audience: idea.audience, mechanism: idea.mechanism, differentiators: [`与先到先服务且固定窗口相比，方案通过“${idea.mechanism}”改变分配依据`], tradeoffs: ["采样需要时间，效果仍需实测"], validation: [idea.verification], evidenceLimits: ["未核实所有往届作品"] },
    quality: candidates.map((idea, i) => ({ candidate: i + 1, fit: check(idea, "problem"), feasibility: check(idea, "mechanism"), validation: check(idea, "verification") })),
    comparisons,
    sourceComparisons: evidence.map((e) => ({ candidate: e.candidate, status: e.sources.length ? "compared" : "unverified", findings: e.sources.map((source) => ({ url: source.url, quote: source.excerpt, relation: "uncertain", reason: "正文披露的工作机制有限，尚不足判断候选原创性" })), limitations: ["正文没有完整对照实验，无法证明原创"] })),
    ...overrides,
  });
}

function config(dir) {
  return {
    dataDir: dir,
    writer: { providerID: "google", id: "gemini-test" },
    reviewer: { providerID: "anthropic", id: "claude-test" },
    image: { providerID: "google", id: "gemini-image" },
    coder: { id: "codex-test" },
    researchAgent: { enabled: true, maxTurns: 2, maxBudgetUsd: 0.5 },
    search: { provider: "searxng" },
    profile: {},
    sources: [],
    maxCalls: 30,
  };
}
function env(values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(values))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  return () => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
}

test("官方 Gemini 和 Claude SDK 分别调用指定模型，并限制调用预算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"));
  const store = new Store(dir);
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    if (req.url.includes("generateContent"))
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Gemini 作品" }] },
              finishReason: "STOP",
            },
          ],
        }),
      );
    else if (req.url === "/v1/messages")
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "Claude 评审" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    else if (req.url.startsWith("/search"))
      res.end(
        JSON.stringify({
          results: [
            {
              url: "https://example.org/event",
              title: "比赛",
              content: "通知",
            },
          ],
        }),
      );
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const restore = env({
    GEMINI_API_KEY: "test",
    ANTHROPIC_API_KEY: "test",
    COMPETE_GEMINI_BASE_URL: base,
    ANTHROPIC_BASE_URL: base,
  });
  try {
    const cfg = config(dir);
    cfg.search.url = base;
    const id = store.addCompetition("https://example.org/c", "赛");
    const job = store.createJob(id, "research", {}, 2);
    const g = new OfficialGateway(cfg, store, job);
    assert.equal(await g.generate("writer", "撰写"), "Gemini 作品");
    assert.equal(await g.generate("reviewer", "评审"), "Claude 评审");
    assert.match(seen[0].url, /gemini-test/);
    assert.equal(seen[1].body.model, "claude-test");
    assert.equal((await g.search("赛事"))[0].title, "比赛");
    await assert.rejects(g.generate("writer", "第三次"), /预算不足|上限/);
    assert.equal(store.job(job).calls, 2);
    const metrics = await readModelMetrics(dir, job);
    assert.equal(metrics.attempts, 2);
    assert.equal(metrics.success, 2);
    assert.equal(metrics.usageKnownAttempts, 1);
    assert.equal(metrics.usageUnknownAttempts, 1);
    assert.equal(metrics.usage.inputTokens, 1);
    assert.equal(metrics.usage.totalTokens, null);
  } finally {
    restore();
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("DeepSeek 只负责评审，走官方兼容端点并禁用思考输出", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"));
  const cfg = config(dir);
  cfg.reviewer = { providerID: "deepseek", id: "deepseek-flash" };
  const restore = env({
    DEEPSEEK_API_KEY: "test",
    ANTHROPIC_API_KEY: undefined,
  });
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (input, init) => {
    seen = { url: String(input), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        id: "msg",
        type: "message",
        role: "assistant",
        model: "deepseek-flash",
        content: [{ type: "text", text: "评审结果" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const g = new OfficialGateway(cfg);
    assert.equal(await g.generate("reviewer", "检查"), "评审结果");
    assert.match(
      seen.url,
      /^https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages/,
    );
    assert.equal(seen.body.model, "deepseek-flash");
    assert.equal(seen.body.thinking.type, "disabled");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude Agent 仅启用网页工具，记录会话并从原会话恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"));
  const store = new Store(dir);
  const restore = env({ ANTHROPIC_API_KEY: "test" });
  const seen = [];
  async function* fake(args) {
    seen.push(args);
    yield { type: "system", session_id: "claude-session" };
    yield {
      type: "result",
      subtype: "success",
      session_id: "claude-session",
      result: '{"urls":[]}',
    };
  }
  try {
    const cfg = config(dir);
    const id = store.addCompetition("https://example.org/c", "赛");
    const job = store.createJob(id, "research", {}, 5);
    const g = new OfficialGateway(cfg, store, job, { query: fake });
    assert.equal((await g.investigate("追查作品")).sessionId, "claude-session");
    assert.deepEqual(seen[0].options.tools, ["WebSearch", "WebFetch"]);
    assert.equal(seen[0].options.permissionMode, "dontAsk");
    assert.equal(seen[0].options.maxTurns, 2);
    assert.equal(seen[0].options.env.OPENAI_API_KEY, undefined);
    await g.investigate("继续");
    assert.equal(seen[1].options.resume, "claude-session");
    assert.match(
      await readFile(
        join(dir, "jobs", job, "claude-research", "events.jsonl"),
        "utf8",
      ),
      /claude-session/,
    );
    await assert.rejects(g.investigate("超额"), /预算不足/);
    const metrics = await readModelMetrics(dir, job);
    assert.equal(metrics.attempts, 0, "运行时执行次数不能冒充内部模型请求次数");
    assert.equal(metrics.runtime.attempts, 2);
    assert.equal(metrics.runtime.success, 2);
    assert.equal(metrics.runtime.usageUnknownAttempts, 2);
  } finally {
    restore();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex 使用限制网络的工作区沙箱并持久恢复线程", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"));
  const store = new Store(dir);
  const restore = env({
    OPENAI_API_KEY: "test",
    ANTHROPIC_API_KEY: "other-secret",
  });
  const seen = [];
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: "thread.started", thread_id: "thread-1" };
        yield { type: "turn.completed" };
      })(),
    }),
  };
  const driver = {
    codex: (e) => {
      seen.push({ env: e });
      return {
        startThread: (o) => {
          seen.push({ opts: o });
          return thread;
        },
        resumeThread: (id, o) => {
          seen.push({ id, opts: o });
          return thread;
        },
      };
    },
  };
  try {
    const cfg = config(dir);
    const id = store.addCompetition("https://example.org/c", "赛");
    const job = store.createJob(id, "automatic", {}, 16);
    const g = new OfficialGateway(cfg, store, job, driver);
    await g.buildProject(dir, "制作原型");
    assert.equal(seen[1].opts.sandboxMode, "workspace-write");
    assert.equal(seen[1].opts.networkAccessEnabled, false);
    assert.equal(seen[0].env.ANTHROPIC_API_KEY, undefined);
    assert.equal(
      await readFile(join(dir, "jobs", job, "agent-runtime", Buffer.from(dir).toString("hex").slice(-48), ".codex-thread-id"), "utf8"),
      "thread-1",
    );
    await g.buildProject(dir, "继续");
    assert.equal(seen[3].id, "thread-1");
    await assert.rejects(g.buildProject(dir, "再次制作"), /预算不足/);
  } finally {
    restore();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto 使用独立搜索和官方模型协议，从队列完成赛事文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "official-cli-"));
  let base = "";
  const seen = [];
  let concept = 0;
  const brief = {
    title: "创新比赛",
    edition: "2026",
    eligibility: null,
    deadline: null,
    ai_rules: null,
    scoring: null,
    deliverables: [
      {
        type: "报告",
        formats: ["txt"],
        quantity: null,
        limits: [],
        naming: null,
        attachments: [],
        submission: null,
        official_template: null,
      },
    ],
    requires_idea: true,
    missing: [],
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/contest") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        "<title>创新比赛通知</title><p>报名截止2099年12月31日，提交报告作品。</p>",
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/search")) {
      res.end(
        JSON.stringify({
          results: [
            { url: `${base}/contest`, title: "创新比赛通知", content: "报告" },
          ],
        }),
      );
      return;
    }
    let prompt = "",
      role = "";
    if (req.url.includes("generateContent")) {
      prompt = body.contents?.[0]?.parts?.[0]?.text || "";
      role = "writer";
    } else if (req.url === "/v1/messages") {
      prompt = body.messages[0].content;
      role = "reviewer";
    } else {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    let text;
    if (prompt.includes("判断候选是否为当前仍有机会报名"))
      text = JSON.stringify({
        decision: "valid",
        reason: "报名截止日期明确",
        deadline: "2099-12-31",
        source_url: `${base}/contest`,
        quote: "报名截止2099年12月31日",
      });
    else if (prompt.includes("提出最多三个具体的后续搜索词")) text = "[]";
    else if (prompt.includes("读取来源并只输出一个 JSON 对象"))
      text = JSON.stringify(brief);
    else if (prompt.includes("撰写中文赛事研究报告")) text = "赛事研究";
    else if (prompt.includes("判断当前比赛是否适合"))
      text = JSON.stringify({
        decision: "proceed",
        reason: "待核实",
        evidence_url: null,
        evidence_quote: null,
      });
    else if (prompt.includes("为以下比赛独立提出一个作品方案")) {
      concept++;
      text = JSON.stringify(fixtureIdea(concept));
    } else if (prompt.includes("任务：作品验收")) {
      const expected = JSON.parse(
        prompt.match(/本次负责的标准：(\[[^\n]+?\])。JSON 必须包含 criteria/)?.[1] || "[]",
      );
      const artifact = prompt.split("产物内容：\n")[1] || "";
      const hasBody = artifact.includes("Gemini 作品正文");
      const criteria = expected.map(({ criterion, requirement }) => ({
        criterion,
        status: requirement === "内容完整" && hasBody ? "passed" : "unverified",
        evidence: hasBody
          ? "实际产物标题‘方案’后的正文为‘Gemini 作品正文’，与此测试写作响应的完整正文一致。"
          : "本次评审材料未包含测试写作响应的正文，无法核实内容完整。",
      }));
      text = JSON.stringify({
        pass: criteria.every((row) => row.status === "passed"),
        issues: criteria.every((row) => row.status === "passed") ? [] : ["缺少可核实的正文依据"],
        criteria,
        ...reviewContract(prompt),
      });
    } else if (prompt.includes("拆解成可以实际制作的文件任务"))
      text = JSON.stringify({
        tasks: [
          {
            id: "report",
            deliverable: 0,
            title: "报告",
            kind: "document",
            format: "txt",
            instructions: "写完整报告",
            acceptance: ["内容完整"],
            ...planContract(prompt),
          },
        ],
        packages: [],
        notes: [],
      });
    else if (prompt.includes("任务：候选比较"))
      text = conceptReview(prompt, { selected: 1, analysis: "方案一的纸质核验与固定分流适用于离线窗口", similarity_risks: [] });
    else if (prompt.includes("根据规则、证据与指定作品检查缺项"))
      text = JSON.stringify({ issues: [], unsupported_claims: [] });
    else if (prompt.includes("请针对这项比赛的指定交付物直接创作"))
      text = JSON.stringify({
        kind: "text",
        title: "方案",
        text: fixtureText(prompt, "Gemini 作品正文"),
        sources: [],
      });
    else {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: { message: "unexpected prompt " + prompt.slice(0, 40) },
        }),
      );
      return;
    }
    if (role === "writer")
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text }] },
              finishReason: "STOP",
            },
          ],
        }),
      );
    else
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = config(dir);
    cfg.search.url = base;
    cfg.researchAgent.enabled = false;
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(cfg));
    const childEnv = {
      ...process.env,
      COMPETE_CONFIG: configPath,
      COMPETE_DATA_DIR: dir,
      GEMINI_API_KEY: "test",
      ANTHROPIC_API_KEY: "test",
      COMPETE_GEMINI_BASE_URL: base,
      ANTHROPIC_BASE_URL: base,
    };
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["dist/cli.js", "auto", "--limit", "1", "--budget", "40"],
      { cwd: process.cwd(), env: childEnv, timeout: 30000 },
    );
    assert.match(stdout, /submission\.txt/);
    assert.ok(seen.some((x) => x.url.includes("generateContent")));
    assert.ok(seen.some((x) => x.url === "/v1/messages"));
    /* 发现搜索16次、研究搜索6次、三候选各3条相似作品查询9次。 */ assert.equal(
      seen.filter((x) => x.url.startsWith("/search")).length,
      31,
    );
    const store = new Store(dir);
    try {
      const queue = store.queue();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].state, "completed");
      const artifact = store
        .artifacts(queue[0].jobId)
        .find((x) => x.kind === "submission");
      const actual = await readFile(artifact.path, "utf8");
      assert.match(actual, /Gemini 作品正文/);
      const review = JSON.parse(await readFile(join(dir, "jobs", queue[0].jobId, "concept-review.json"), "utf8"));
      for (const value of [review.strategy.problem, review.strategy.audience, review.strategy.mechanism, ...review.strategy.differentiators, ...review.strategy.tradeoffs, ...review.strategy.validation, ...review.strategy.evidenceLimits])
        assert.ok(actual.includes(value), `交付正文必须包含合同内容：${value}`);
      assert.match(actual, /验证计划，尚未产生实测结果/);
      const plan = JSON.parse(await readFile(join(dir, "jobs", queue[0].jobId, "plan.json"), "utf8"));
      assert.ok(plan.plan.tasks[0].qualityContract.length >= 7);
    } finally {
      store.close();
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function relayConfig(dir, base, protocol = "openai", attempts = 2) {
  return {
    dataDir: dir,
    providers: [{ id: "local", label: "Local", protocol, baseURL: base }],
    agents: {
      writer: { provider: "local", model: "fixed-model" },
      reviewer: { provider: "local", model: "fixed-model" },
      image: { provider: "local", model: "fixed-model" },
    },
    execution: { requestTimeoutSeconds: 30, requestAttempts: attempts },
    search: { provider: "sources" }, sources: [], maxCalls: 10,
  };
}
async function localModel(reply) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader("content-type", "application/json");
    reply(res, requests.length, requests.at(-1));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
function textResponse(protocol, text, reasoning = false) {
  if (protocol === "gemini") return {
    candidates: [{ content: { role: "model", parts: reasoning ? [{ text: "PRIVATE_REASONING", thought: true }] : [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 9, thoughtsTokenCount: 3 },
  };
  if (protocol === "anthropic") return {
    id: "msg", type: "message", role: "assistant", model: "fixed-model",
    content: reasoning ? [{ type: "thinking", thinking: "PRIVATE_REASONING", signature: "sig" }] : [{ type: "text", text }],
    stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 },
  };
  return { choices: [{ message: reasoning ? { content: null, reasoning_content: "PRIVATE_REASONING" } : { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
}

for (const protocol of ["openai", "gemini", "anthropic"]) {
  for (const operation of ["generate", "inspectImage"]) {
    test(`${protocol} ${operation} 首次只返回思考后重试成功，真实 usage 与失败尝试均记录`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "gateway-empty-"));
      const mock = await localModel((res, count) => res.end(JSON.stringify(textResponse(protocol, "正文", count === 1))));
      try {
        const g = new OfficialGateway(relayConfig(dir, mock.base, protocol), undefined, "job");
        await g.reportProgress({ stage: "review", action: "评审", taskId: "report", round: 2 });
        const text = operation === "generate"
          ? await g.generate("writer", "PRIVATE_PROMPT")
          : await g.inspectImage("PRIVATE_PROMPT", { data: Buffer.from("PRIVATE_IMAGE"), mime: "image/png" });
        assert.equal(text, "正文");
        assert.equal(mock.requests.length, 2);
        assert.ok(mock.requests.every((r) => r.body.model === "fixed-model" || r.url.includes("fixed-model")));
        const events = await readModelCalls(dir, "job");
        assert.deepEqual(events.map((e) => [e.event, e.attempt, e.status]), [
          ["start", 1, undefined], ["result", 1, "failure"], ["start", 2, undefined], ["result", 2, "success"],
        ]);
        assert.equal(new Set(events.map((e) => e.callId)).size, 1);
        assert.equal(events[1].errorKind, "empty_response");
        assert.ok(events.every((e) => e.taskId === "report" && e.round === 2 && e.operation === operation));
        const metrics = await readModelMetrics(dir, "job");
        assert.equal(metrics.calls, 1);
        assert.equal(metrics.attempts, 2);
        assert.equal(metrics.failure, 1);
        assert.equal(metrics.success, 1);
        assert.equal(metrics.usage.inputTokens, 8);
        assert.equal(metrics.usage.outputTokens, 4);
        assert.equal(metrics.usage.totalTokens, protocol === "anthropic" ? null : protocol === "gemini" ? 18 : 12);
        assert.equal(metrics.usageKnownAttempts, 2);
        assert.ok(metrics.durationMs >= 0);
        const raw = await readFile(join(dir, "jobs", "job", "model-calls.jsonl"), "utf8");
        assert.doesNotMatch(raw, /PRIVATE_|正文|apiKey|authorization/);
      } finally {
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
  test(`${protocol} 缺失正文在单次尝试配置下文本和看图均以明确类型失败`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gateway-missing-"));
    const mock = await localModel((res) => res.end("{}"));
    try {
      const g = new OfficialGateway(relayConfig(dir, mock.base, protocol, 1), undefined, "job");
      await assert.rejects(g.generate("writer", "撰写"), EmptyModelResponseError);
      await assert.rejects(g.inspectImage("评审", { data: Buffer.from("png"), mime: "image/png" }), EmptyModelResponseError);
      assert.equal(mock.requests.length, 2);
      const metrics = await readModelMetrics(dir, "job");
      assert.equal(metrics.failure, 2);
      assert.equal(metrics.usageUnknownAttempts, 2);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test(`${protocol} 持续空白正文用完配置尝试后以明确类型失败`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gateway-empty-fail-"));
    const mock = await localModel((res) => res.end(JSON.stringify(textResponse(protocol, " \n\t "))));
    try {
      const g = new OfficialGateway(relayConfig(dir, mock.base, protocol), undefined, "job");
      await assert.rejects(g.generate("writer", "创作"), (error) => {
        assert.ok(error instanceof EmptyModelResponseError);
        assert.equal(error.code, "EMPTY_MODEL_RESPONSE");
        assert.equal(error.retryable, true);
        assert.match(error.message, /空正文.*不会切换其他模型/);
        return true;
      });
      assert.equal(mock.requests.length, 2);
      const metrics = await readModelMetrics(dir, "job");
      assert.equal(metrics.failure, 2);
      assert.equal(metrics.success, 0);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const operation of ["generate", "inspectImage"]) {
  for (const recover of [true, false]) {
    test(`SSE ${operation} ${recover ? "空响应重试后成功" : "持续空响应失败"}，不输出 reasoning`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "gateway-sse-"));
      const mock = await localModel((res, count) => {
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"reasoning_content":"PRIVATE_REASONING"}}]}\r\n\r\n');
        if (recover && count === 2) {
          res.write('data: {"choices":[{"delta":{"content":"流式');
          res.write('正文"}}]}\n\n');
        }
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n');
        res.end("data: [DONE]");
      });
      try {
        const g = new OfficialGateway(relayConfig(dir, mock.base), undefined, "job");
        const result = operation === "generate" ? g.generate("writer", "撰写")
          : g.inspectImage("评审", { data: Buffer.from("png"), mime: "image/png" });
        if (recover) assert.equal(await result, "流式正文");
        else await assert.rejects(result, EmptyModelResponseError);
        assert.equal(mock.requests.length, 2);
        const metrics = await readModelMetrics(dir, "job");
        assert.equal(metrics.failure, recover ? 1 : 2);
        assert.equal(metrics.success, recover ? 1 : 0);
        assert.equal(metrics.usage.totalTokens, 16);
      } finally {
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("SSE 完全空响应同样在单次请求边界内重试且 usage 保持未知", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-empty-sse-"));
  const mock = await localModel((res, count) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(count === 1 ? "" : 'data: {"choices":[{"delta":{"content":"正文"},"finish_reason":"stop"}]}\n\ndata: [DONE]');
  });
  try {
    const g = new OfficialGateway(relayConfig(dir, mock.base), undefined, "job");
    assert.equal(await g.generate("writer", "撰写"), "正文");
    assert.equal(mock.requests.length, 2);
    const metrics = await readModelMetrics(dir, "job");
    assert.equal(metrics.failure, 1);
    assert.equal(metrics.success, 1);
    assert.equal(metrics.usageUnknownAttempts, 2);
    assert.equal(metrics.usage.totalTokens, null);
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("看图共享总 deadline，退避后没有剩余时间就不再发送请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-deadline-"));
  const mock = await localModel((res) => res.end(JSON.stringify(textResponse("openai", ""))));
  const originalNow = Date.now;
  try {
    let now = originalNow();
    Date.now = () => now;
    const g = new OfficialGateway(relayConfig(dir, mock.base), undefined, "job");
    const once = g.inspectImageOnce.bind(g);
    g.inspectImageOnce = async (...args) => {
      const text = await once(...args);
      now += 59_999;
      return text;
    };
    const originalSetTimeout = globalThis.setTimeout;
    const pauses = [];
    globalThis.setTimeout = (fn, delay, ...args) => {
      if (delay === 1) { pauses.push(delay); now += delay; }
      return originalSetTimeout(fn, delay, ...args);
    };
    try {
      await assert.rejects(g.inspectImage("评审", { data: Buffer.from("png"), mime: "image/png" }), EmptyModelResponseError);
    } finally { globalThis.setTimeout = originalSetTimeout; }
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(pauses, [1]);
  } finally {
    Date.now = originalNow;
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("指标写入失败只警告，已生成正文不重试且不丢弃", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-metrics-fail-"));
  const mock = await localModel((res) => res.end(JSON.stringify(textResponse("openai", "正文"))));
  const warnings = [];
  const originalWarn = console.warn;
  try {
    await writeFile(join(dir, "jobs"), "blocked");
    console.warn = (...args) => warnings.push(args.join(" "));
    const g = new OfficialGateway(relayConfig(dir, mock.base), undefined, "job");
    assert.equal(await g.generate("writer", "撰写"), "正文");
    assert.equal(mock.requests.length, 1);
    assert.ok(warnings.some((message) => message.includes("指标写入失败")));
  } finally {
    console.warn = originalWarn;
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("并发网关及恢复追加保持调用身份，图片请求与非重试失败也计入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-metrics-concurrent-"));
  const mock = await localModel((res, _count, request) => {
    if (request.url.includes("images/generations")) res.end(JSON.stringify({ data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }] }));
    else if (request.body.messages.at(-1).content === "fail") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "PRIVATE_UPSTREAM_ERROR" } }));
    } else res.end(JSON.stringify(textResponse("openai", "正文")));
  });
  try {
    const cfg = relayConfig(dir, mock.base);
    const gateways = Array.from({ length: 8 }, () => new OfficialGateway(cfg, undefined, "job"));
    await Promise.all(gateways.map((g) => g.generate("writer", "撰写")));
    const old = await readFile(join(dir, "jobs", "job", "model-calls.jsonl"), "utf8");
    const resumed = new OfficialGateway(cfg, undefined, "job");
    await resumed.generateImage("画图");
    await assert.rejects(resumed.generate("writer", "fail"), /HTTP 400/);
    const raw = await readFile(join(dir, "jobs", "job", "model-calls.jsonl"), "utf8");
    assert.ok(raw.startsWith(old));
    assert.doesNotMatch(raw, /PRIVATE_UPSTREAM_ERROR/);
    const events = await readModelCalls(dir, "job");
    assert.equal(events.length, 20);
    const ids = new Set(events.map((e) => e.callId));
    assert.equal(ids.size, 10);
    for (const id of ids) assert.deepEqual(events.filter((e) => e.callId === id).map((e) => e.event), ["start", "result"]);
    const metrics = await readModelMetrics(dir, "job");
    assert.equal(metrics.calls, 10);
    assert.equal(metrics.attempts, 10);
    assert.equal(metrics.success, 9);
    assert.equal(metrics.failure, 1);
    assert.equal(metrics.usageKnownAttempts, 8);
    assert.equal(metrics.usageUnknownAttempts, 2);
    assert.equal(mock.requests.length, 10);
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("模型调用按配置的尝试次数重试，重试共享总时限而不是每次重新计时", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-attempts-"));
  const restore = env({ RELAY_KEY: "k" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const started = Date.now();
  try {
    // 可重试的网络错误：每次立刻失败，用来确认尝试次数与退避总长都由配置决定。
    globalThis.fetch = async () => {
      calls++;
      throw Error("fetch failed");
    };
    const cfg = {
      dataDir: dir,
      providers: [
        {
          id: "relay",
          label: "Relay",
          protocol: "openai",
          baseURL: "http://127.0.0.1:9/v1",
          apiKeyEnv: "RELAY_KEY",
        },
      ],
      agents: { writer: { provider: "relay", model: "m" } },
      execution: { requestTimeoutSeconds: 30, requestAttempts: 3 },
      search: { provider: "sources" },
      sources: [],
      maxCalls: 10,
    };
    await assert.rejects(
      new OfficialGateway(cfg).generate("writer", "撰写"),
      /调用失败/,
    );
    const elapsed = Date.now() - started;
    assert.equal(calls, 3, "尝试次数应等于 requestAttempts，不再固定 5 次");
    // 退避 2 秒 + 6 秒后立即结束，最后一次失败不再多等一轮退避。
    assert.ok(
      elapsed >= 8_000 && elapsed < 12_000,
      `应在最后一次尝试后立即结束，实际 ${elapsed} 毫秒`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});
