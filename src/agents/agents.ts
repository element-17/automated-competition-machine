import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  apiKey,
  hasKey,
  resolveAgent,
  type ModelConfig,
  type Provider,
  type ResolvedAgent,
} from "./models.js";
import {
  loadRuntime,
  runtimeCommand,
  runtimeExecutable,
  runtimeHome,
  runtimeReady,
  runtimeStateText,
} from "./runtimes.js";
import { agents, agentLabels } from "./prompts.js";

/** 各运行时 SDK 中实际使用的最小类型；SDK 按需下载，因此不依赖其类型声明。 */
export type ClaudeQuery = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;
type CodexThread = {
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<any> }>;
};
export type CodexClient = {
  startThread(o: Record<string, unknown>): CodexThread;
  resumeThread(id: string, o: Record<string, unknown>): CodexThread;
};
export type Drivers = {
  query?: ClaudeQuery;
  codex?: (
    env: Record<string, string>,
    provider?: { baseUrl?: string; apiKey?: string },
  ) => CodexClient;
};
export type Task = {
  kind: "research" | "code";
  cwd: string;
  runtimeHome?: string;
  prompt: string;
  system: string;
  statePath: string;
  eventsPath?: string;
  timeoutMs: number;
};

const passthrough = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
/** 运行时只拿到当前 Agent 的密钥和必要的系统变量，不继承其他供应商的密钥。 */
export function isolatedEnv(home: string, extra: Record<string, string>) {
  const env: Record<string, string> = {
    PATH: process.env.PATH || "",
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
  for (const name of passthrough)
    if (process.env[name]) env[name] = process.env[name]!;
  return env;
}
const readState = async (path: string) => {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return undefined;
  }
};
const isOfficialAnthropic = (p: Provider) =>
  p.protocol === "anthropic" && !p.baseURL;

