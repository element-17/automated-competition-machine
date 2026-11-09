import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionSettings,
  saveExecutionConfig,
  loadConfig,
} from "../dist/core/config.js";
import { AgentSettings, resolveAgent } from "../dist/agents/models.js";
import { runAgentTask, opencodeConfig } from "../dist/agents/agents.js";
import { OfficialGateway } from "../dist/core/gateway.js";
import { Store } from "../dist/core/store.js";

test("长任务设置有边界且保存时保留自定义提示词与搜索配置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "execution-config-"));
  try {
    const file = join(dir, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        dataDir: dir,
        prompts: { writer: "我的自定义" },
        search: { provider: "sources" },
        sources: [],
      }),
    );
    assert.equal(executionSettings({}).productionRounds, 4);
    assert.throws(() =>
      executionSettings({ execution: { productionRounds: 99 } }),
    );
    saveExecutionConfig(
      file,
      {
        productionRounds: 6,
        plannerRounds: 4,
        researchRounds: 5,
        requestTimeoutSeconds: 600,
      },
      100,
    );
    const cfg = loadConfig(file);
    assert.equal(cfg.maxCalls, 100);
    assert.equal(cfg.execution.productionRounds, 6);
    assert.equal(cfg.prompts.writer, "我的自定义");
    assert.equal(cfg.search.provider, "sources");
    assert.equal(
      AgentSettings.safeParse({ maxTurns: 100, timeoutSeconds: 3600 }).success,
      true,
    );
    assert.equal(AgentSettings.safeParse({ maxTurns: 101 }).success, false);
    assert.equal(
      AgentSettings.safeParse({ timeoutSeconds: 10 }).success,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude 编码使用配置的轮次和预算，OpenCode 使用步骤上限", async () => {
  const dir = await mkdtemp(join(tmpdir(), "execution-runtime-"));
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test";
  try {
    const agent = resolveAgent(
      {
        agents: {
          coder: {
            provider: "anthropic",
            runtime: "claude-code",
            model: "test",
            maxTurns: 40,
            maxBudgetUsd: 2.5,
            timeoutSeconds: 900,
          },
        },
      },
      "coder",
    );
    let options;
    const driver = {
      query: async function* (args) {
        options = args.options;
        yield {
          type: "result",
          subtype: "success",
          session_id: "session",
          result: "完成",
        };
      },
    };
    await runAgentTask(
      agent,
      {
        kind: "code",
        cwd: dir,
        prompt: "继续工作",
        system: "按反馈修复",
        statePath: join(dir, "session.txt"),
        timeoutMs: 900000,
      },
      driver,
    );
    assert.equal(options.maxTurns, 40);
    assert.equal(options.maxBudgetUsd, 2.5);
    assert.ok(!options.tools.includes("Bash"));
    assert.equal(options.abortController.signal.aborted, false);
    assert.equal(
      opencodeConfig({ ...agent, runtime: "opencode" }, "code", "system").agent
        .compete.steps,
      40,
    );
    assert.equal(resolveAgent({}, "research").timeoutSeconds, 1200);
    assert.equal(resolveAgent({}, "coder").maxTurns, 20);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("网关记录当前轮次与预算，Codex 事件可供恢复排查", async () => {
  const dir = await mkdtemp(join(tmpdir(), "execution-progress-"));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test";
  const store = new Store(dir);
  try {
    const id = store.addCompetition("https://example.org/contest", "比赛"),
      job = store.createJob(id, "automatic", {}, 16),
      events = [];
    const cfg = {
      dataDir: dir,
      agents: {
        coder: {
          provider: "openai",
          model: "test",
          runtime: "codex",
          timeoutSeconds: 60,
        },
      },
      search: { provider: "sources" },
    };
    const driver = {
      codex: () => ({
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started", thread_id: "one" };
              yield { type: "turn.completed" };
            })(),
          }),
        }),
      }),
    };
    const g = new OfficialGateway(cfg, store, job, driver, (e) =>
      events.push(e),
    );
    await g.reportProgress({
      stage: "production",
      action: "制作软件",
      taskId: "app",
      round: 2,
      maxRounds: 4,
    });
    await g.buildProject(dir, "继续");
    const progress = JSON.parse(
      await readFile(join(dir, "jobs", job, "runtime-progress.json"), "utf8"),
    );
    assert.equal(progress.round, 2);
    assert.equal(progress.budget.used, 8);
    assert.ok(events.some((e) => e.elapsedSeconds !== undefined));
    assert.match(
      await readFile(join(dir, ".runtime-events.jsonl"), "utf8"),
      /turn.completed/,
    );
  } finally {
    store.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
