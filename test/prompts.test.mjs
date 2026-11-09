import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OfficialGateway } from "../dist/core/gateway.js";
import { Store } from "../dist/core/store.js";
import { savePrompt, loadConfig } from "../dist/core/config.js";
import { defaultPrompts, promptOf } from "../dist/agents/prompts.js";

const base = (dir) => ({
  dataDir: dir,
  writer: { providerID: "google", id: "gemini-test" },
  reviewer: { providerID: "anthropic", id: "claude-test" },
  image: { providerID: "google", id: "gemini-image" },
  coder: { id: "codex-test" },
  researchAgent: { enabled: true, maxTurns: 2, maxBudgetUsd: 0.5 },
  search: { provider: "sources" },
  profile: {},
  sources: [],
  maxCalls: 30,
  prompts: {},
});
function env(values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  return () => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
}

test("写作和评审模型通过系统提示词通道收到配置的提示词", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompts-"));
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(init.body);
    seen.push({ url, body });
    return new Response(
      JSON.stringify(
        url.includes("generateContent")
          ? {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "作品" }] },
                  finishReason: "STOP",
                },
              ],
            }
          : {
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [{ type: "text", text: "评审" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const restore = env({ GEMINI_API_KEY: "test", ANTHROPIC_API_KEY: "test" });
  try {
    const cfg = base(dir);
    cfg.prompts = { reviewer: "自定义评审提示词" };
    const g = new OfficialGateway(cfg);
    await g.generate("writer", "写");
    await g.generate("reviewer", "审");
    const writer = seen.find((x) => x.url.includes("generateContent")).body,
      reviewer = seen.find((x) => x.url.includes("/v1/messages")).body;
    assert.match(
      JSON.stringify(writer.systemInstruction),
      new RegExp(defaultPrompts.writer.slice(0, 10)),
    );
    assert.equal(reviewer.system, "自定义评审提示词");
    assert.equal(reviewer.messages[0].content, "审");
  } finally {
    globalThis.fetch = original;
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("研究 Agent 使用系统提示词，Codex 仅在新线程开头加入提示词", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompts-"));
  const store = new Store(dir);
  const restore = env({ ANTHROPIC_API_KEY: "test", OPENAI_API_KEY: "test" });
  const seen = [],
    runs = [];
  async function* fake(args) {
    seen.push(args);
    yield { type: "result", subtype: "success", session_id: "s", result: "{}" };
  }
  const thread = {
    runStreamed: async (p) => {
      runs.push(p);
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "t1" };
          yield { type: "turn.completed" };
        })(),
      };
    },
  };
  const codex = () => ({
    startThread: () => thread,
    resumeThread: () => thread,
  });
  try {
    const cfg = base(dir);
    cfg.prompts = { research: "只查官网", coder: "使用原生 JS" };
    const id = store.addCompetition("https://example.org/c", "赛");
    const job = store.createJob(id, "automatic", {}, 40);
    const g = new OfficialGateway(cfg, store, job, { query: fake, codex });
    await g.investigate("查");
    assert.equal(seen[0].options.systemPrompt, "只查官网");
    await g.buildProject(dir, "做原型");
    assert.match(runs[0], /^使用原生 JS\n\n做原型$/);
    await g.buildProject(dir, "继续");
    assert.equal(runs[1], "继续");
  } finally {
    restore();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("保存与恢复提示词只改动 prompts 字段，CLI 可查看", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompts-cfg-"));
  const file = join(dir, "config.json");
  try {
    await writeFile(file, JSON.stringify({ maxCalls: 20, dataDir: dir }));
    savePrompt(file, "writer", "  新的写作提示词  ");
    let raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.prompts.writer, "新的写作提示词");
    assert.equal(raw.maxCalls, 20);
    assert.equal(promptOf(loadConfig(file), "writer"), "新的写作提示词");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["dist/cli.js", "-c", file, "prompts", "writer"],
      { cwd: process.cwd() },
    );
    assert.equal(JSON.parse(stdout)[0].custom, true);
    savePrompt(file, "writer", "");
    raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.prompts.writer, undefined);
    assert.equal(promptOf(loadConfig(file), "writer"), defaultPrompts.writer);
    assert.throws(() => savePrompt(file, "unknown", "x"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