/** Claude Code：官方接口用 API Key；DeepSeek 等兼容服务用 base URL + auth token，并把后台模型也指向同一模型。 */
function claudeEnv(home: string, agent: ResolvedAgent, key: string) {
  if (isOfficialAnthropic(agent.provider))
    return isolatedEnv(home, {
      ANTHROPIC_API_KEY: key,
      ...(process.env.ANTHROPIC_BASE_URL
        ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }
        : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  return isolatedEnv(home, {
    ANTHROPIC_BASE_URL: agent.provider.baseURL!,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: agent.model,
    ANTHROPIC_SMALL_FAST_MODEL: agent.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: agent.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
}
async function runClaude(
  agent: ResolvedAgent,
  task: Task,
  key: string,
  drivers: Drivers,
) {
  const query =
    drivers.query ||
    (await loadRuntime<{ query: ClaudeQuery }>("claude-code")).query;
  const home = task.runtimeHome || (task.kind === "code" ? join(task.cwd, ".claude-home") : task.cwd);
  await mkdir(home, { recursive: true });
  // 网页搜索是 Anthropic 服务端工具，只在官方接口可用；编码只允许读写工作区内文件，不给 shell。
  const tools =
    task.kind === "research"
      ? isOfficialAnthropic(agent.provider)
        ? ["WebSearch", "WebFetch"]
        : ["WebFetch"]
      : ["Read", "Write", "Edit", "Glob", "Grep"];
  const allowed =
    task.kind === "research"
      ? tools
      : ["Read", "Glob", "Grep", "Edit(./**)", "Write(./**)"];
  const resume = await readState(task.statePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), task.timeoutMs);
  let sessionId = resume || "",
    text = "";
  const events: unknown[] = [];
  try {
    for await (const message of query({
      prompt: task.prompt,
      options: {
        cwd: task.cwd,
        env: claudeEnv(home, agent, key),
        model: agent.model,
        systemPrompt: task.system,
        tools,
        allowedTools: allowed,
        permissionMode: "dontAsk",
        settingSources: [],
        ...(drivers.query || !runtimeExecutable("claude-code")
          ? {}
          : { pathToClaudeCodeExecutable: runtimeExecutable("claude-code") }),
        maxTurns: agent.maxTurns,
        maxBudgetUsd: agent.maxBudgetUsd,
        abortController: controller,
        ...(resume ? { resume } : {}),
      },
    })) {
      if (message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
        await writeFile(task.statePath, sessionId, "utf8");
      }
      const event = JSON.parse(JSON.stringify(message));
      events.push(event);
      if (task.eventsPath)
        await appendFile(task.eventsPath, JSON.stringify(event) + "\n", "utf8");
      if (message.type === "result") {
        if (message.subtype !== "success")
          throw Error(
            `${task.kind === "research" ? "研究" : "编码"} Agent 未完成：${message.subtype}`,
          );
        text = message.result;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!text)
    throw Error(
      `${task.kind === "research" ? "研究" : "编码"} Agent 未返回结果`,
    );
  return { text, sessionId, events };
}
async function runCodex(
  agent: ResolvedAgent,
  task: Task,
  key: string,
  drivers: Drivers,
) {
  const home = task.runtimeHome || join(task.cwd, ".codex-home");
  await mkdir(home, { recursive: true });
  const env = isolatedEnv(home, { OPENAI_API_KEY: key, CODEX_HOME: home });
  // 自定义接口声明为独立的 Responses 供应商（与 cc-switch 的写法一致）；用 openai_base_url 会走内置供应商的 websocket，部分中转站会断开。
  // Windows 默认沙箱会拦截所有 shell 调用，Codex 因此认为工作区只读；elevated 沙箱仍只允许写工作区，网络照样关闭。
  const config = {
    ...(agent.provider.baseURL
      ? {
          model_provider: "compete",
          model_providers: {
            compete: {
              name: agent.provider.label,
              base_url: agent.provider.baseURL,
              wire_api: "responses",
              env_key: "OPENAI_API_KEY",
            },
          },
        }
      : {}),
    ...(process.platform === "win32"
      ? { windows: { sandbox: "elevated" } }
      : {}),
  };
  const provider = { apiKey: key };
  const codex = drivers.codex
    ? drivers.codex(env, {
        ...(agent.provider.baseURL ? { baseUrl: agent.provider.baseURL } : {}),
        ...provider,
      })
    : new (
        await loadRuntime<{
          Codex: new (o: Record<string, unknown>) => CodexClient;
        }>("codex")
      ).Codex({
        env,
        ...provider,
        ...(Object.keys(config).length ? { config } : {}),
        ...(runtimeExecutable("codex")
          ? { codexPathOverride: runtimeExecutable("codex") }
          : {}),
      });
  const opts = {
    model: agent.model,
    workingDirectory: task.cwd,
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
  };
  const sessionId = await readState(task.statePath);
  const thread = sessionId
    ? codex.resumeThread(sessionId, opts)
    : codex.startThread(opts);
  const stream = await thread.runStreamed(
    sessionId ? task.prompt : `${task.system}\n\n${task.prompt}`,
    { signal: AbortSignal.timeout(task.timeoutMs) },
  );
  let completed = false;
  for await (const event of stream.events) {
    if (task.eventsPath)
      await appendFile(task.eventsPath, JSON.stringify(event) + "\n", "utf8");
    if (event.type === "thread.started")
      await writeFile(task.statePath, event.thread_id, "utf8");
    if (event.type === "turn.failed")
      throw Error(`Codex Agent 失败：${event.error.message}`);
    if (
      event.type === "error" &&
      !/^Reconnecting\.\.\./.test(String(event.message))
    )
      throw Error(`Codex Agent 失败：${event.message}`);
    if (event.type === "turn.completed") completed = true;
  }
  if (!completed) throw Error("Codex Agent 未报告成功完成");
  return { text: "", sessionId: "", events: [] };
}

const opencodeSdk = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai-compatible",
  gemini: "@ai-sdk/google",
} as const;
const opencodeBase = (p: Provider) =>
  p.protocol === "anthropic"
    ? p.baseURL
      ? `${p.baseURL.replace(/\/$/, "")}/v1`
      : "https://api.anthropic.com/v1"
    : p.protocol === "gemini"
      ? p.baseURL || "https://generativelanguage.googleapis.com/v1beta"
      : p.baseURL || "https://api.openai.com/v1";
/** OpenCode 配置；密钥通过环境变量引用，不写入配置内容或命令行参数。 */
export function opencodeConfig(
  agent: ResolvedAgent,
  kind: Task["kind"],
  system: string,
) {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: {
      compete: {
        npm: opencodeSdk[agent.provider.protocol],
        name: agent.provider.label,
        options: {
          baseURL: opencodeBase(agent.provider),
          apiKey: "{env:COMPETE_AGENT_KEY}",
        },
        models: { [agent.model]: {} },
      },
    },
    agent: {
      compete: {
        mode: "primary",
        prompt: system,
        model: `compete/${agent.model}`,
        steps: agent.maxTurns,
      },
    },
    permission:
      kind === "research"
        ? {
            edit: "deny",
            bash: "deny",
            webfetch: "allow",
            external_directory: "deny",
          }
        : {
            edit: "allow",
            bash: "deny",
            webfetch: "deny",
            external_directory: "deny",
          },
  };
}
async function runOpenCode(agent: ResolvedAgent, task: Task, key: string) {
  const { command, args } = runtimeCommand("opencode", "opencode");
  const home = runtimeHome("opencode");
  const sessionId = await readState(task.statePath);
  const env = isolatedEnv(home, {
    COMPETE_AGENT_KEY: key,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      opencodeConfig(agent, task.kind, task.system),
    ),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  });
  const argv = [
    ...args,
    "run",
    "--pure",
    "--format",
    "json",
    "--agent",
    "compete",
    "-m",
    `compete/${agent.model}`,
    "--dir",
    task.cwd,
    ...(sessionId ? ["--session", sessionId] : []),
    task.prompt,
  ];
  // stdin 必须关闭：opencode run 会等待管道输入直到 EOF。
  return new Promise<{ text: string; sessionId: string; events: unknown[] }>(
    (done, fail) => {
      const child = spawn(command, argv, {
        cwd: task.cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal: AbortSignal.timeout(task.timeoutMs),
      });
      const events: unknown[] = [],
        texts = new Map<string, string[]>();
      let buffer = "",
        stderr = "",
        session = sessionId || "",
        error = "",
        writes = Promise.resolve();
      // 状态同步更新；文件写入排队，结束时统一等待，避免进程退出时还有事件未处理。
      const queue = (write: () => Promise<void>) => {
        writes = writes.then(write).catch(() => {});
      };
      const line = (raw: string) => {
        if (!raw.trim()) return;
        let event: any;
        try {
          event = JSON.parse(raw);
        } catch {
          return;
        }
        events.push(event);
        if (task.eventsPath)
          queue(() => appendFile(task.eventsPath!, raw + "\n", "utf8"));
        if (event.sessionID && event.sessionID !== session) {
          session = event.sessionID;
          const id = session;
          queue(() => writeFile(task.statePath, id, "utf8"));
        }
        if (event.type === "text" && typeof event.part?.text === "string") {
          const id = event.part.messageID || "";
          texts.set(id, [...(texts.get(id) || []), event.part.text]);
        }
        if (event.type === "error")
          error = JSON.stringify(event.error || event).slice(0, 500);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const l of lines) line(l);
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString()).slice(-2000);
      });
      child.once("error", (e) =>
        fail(
          Error(
            e.name === "AbortError"
              ? `OpenCode Agent 超时（${Math.round(task.timeoutMs / 1000)} 秒）`
              : `OpenCode 启动失败：${e.message}`,
          ),
        ),
      );
      child.once("close", async (code) => {
        line(buffer);
        await writes;
        const text = [...texts.values()].at(-1)?.join("") || "";
        if (error) fail(Error(`OpenCode Agent 失败：${error}`));
        else if (code !== 0)
          fail(
            Error(
              `OpenCode 退出码 ${code}：${stderr.trim().split("\n").slice(-3).join(" ")}`,
            ),
          );
        else if (task.kind === "research" && !text)
          fail(Error("研究 Agent 未返回结果"));
        else done({ text, sessionId: session, events });
      });
    },
  );
}

