import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** 仅保存供应商实际报告的 token；不推算缺失字段、费用或预算单位。 */
const usageKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
] as const;
type UsageKey = (typeof usageKeys)[number];
export type ModelUsage = Partial<Record<UsageKey, number>>;
export type ModelCallContext = {
  callId: string;
  scope: "model" | "runtime";
  operation: "generate" | "inspectImage" | "generateImage" | "investigate" | "buildProject";
  role: string;
  agent: string;
  providerId: string;
  protocol: string;
  model: string;
  stage?: string;
  taskId?: string;
  round?: number;
  runtime?: string;
};
export type ModelCallEvent = ModelCallContext & {
  version: 1;
  attempt: number;
  at: string;
} & (
  | { event: "start" }
  | {
      event: "result";
      status: "success" | "failure";
      durationMs: number;
      usage: ModelUsage | null;
      errorKind?: "empty_response" | "timeout" | "upstream";
    }
);

function cleanUsage(usage: ModelUsage | null | undefined): ModelUsage | null {
  const result: ModelUsage = {};
  for (const key of usageKeys) {
    const value = usage?.[key];
    if (Number.isSafeInteger(value) && value! >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

/** 各协议语义不同：例如 Anthropic 的 input_tokens 不含另列的缓存 token。 */
export function providerUsage(protocol: string, usage: any): ModelUsage | null {
  if (!usage || typeof usage !== "object") return null;
  if (protocol === "gemini")
    return cleanUsage({
      inputTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount,
      cachedInputTokens: usage.cachedContentTokenCount,
      reasoningTokens: usage.thoughtsTokenCount,
    });
  if (protocol === "anthropic")
    return cleanUsage({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens: usage.cache_read_input_tokens,
      cacheWriteInputTokens: usage.cache_creation_input_tokens,
    });
  return cleanUsage({
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens,
  });
}

const pending = new Map<string, Promise<void>>();

/** 同一进程的所有网关实例按入队顺序追加；不覆盖恢复前的历史。 */
export async function appendModelCall(
  dataDir: string,
  jobId: string,
  event: ModelCallEvent,
): Promise<boolean> {
  const folder = resolve(dataDir, "jobs", jobId);
  // 显式白名单，不允许调用方附带 prompt、正文、供应商原始错误或凭据。
  const entry: ModelCallEvent = {
    version: 1,
    callId: event.callId,
    scope: event.scope,
    operation: event.operation,
    role: event.role,
    agent: event.agent,
    providerId: event.providerId,
    protocol: event.protocol,
    model: event.model,
    stage: event.stage,
    taskId: event.taskId,
    round: event.round,
    runtime: event.runtime,
    attempt: event.attempt,
    at: event.at,
    ...(event.event === "start"
      ? { event: "start" as const }
      : {
          event: "result" as const,
          status: event.status,
          durationMs: event.durationMs,
          usage: cleanUsage(event.usage),
          errorKind: event.errorKind,
        }),
  };
  const work = (pending.get(folder) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true });
      await appendFile(join(folder, "model-calls.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    });
  pending.set(folder, work);
  try {
    await work;
    return true;
  } catch {
    // 指标故障不能被当作模型失败重试，也不把可能含敏感信息的 IO 错误写入日志。
    console.warn("[model-metrics] 模型调用指标写入失败，统计可能不完整；不影响模型调用结果。");
    return false;
  } finally {
    if (pending.get(folder) === work) pending.delete(folder);
  }
}

export async function readModelCalls(dataDir: string, jobId: string): Promise<ModelCallEvent[]> {
  const folder = resolve(dataDir, "jobs", jobId);
  await pending.get(folder)?.catch(() => {});
  let raw: string;
  try {
    raw = await readFile(join(folder, "model-calls.jsonl"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return raw.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const entry = JSON.parse(line);
      if (entry.version !== 1 || typeof entry.callId !== "string" || !entry.callId ||
          !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 ||
          !["model", "runtime"].includes(entry.scope) ||
          !["start", "result"].includes(entry.event) ||
          (entry.event === "result" &&
            (!["success", "failure"].includes(entry.status) ||
              !Number.isFinite(entry.durationMs) || entry.durationMs < 0)))
        throw Error("invalid record");
      return [entry as ModelCallEvent];
    } catch {
      // 不静默丢弃损坏行，否则恢复后的汇总会伪装成完整统计。
      throw Error(`model-calls.jsonl 第 ${index + 1} 行损坏，无法可靠汇总模型调用`);
    }
  });
}

function summarizeScope(events: ModelCallEvent[], scope: ModelCallContext["scope"]) {
  const attempts = new Map<string, { context: ModelCallEvent; result?: Extract<ModelCallEvent, { event: "result" }> }>();
  for (const event of events) {
    if (event.scope !== scope) continue;
    const key = `${event.callId}:${event.attempt}`;
    const attempt = attempts.get(key) || { context: event };
    if (event.event === "result") attempt.result = event;
    attempts.set(key, attempt);
  }
  const summary = {
    calls: new Set([...attempts.values()].map((x) => x.context.callId)).size,
    attempts: attempts.size,
    success: 0,
    failure: 0,
    pending: 0,
    durationMs: 0,
    usageKnownAttempts: 0,
    usageUnknownAttempts: 0,
    usage: Object.fromEntries(usageKeys.map((key) => [key, null])) as Record<UsageKey, number | null>,
    usageReportedAttempts: Object.fromEntries(usageKeys.map((key) => [key, 0])) as Record<UsageKey, number>,
  };
  for (const { result } of attempts.values()) {
    if (result) {
      summary[result.status]++;
      summary.durationMs += result.durationMs;
    } else summary.pending++;
    const usage = result && cleanUsage(result.usage);
    if (!usage) {
      summary.usageUnknownAttempts++;
      continue;
    }
    summary.usageKnownAttempts++;
    for (const key of usageKeys) {
      if (usage[key] === undefined) continue;
      summary.usage[key] = (summary.usage[key] ?? 0) + usage[key]!;
      summary.usageReportedAttempts[key]++;
    }
  }
  return summary;
}

/** 顶层只计真实模型请求；runtime 单列外部 Agent 执行，内部请求次数未知。
 * usage 为已报告部分之和，配合 usageReportedAttempts 判断覆盖率，不推算总 token/费用。 */
export function summarizeModelCalls(events: ModelCallEvent[]) {
  return { ...summarizeScope(events, "model"), runtime: summarizeScope(events, "runtime") };
}

export async function readModelMetrics(dataDir: string, jobId: string) {
  return summarizeModelCalls(await readModelCalls(dataDir, jobId));
}
