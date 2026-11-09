import { traceable } from "langsmith/traceable";
import { Client, RunTree } from "langsmith";

/**
 * LangSmith 追踪。
 *
 * 默认客户端把上传放在后台队列里，用 90 秒超时重试 4 次；端点变慢或不响应时连接一直占着事件循环，
 * CLI 已经干完活却退不出去，看起来就是卡死。这里统一替换成手动 flush 的客户端：
 * 正常运行只入队不阻塞，退出前在明确时限内上传一次，超时就放弃本次上报。
 * 替换 RunTree.sharedClient 后，LangGraph 自己创建的 trace 也使用同一客户端。
 */
const traceTimeoutMs = () =>
  Number(process.env.COMPETITION_TRACE_TIMEOUT_MS || 10_000);
const flushTimeoutMs = () =>
  Number(process.env.COMPETITION_TRACE_FLUSH_TIMEOUT_MS || 3_000);
const tracingEnabled = () =>
  process.env.LANGSMITH_TRACING === "true" ||
  process.env.LANGSMITH_TRACING_V2 === "true";
let shared: Client | undefined;

/** 需要上传时才创建；未开启追踪时完全不加载网络路径，也不改共享客户端。 */
export function tracingClient(): Client | undefined {
  if (!tracingEnabled()) return undefined;
  if (!shared) {
    shared = new Client({
      timeout_ms: traceTimeoutMs(),
      callerOptions: { maxRetries: 0 },
      manualFlushMode: true,
    });
    // SDK 把共享客户端标成 private，但未导出设置方法；LangGraph 的节点 trace 只认这里。
    (RunTree as unknown as { sharedClient: Client }).sharedClient = shared;
  }
  return shared;
}

/**
 * 记录一次模型调用为 LangSmith 运行。未开启追踪时 traceable 直接执行原函数，不联网；
 * 开启后作为 run_type=llm 的子运行嵌在所在的 LangGraph 节点下。
 * 只上传 prompt 与输出摘要，图片按类型和字节数记录，不发送二进制内容。
 */
export async function traceLLM<T>(
  name: string,
  metadata: Record<string, unknown>,
  system: string,
  prompt: string,
  run: () => Promise<T>,
  describe: (value: T) => string,
): Promise<T> {
  const client = tracingClient();
  const traced = traceable(
    async (input: { system: string; prompt: string }) => {
      const value = await run();
      return { value, output: describe(value) };
    },
    {
      name,
      run_type: "llm",
      metadata,
      tags: ["competition-cli"],
      processOutputs: (result: { value: T; output: string }) => ({
        output: result.output,
      }),
      ...(client ? { client } : {}),
    },
  );
  const { value } = await traced({ system, prompt });
  return value;
}

/** 记录一次搜索或外部工具调用，便于在 LangSmith 中对照检索结果与模型输出。 */
export async function traceTool<T>(
  name: string,
  metadata: Record<string, unknown>,
  input: Record<string, unknown>,
  run: () => Promise<T>,
  describe: (value: T) => string,
): Promise<T> {
  const client = tracingClient();
  const traced = traceable(
    async (_input: Record<string, unknown>) => {
      const value = await run();
      return { value, output: describe(value) };
    },
    {
      name,
      run_type: "tool",
      metadata,
      tags: ["competition-cli"],
      processInputs: () => input,
      processOutputs: (result: { value: T; output: string }) => ({
        output: result.output,
      }),
      ...(client ? { client } : {}),
    },
  );
  const { value } = await traced(input);
  return value;
}

/** 进程退出前上传已排队的运行；超过时限就返回，绝不阻塞退出。 */
export async function flushTracing(
  deadlineMs = flushTimeoutMs(),
): Promise<void> {
  if (!shared) return;
  await Promise.race([
    shared.flush().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, deadlineMs).unref()),
  ]);
}

/**
 * 结束一次 CLI 运行。命令的产出都已 await 落盘，这里只等标准输出写完，然后按退出码退出：
 * 上报超时后仍可能有请求挂在事件循环上，主动结束进程才能让终端立刻回到提示符。
 */
export async function finishProcess(code: number): Promise<never> {
  await flushTracing();
  await new Promise<void>((resolve) => {
    if (process.stdout.writableLength === 0) resolve();
    else process.stdout.write("", () => resolve());
  });
  process.exit(code);
}
