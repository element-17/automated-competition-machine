import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { OfficialGateway } from "../dist/core/gateway.js";
import { Store } from "../dist/core/store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
      await readFile(join(dir, ".codex-thread-id"), "utf8"),
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
      text = JSON.stringify({
        title: `方案${concept}`,
        audience: `人群${concept}`,
        problem: `问题${concept}`,
        mechanism: `方法${concept}`,
        verification: "验证",
        evidence_urls: [],
      });
    } else if (prompt.includes("任务：作品验收"))
      text = JSON.stringify({ pass: true, issues: [] });
    else if (prompt.includes("比较三个独立方案"))
      text = JSON.stringify({
        selected: 1,
        analysis: "方案一",
        similarity_risks: [],
      });
    else if (prompt.includes("根据规则、证据与指定作品检查缺项"))
      text = JSON.stringify({ issues: [], unsupported_claims: [] });
    else if (prompt.includes("请针对这项比赛的指定交付物直接创作"))
      text = JSON.stringify({
        kind: "text",
        title: "方案",
        text: "Gemini 作品正文",
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
    /* 8 个发现搜索词各翻到第 2 页（无新结果即停止），另有 3 个研究搜索和 3 个相似作品搜索 */ assert.equal(
      seen.filter((x) => x.url.startsWith("/search")).length,
      25,
    );
    const store = new Store(dir);
    try {
      const queue = store.queue();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].state, "completed");
      const artifact = store
        .artifacts(queue[0].jobId)
        .find((x) => x.kind === "submission");
      assert.match(await readFile(artifact.path, "utf8"), /Gemini 作品正文/);
    } finally {
      store.close();
    }
  } finally {
    server.close();
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