/** 每个 Agent 当前生效的供应商、模型、运行时及其下载和密钥状态，供终端和命令行展示。 */
export function agentRows(cfg: ModelConfig) {
  return agents.map((name) => {
    try {
      const a = resolveAgent(cfg, name);
      return {
        agent: name,
        label: agentLabels[name],
        provider: a.provider.id,
        protocol: a.provider.protocol,
        model: a.model,
        inherited: a.inherited,
        runtime: a.runtime ?? null,
        runtimeReady: a.runtime ? runtimeReady(a.runtime) : null,
        runtimeState: a.runtime ? runtimeStateText(a.runtime) : null,
        keyConfigured: hasKey(a.provider),
        enabled: a.enabled,
        maxTurns: a.maxTurns,
        maxBudgetUsd: a.maxBudgetUsd,
        timeoutSeconds: a.timeoutSeconds,
      };
    } catch (e) {
      return {
        agent: name,
        label: agentLabels[name],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

/** 按 Agent 配置的运行时执行研究或编码任务。 */
export async function runAgentTask(
  agent: ResolvedAgent,
  task: Task,
  drivers: Drivers = {},
) {
  const key = apiKey(agent.provider) || "";
  if (agent.provider.apiKeyEnv && !key)
    throw Error(`缺少 ${agent.provider.apiKeyEnv}`);
  if (agent.runtime === "claude-code")
    return runClaude(agent, task, key, drivers);
  if (agent.runtime === "codex") return runCodex(agent, task, key, drivers);
  if (agent.runtime === "opencode") return runOpenCode(agent, task, key);
  throw Error(`${agent.name} 没有配置运行时`);
}
