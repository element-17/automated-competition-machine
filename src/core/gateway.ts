import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  appendModelCall,
  providerUsage,
  type ModelCallContext,
  type ModelCallEvent,
  type ModelUsage,
} from "./model-metrics.js";
import {
  executionSettings,
  searchSettings,
  type AppConfig,
  type SearchSettings,
} from "./config.js";
import type {
  ModelGateway,
  ModelRole,
  SearchOptions,
  SearchResult,
} from "./types.js";
import { promptOf, type AgentName } from "../agents/prompts.js";
import {
  apiKey,
  resolveAgent,
  runtimeProtocols,
  protocolLabels,
  type ResolvedAgent,
} from "../agents/models.js";
import { runtimeReady } from "../agents/runtimes.js";
import { runAgentTask, type Drivers } from "../agents/agents.js";
import type { Store } from "./store.js";
import { saveJobProgress, type JobProgress } from "./job-progress.js";
import { traceLLM, traceTool } from "./tracing.js";
import { assertJobCanRun } from "./job-control.js";

/** 解析模型结构化输出；失败时保留模型原文，便于定位模型到底返回了什么。 */
export function parseJSON(raw: string): unknown {
  let s = raw.trim();
  if (s.startsWith("```"))
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(s);
  } catch {
    // 模型有时在 JSON 前后附带思考或说明：只要其中有一段完整、可解析的 JSON 就取用它。
    const embedded = embeddedJSON(s);
    if (embedded !== undefined) return embedded;
    const shown =
      s.length > 12000
        ? `${s.slice(0, 12000)}\n…（原始返回过长，已截断；完整内容长度 ${s.length} 字符）`
        : s;
    throw Error(
      `模型返回的结构化数据不是有效 JSON；原始内容如下（未被当作事实保存）：\n--- 模型原始返回开始 ---\n${shown}\n--- 模型原始返回结束 ---`,
    );
  }
}
const agentNames: Record<AgentName, string> = {
  writer: "写作",
  reviewer: "评审",
  planner: "调度规划",
  screener: "搜索结果评估",
  research: "研究",
  coder: "编码",
  layout: "排版",
  image: "图片",
};
export type GatewayProgress = {
  agent: AgentName;
  model: string;
  provider: string;
  action: string;
  raw?: string;
  stage?: string;
  taskId?: string;
  round?: number;
  maxRounds?: number;
  elapsedSeconds?: number;
  budget?: { used: number; limit: number };
};

/** 空正文属于单次上游请求失败，包括只返回 reasoning/thinking 的响应。 */
export class EmptyModelResponseError extends Error {
  readonly code = "EMPTY_MODEL_RESPONSE";
  readonly retryable = true;
  constructor(message = "模型返回空正文（empty response；思考过程不作为正文）", options?: ErrorOptions) {
    super(message, options);
    this.name = "EmptyModelResponseError";
  }
}
export type IncompleteResponseReason =
  | "truncated" | "refused" | "unfinished"
  | "stream_interrupted" | "invalid_response";

/** 不保留响应正文或供应商错误原文；仅连接不完整允许在既有预算内重试。 */
/**
 * 搜索接口按关键词工作：把过长的模型输出压缩成可检索的短查询。
 * 只保留前若干关键词，去掉标点与换行；正常短查询原样返回。
 */
export function normalizeQuery(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) return compact;
  // 超长时取开头与结尾的关键名词性片段，避免只剩“现有方案”这类泛词。
  const head = compact.slice(0, 80);
  const tokens = compact.split(/[\s，,。.；;：:、()（）【】\[\]"'“”]+/).filter((x) => x.length >= 2);
  const picked: string[] = [];
  for (const token of tokens) {
    if (picked.join(" ").length >= 100) break;
    if (!picked.includes(token)) picked.push(token);
  }
  return (picked.length ? picked.join(" ") : head).slice(0, 120);
}

export class IncompleteModelResponseError extends Error {
  readonly code = "INCOMPLETE_MODEL_RESPONSE";
  readonly retryable: boolean;
  constructor(
    readonly reason: IncompleteResponseReason,
    message = `模型响应未完整完成（${reason}）；不接受部分正文`,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IncompleteModelResponseError";
    this.retryable = reason === "stream_interrupted";
  }
}
const requireBody = (text: string) => {
  if (!text.trim()) throw new EmptyModelResponseError();
  return text;
};
const requireCompletedBody = (text: string, completed: boolean) => {
  // 空正文仍由 requestText 在同一请求边界内分类及重试。
  if (text.trim() && !completed) throw new IncompleteModelResponseError("unfinished");
  return text;
};
type AttemptUsage = { usage: ModelUsage | null };

// 显式失败优先于空正文分类；非空 HTTP JSON 还必须提供明确正常终止状态。
function checkOpenAICompletion(reason: unknown, refusal: unknown) {
  if (typeof refusal === "string" && refusal.length > 0)
    throw new IncompleteModelResponseError("refused");
  if (reason === "length" || reason === "max_tokens")
    throw new IncompleteModelResponseError("truncated");
  if (reason === "content_filter" || reason === "refusal")
    throw new IncompleteModelResponseError("refused");
  if (reason != null && reason !== "stop")
    throw new IncompleteModelResponseError("unfinished");
}
function checkGeminiCompletion(response: GenerateContentResponse) {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked && blocked !== "BLOCKED_REASON_UNSPECIFIED")
    throw new IncompleteModelResponseError("refused");
  const reason = response.candidates?.[0]?.finishReason;
  if (reason === "MAX_TOKENS" || reason === "CONTINUATION")
    throw new IncompleteModelResponseError("truncated");
  if (reason && ["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST",
    "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"].includes(reason))
    throw new IncompleteModelResponseError("refused");
  if (reason != null && reason !== "STOP")
    throw new IncompleteModelResponseError("unfinished");
}
function checkAnthropicCompletion(response: Anthropic.Message) {
  const reason = response.stop_reason;
  if (reason === "max_tokens" || reason === "model_context_window_exceeded")
    throw new IncompleteModelResponseError("truncated");
  if (reason === "refusal") throw new IncompleteModelResponseError("refused");
  if (reason != null && reason !== "end_turn")
    throw new IncompleteModelResponseError("unfinished");
}

/** 按文件头判断图片类型。 */
const sniff = (b: Buffer) =>
  b[0] === 0x89 && b[1] === 0x50
    ? "image/png"
    : b[0] === 0xff && b[1] === 0xd8
      ? "image/jpeg"
      : b.subarray(8, 12).toString() === "WEBP"
        ? "image/webp"
        : "image/png";
export class OfficialGateway implements ModelGateway {
  private phase: JobProgress | undefined;
  constructor(
    private cfg: AppConfig,
    private store?: Store,
    private jobId?: string,
    private drivers: Drivers = {},
    private onProgress?: (event: GatewayProgress) => void,
  ) {}
  get canSearch() {
    return this.cfg.search?.provider !== "sources";
  }
  private charge(count = 1) {
    if (this.jobId && this.store) {
      assertJobCanRun(this.store, this.jobId);
      this.store.reserveCalls(this.jobId, count);
    }
  }
  private agent(name: AgentName) {
    return resolveAgent(this.cfg, name);
  }
  private key(a: ResolvedAgent) {
    const key = apiKey(a.provider);
    if (a.provider.apiKeyEnv && !key)
      throw Error(`缺少 ${a.provider.apiKeyEnv}`);
    return key || "none";
  }
  async reportProgress(event: JobProgress) {
    this.phase = event;
    const agent: AgentName =
      event.stage === "planning"
        ? "planner"
        : event.stage === "review"
          ? "reviewer"
          : event.stage === "research"
            ? "research"
            : "writer";
    const a = this.agent(agent),
      job = this.jobId && this.store ? this.store.job(this.jobId) : null;
    const enriched = {
      ...event,
      ...(job ? { budget: { used: job.calls, limit: job.maxCalls } } : {}),
    };
    this.onProgress?.({
      agent,
      model: a.model,
      provider: a.provider.label,
      ...enriched,
    });
    if (this.jobId)
      await saveJobProgress(this.cfg.dataDir, this.jobId, enriched);
  }
  private async tracked<T>(
    a: ResolvedAgent,
    action: string,
    run: () => Promise<T>,
    limitMs?: number,
  ): Promise<T> {
    const started = Date.now();
    let writes = Promise.resolve();
    const emit = (message: string) => {
      const job = this.jobId && this.store ? this.store.job(this.jobId) : null;
      const progress = {
        ...this.phase,
        stage: a.name,
        action: message,
        elapsedSeconds: Math.floor((Date.now() - started) / 1000),
        ...(job ? { budget: { used: job.calls, limit: job.maxCalls } } : {}),
      };
      this.onProgress?.({
        agent: a.name,
        model: a.model,
        provider: a.provider.label,
        ...progress,
      });
      if (this.jobId)
        writes = writes
          .then(() => saveJobProgress(this.cfg.dataDir, this.jobId!, progress))
          .catch(() => {});
    };
    // 明确写出本次调用最多会持续多久：只显示“仍在执行”无法区分慢请求和卡死。
    const bound = limitMs
      ? `；本次调用最多 ${Math.round(limitMs / 1000)} 秒（含重试）`
      : "";
    emit(action);
    const timer = setInterval(
      () => emit(`${action}；仍在执行${bound}`),
      15_000,
    );
    timer.unref();
    try {
      const result = await run();
      emit(`${action}完成`);
      return result;
    } catch (e) {
      emit(`${action}未完成，保留已有进度`);
      throw e;
    } finally {
      clearInterval(timer);
      await writes;
    }
  }
  /** role 只决定任务类型；模型、供应商和系统提示词都按 agent 读取，未指定时与 role 相同。 */
  async generate(role: ModelRole, prompt: string, agent: AgentName = role) {
    this.charge();
    const a = this.agent(agent);
    const context = this.callContext(a, "generate", role);
    try {
      const system = promptOf(this.cfg, agent);
      const budgetMs =
        executionSettings(this.cfg).requestTimeoutSeconds *
        executionSettings(this.cfg).requestAttempts *
        1000;
      const text = await this.tracked(
        a,
        "调用模型",
        () =>
          traceLLM(
            `${agentNames[agent]}调用`,
            {
              agent,
              providerId: a.provider.id,
              providerLabel: a.provider.label,
              model: a.model,
              protocol: a.provider.protocol,
              ls_provider: a.provider.id,
              ls_model_name: a.model,
              ...(this.jobId ? { jobId: this.jobId } : {}),
            },
            system,
            prompt,
            () => this.complete(a, system, prompt, context),
            (value) => value,
          ),
        budgetMs,
      );
      this.onProgress?.({
        agent,
        model: a.model,
        provider: a.provider.label,
        action: "模型返回",
        raw: text,
      });
      return text;
    } catch (e) {
      const message = `${agentNames[agent]}模型（${a.provider.label}）调用失败：${e instanceof Error ? e.message : String(e)}；不会切换其他模型`;
      throw e instanceof EmptyModelResponseError
        ? new EmptyModelResponseError(message, { cause: e })
        : e instanceof IncompleteModelResponseError
          ? new IncompleteModelResponseError(e.reason, message, { cause: e })
          : new Error(message, { cause: e });
    }
  }
  private callContext(
    a: ResolvedAgent,
    operation: ModelCallContext["operation"],
    role: string,
    scope: ModelCallContext["scope"] = "model",
  ): ModelCallContext {
    return {
      callId: randomUUID(),
      scope,
      operation,
      role,
      agent: a.name,
      providerId: a.provider.id,
      protocol: a.provider.protocol,
      model: a.model,
      stage: this.phase?.stage,
      taskId: this.phase?.taskId,
      round: this.phase?.round,
      ...(scope === "runtime" ? { runtime: a.runtime } : {}),
    };
  }
  private async measured<T>(
    context: ModelCallContext,
    attempt: number,
    run: (metrics: AttemptUsage) => Promise<T>,
  ): Promise<T> {
    const record = (event: ModelCallEvent) => this.jobId
      ? appendModelCall(this.cfg.dataDir, this.jobId, event)
      : Promise.resolve(false);
    const started = performance.now();
    const startWrite = record({ ...context, version: 1, attempt, at: new Date().toISOString(), event: "start" });
    const metrics: AttemptUsage = { usage: null };
    let result: ModelCallEvent;
    try {
      const value = await run(metrics);
      result = { ...context, version: 1, attempt, at: new Date().toISOString(), event: "result", status: "success", durationMs: performance.now() - started, usage: metrics.usage };
      return value;
    } catch (error) {
      result = {
        ...context, version: 1, attempt, at: new Date().toISOString(),
        event: "result", status: "failure", durationMs: performance.now() - started, usage: metrics.usage,
        errorKind: error instanceof EmptyModelResponseError ? "empty_response"
          : error instanceof Error && /timeout|abort/i.test(error.name) ? "timeout" : "upstream",
      };
      throw error;
    } finally {
      // IO 从不影响成功/失败判定；等待刷盘便于调用方随后读取完整记录。
      await Promise.all([startWrite, record(result!)]);
    }
  }
  private async complete(
    a: ResolvedAgent,
    system: string,
    prompt: string,
    context: ModelCallContext,
  ): Promise<string> {
    this.key(a);
    return this.requestText(context, (timeout, metrics) =>
      this.completeOnce(a, system, prompt, timeout, metrics));
  }
  private async requestText(
    context: ModelCallContext,
    run: (timeoutMs: number, metrics: AttemptUsage) => Promise<string>,
  ): Promise<string> {
    // 文本和看图共用截止时间，退避与所有尝试都计入同一个总时限。
    const settings = executionSettings(this.cfg),
      deadline = Date.now() + settings.requestTimeoutSeconds * settings.requestAttempts * 1000;
    let last: unknown;
    for (let attempt = 0; attempt < settings.requestAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        return await this.measured(context, attempt + 1, async (metrics) =>
          requireBody(await run(Math.min(settings.requestTimeoutSeconds * 1000, remaining), metrics)));
      } catch (e) {
        last = e;
        if (!this.retryable(e)) throw e;
        if (attempt === settings.requestAttempts - 1) break;
        const pause = Math.min(2000 * 3 ** attempt, 30000, deadline - Date.now());
        if (pause <= 0) break;
        await new Promise((r) => setTimeout(r, pause));
      }
    }
    throw (last || Error(`模型调用超过 ${settings.requestTimeoutSeconds * settings.requestAttempts} 秒总时限`));
  }
  private retryable(error: unknown) {
    if (error instanceof EmptyModelResponseError || error instanceof IncompleteModelResponseError)
      return error.retryable;
    const message = error instanceof Error ? error.message : String(error);
    // 中转站和长连接常见 "terminated"、"other side closed"、"premature close"，
    // 都属于连接被对端中断，重试通常能成功。
    return /timeout|timed out|aborted|abort|terminated|other side closed|premature close|fetch failed|network|socket|ECONN|EPIPE|ETIMEDOUT|429|500|502|503|504|52[0-4]|overloaded|temporar|rate.?limit|without output text|reasoning without|empty (?:response|content)/i.test(
      message,
    );
  }
  private async completeOnce(
    a: ResolvedAgent,
    system: string,
    prompt: string,
    timeoutMs: number,
    metrics: AttemptUsage,
  ): Promise<string> {
    const key = this.key(a),
      signal = AbortSignal.timeout(timeoutMs),
      p = a.provider,
      // 输出上限：写作/研究类长文最容易撞到供应商默认 8k，按配置给足。
      maxOutput = executionSettings(this.cfg).maxOutputTokens;
    if (p.protocol === "gemini") {
      const baseUrl = p.baseURL || process.env.COMPETE_GEMINI_BASE_URL;
      const response = await new GoogleGenAI({
        apiKey: key,
        httpOptions: { ...(baseUrl ? { baseUrl } : {}), retryOptions: { attempts: 1 } },
      }).models.generateContent({
        model: a.model,
        contents: prompt,
        config: {
          systemInstruction: system,
          abortSignal: signal,
          maxOutputTokens: maxOutput,
        },
      });
      metrics.usage = providerUsage(p.protocol, response.usageMetadata);
      checkGeminiCompletion(response);
      return requireCompletedBody(response.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought && typeof part.text === "string")
        .map((part) => part.text).join("") || "", response.candidates?.[0]?.finishReason === "STOP");
    }
    if (p.protocol === "anthropic") {
      const deepseek = /(^|\.)deepseek\.com$/.test(
        p.baseURL ? new URL(p.baseURL).hostname : "",
      );
      const client = new Anthropic({
        apiKey: key,
        maxRetries: 0,
        ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      });
      const body = {
        model: a.model,
        max_tokens: maxOutput,
        system,
        ...(deepseek ? { thinking: { type: "disabled" as const } } : {}),
        messages: [{ role: "user" as const, content: prompt }],
      };
      // Anthropic 协议的非流式请求有 10 分钟上限保护（max_tokens>8192 会被 SDK 直接拒绝），
      // 因此该协议按 SDK 允许的上限封顶；真正的长文额度由 OpenAI 兼容协议提供。
      const response = await client.messages.create(
        { ...body, max_tokens: Math.min(maxOutput, 8192) },
        { signal },
      );
      metrics.usage = providerUsage(p.protocol, response?.usage);
      checkAnthropicCompletion(response);
      return requireCompletedBody((response?.content || [])
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n"), response.stop_reason === "end_turn");
    }
    // 流式请求：长文生成时中转站（Cloudflare 等）在约 100 秒无数据后会返回 524；服务端不支持流式而直接返回 JSON 时照常解析。
    // 524 也常表示“上游等待首个字节超时”，此时非流式反而更稳，因此 524 后降级重试一次。
    const base = (p.baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
    const request = (stream: boolean) => fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream, application/json" : "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: a.model,
        stream,
        max_tokens: maxOutput,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    const res = await request(true);
    if (res.status !== 524) return this.responseText(res, metrics);
    // 先读完错误体释放连接，再用非流式重试；非流式不受中转站“无数据 100 秒”限制。
    await res.text().catch(() => "");
    return this.responseText(await request(false), metrics);
  }
  private async responseText(res: Response, metrics: AttemptUsage): Promise<string> {
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as any;
      throw Error(`HTTP ${res.status} ${json?.error?.message || ""}`.trim());
    }
    if (!/text\/event-stream/i.test(res.headers.get("content-type") || "")) {
      let json: any;
      try {
        json = await res.json();
      } catch {
        throw new IncompleteModelResponseError("invalid_response");
      }
      metrics.usage = providerUsage("openai", json?.usage);
      if (json?.error) throw new IncompleteModelResponseError("invalid_response");
      const choice = json?.choices?.[0];
      checkOpenAICompletion(choice?.finish_reason, choice?.message?.refusal);
      const content = choice?.message?.content;
      return requireCompletedBody(typeof content === "string" ? content : "", choice?.finish_reason === "stop");
    }
    if (!res.body) throw new EmptyModelResponseError();
    let text = "", buffer = "", eventType = "";
    let dataLines: string[] = [];
    let stopped = false, done = false;
    const decoder = new TextDecoder();
    const event = () => {
      const data = dataLines.join("\n").trim(), type = eventType;
      dataLines = [];
      eventType = "";
      if (type === "error") throw new IncompleteModelResponseError("invalid_response");
      if (!data) return;
      if (done) throw new IncompleteModelResponseError("invalid_response");
      if (data === "[DONE]") { done = true; return; }
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new IncompleteModelResponseError("invalid_response");
      }
      const usage = providerUsage("openai", chunk?.usage);
      if (usage) metrics.usage = { ...metrics.usage, ...usage };
      if (chunk?.error) throw new IncompleteModelResponseError("invalid_response");
      const choice = chunk?.choices?.[0];
      checkOpenAICompletion(choice?.finish_reason, choice?.delta?.refusal ?? choice?.message?.refusal);
      // reasoning/thinking 不作为正文；不能以已收到前缀代替完整终止信息。
      const delta = choice?.delta?.content ?? choice?.message?.content;
      if (typeof delta === "string" && delta) {
        if (stopped) throw new IncompleteModelResponseError("invalid_response");
        text += delta;
      }
      if (choice?.finish_reason === "stop") stopped = true;
    };
    const line = (raw: string) => {
      const value = raw.replace(/\r$/, "");
      if (!value) { event(); return; }
      if (value.startsWith("data:")) dataLines.push(value.slice(5).replace(/^ /, ""));
      else if (value.startsWith("event:")) eventType = value.slice(6).trim();
    };
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const l of lines) line(l);
      }
      line(buffer + decoder.decode());
      event();
    } catch (error) {
      if (error instanceof IncompleteModelResponseError) throw error;
      throw new IncompleteModelResponseError("stream_interrupted");
    }
    // 保留完全空/只含思考响应的原有重试分类；显式错误已在上面优先拒绝。
    requireBody(text);
    if (!stopped || !done) throw new IncompleteModelResponseError("stream_interrupted");
    return text;
  }
  /** 未传 options 时只取一页且不限时间，供研究往届资料使用；赛事发现会传入配置的页数和时间范围。 */
  async search(rawQuery: string, options: SearchOptions = {}) {
    const search = searchSettings(this.cfg);
    if (search.provider === "sources")
      throw Error("来源列表模式未配置全网关键词搜索");
    // 模型偶尔把整段方案正文当查询词；截成关键词片段既省配额也更容易有结果。
    const queryText = normalizeQuery(rawQuery);
    if (!queryText) throw Error("搜索词为空");
    const pages = options.pages ?? 1,
      timeRange = options.timeRange ?? "any";
    const found: SearchResult[] = [];
    for (let page = 1; page <= pages; page++) {
      let batch: SearchResult[];
      try {
        batch = await traceTool(
          `${search.provider} 搜索`,
          { provider: search.provider, page, timeRange },
          { query: queryText, page, timeRange },
          () => this.searchPage(search, queryText, page, timeRange),
          (value) => value.map((x) => `${x.title} ${x.url}`).join("\n"),
        );
      } catch (e) {
        if (page === 1) throw e;
        break;
      }
      const fresh = batch.filter((x) => !found.some((y) => y.url === x.url));
      found.push(...fresh);
      if (!fresh.length) break;
    }
    return found;
  }
  private async searchPage(
    search: SearchSettings,
    queryText: string,
    page: number,
    timeRange: SearchOptions["timeRange"],
  ): Promise<SearchResult[]> {
    let url: URL;
    const headers: Record<string, string> = { accept: "application/json" };
    if (search.provider === "brave") {
      if (!process.env.BRAVE_SEARCH_API_KEY)
        throw Error("缺少 BRAVE_SEARCH_API_KEY；也可配置 SearXNG");
      url = new URL(
        search.url || "https://api.search.brave.com/res/v1/web/search",
      );
      url.searchParams.set("q", queryText);
      url.searchParams.set("count", "20");
      if (page > 1)
        url.searchParams.set("offset", String(Math.min(9, page - 1)));
      const fresh = {
        day: "pd",
        week: "pw",
        month: "pm",
        year: "py",
      } as Record<string, string>;
      if (timeRange && fresh[timeRange])
        url.searchParams.set("freshness", fresh[timeRange]);
      headers["X-Subscription-Token"] = process.env.BRAVE_SEARCH_API_KEY;
    } else {
      if (!search.url) throw Error("SearXNG 缺少 search.url");
      url = new URL(
        "search",
        search.url.endsWith("/") ? search.url : `${search.url}/`,
      );
      url.searchParams.set("q", queryText);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", String(page));
      if (search.language) url.searchParams.set("language", search.language);
      if (timeRange && timeRange !== "any")
        url.searchParams.set("time_range", timeRange);
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok)
      throw Error(
        search.provider === "searxng" && res.status === 403
          ? "SearXNG 拒绝 JSON 请求 (403)；请在 settings.yml 的 search.formats 中加入 json"
          : `搜索服务失败 (${res.status})`,
      );
    const json = (await res.json()) as any;
    const results =
      search.provider === "brave" ? json.web?.results : json.results;
    if (!Array.isArray(results)) throw Error("搜索服务没有返回有效结果");
    if (
      !results.length &&
      page === 1 &&
      Array.isArray(json.unresponsive_engines) &&
      json.unresponsive_engines.length
    )
      throw Error(
        `SearXNG 引擎均无结果：${json.unresponsive_engines.map((x: unknown) => (Array.isArray(x) ? x.join(" ") : String(x))).join("；")}`,
      );
    return results
      .filter((x: any) => typeof x.url === "string")
      .map((x: any) => ({
        url: x.url,
        title: String(x.title || x.url),
        snippet: String(x.description || x.content || ""),
      }));
  }
  /** 把实际图片交给评审模型看图评审；用于图片作品和 PPT 中图片的视觉验收。 */
  async inspectImage(
    prompt: string,
    image: { data: Buffer; mime: string },
    agent: AgentName = "reviewer",
  ) {
    this.charge();
    const a = this.agent(agent);
    const system = promptOf(this.cfg, agent);
    const settings = executionSettings(this.cfg);
    try {
      this.key(a);
      return await this.tracked(
        a,
        "查看图片并评审",
        () => this.requestText(this.callContext(a, "inspectImage", "reviewer"),
          (timeout, metrics) => this.inspectImageOnce(a, system, prompt, image, timeout, metrics)),
        settings.requestTimeoutSeconds * settings.requestAttempts * 1000,
      );
    } catch (e) {
      const message = `${agentNames[agent]}模型（${a.provider.label}）看图调用失败：${e instanceof Error ? e.message : String(e)}；不会切换其他模型`;
      throw e instanceof EmptyModelResponseError
        ? new EmptyModelResponseError(message, { cause: e })
        : e instanceof IncompleteModelResponseError
          ? new IncompleteModelResponseError(e.reason, message, { cause: e })
          : new Error(message, { cause: e });
    }
  }
  private async inspectImageOnce(
    a: ResolvedAgent,
    system: string,
    prompt: string,
    image: { data: Buffer; mime: string },
    timeoutMs: number,
    metrics: AttemptUsage,
  ): Promise<string> {
    const b64 = image.data.toString("base64");
    const key = this.key(a),
      signal = AbortSignal.timeout(timeoutMs),
      p = a.provider;
    if (p.protocol === "anthropic") {
      const deepseek = /(^|\.)deepseek\.com$/.test(
        p.baseURL ? new URL(p.baseURL).hostname : "",
      );
      const r = await new Anthropic({
        apiKey: key,
        maxRetries: 0,
        ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      }).messages.create(
        {
          model: a.model,
          max_tokens: 4096,
          system,
          ...(deepseek ? { thinking: { type: "disabled" as const } } : {}),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mime as "image/png",
                    data: b64,
                  },
                },
                { type: "text", text: prompt },
              ],
            },
          ],
        },
        { signal },
      );
      metrics.usage = providerUsage(p.protocol, r?.usage);
      checkAnthropicCompletion(r);
      return requireCompletedBody((r?.content || [])
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n"), r.stop_reason === "end_turn");
    }
    if (p.protocol === "gemini") {
      const baseUrl = p.baseURL || process.env.COMPETE_GEMINI_BASE_URL;
      const r = await new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          ...(baseUrl ? { baseUrl } : {}),
          retryOptions: { attempts: 1 },
        },
      }).models.generateContent({
        model: a.model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: image.mime, data: b64 } },
              { text: prompt },
            ],
          },
        ],
        config: { systemInstruction: system, abortSignal: signal },
      });
      metrics.usage = providerUsage(p.protocol, r.usageMetadata);
      checkGeminiCompletion(r);
      return requireCompletedBody(r.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought && typeof part.text === "string")
        .map((part) => part.text).join("") || "", r.candidates?.[0]?.finishReason === "STOP");
    }
    const base = (p.baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: a.model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${image.mime};base64,${b64}` },
              },
            ],
          },
        ],
      }),
    });
    return this.responseText(res, metrics);
  }
  async generateImage(
    prompt: string,
    options?: { orientation?: "landscape" | "portrait" | "square" },
  ) {
    this.charge();
    const a = this.agent("image");
    this.onProgress?.({
      agent: "image",
      model: a.model,
      provider: a.provider.label,
      action: "生成图片",
    });
    try {
      const orientationHint =
        options?.orientation === "portrait"
          ? "\nComposition orientation: vertical portrait framing (height greater than width)."
          : options?.orientation === "square"
            ? "\nComposition orientation: 1:1 square framing."
            : "";
      const full = `${promptOf(this.cfg, "image")}\n\n${prompt}${orientationHint}`;
      const signal = AbortSignal.timeout(
        executionSettings(this.cfg).requestTimeoutSeconds * 1000,
      );
      this.key(a);
      if (!["openai", "gemini"].includes(a.provider.protocol))
        throw Error("图片生成只支持 Gemini 协议或 OpenAI 兼容的 images/generations 接口");
      return await this.tracked(a, "生成图片", () =>
        this.measured(this.callContext(a, "generateImage", "image"), 1, async (metrics) => {
          const image = a.provider.protocol === "openai"
            ? await this.openaiImage(a, full, signal, metrics, options?.orientation)
            : await this.geminiImage(a, full, signal, metrics);
          if (!image.data.length || image.data.length > 20_000_000)
            throw Error("图片为空或超过 20 MB");
          return image;
        }),
      );
    } catch (e) {
      throw Error(
        `图片模型调用失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  private async geminiImage(
    a: ResolvedAgent,
    prompt: string,
    signal: AbortSignal,
    metrics: AttemptUsage,
  ) {
    const baseUrl = a.provider.baseURL || process.env.COMPETE_GEMINI_BASE_URL;
    const response = await new GoogleGenAI({
      apiKey: this.key(a),
      httpOptions: { ...(baseUrl ? { baseUrl } : {}), retryOptions: { attempts: 1 } },
    }).models.generateContent({
      model: a.model,
      contents: prompt,
      config: { responseModalities: ["TEXT", "IMAGE"], abortSignal: signal },
    });
    metrics.usage = providerUsage(a.provider.protocol, response.usageMetadata);
    const part = response.candidates
      ?.flatMap((c) => c.content?.parts || [])
      .find(
        (p) =>
          p.inlineData?.data &&
          /^image\/(png|jpeg|webp)$/.test(p.inlineData.mimeType || ""),
      );
    if (!part?.inlineData?.data) throw Error("图片模型未返回图片");
    return {
      data: Buffer.from(part.inlineData.data, "base64"),
      mime: part.inlineData.mimeType!,
    };
  }
  /** OpenAI 兼容的 images/generations（gpt-image 等）；返回 b64_json 或图片 URL。 */
  private async openaiImage(
    a: ResolvedAgent,
    prompt: string,
    signal: AbortSignal,
    metrics: AttemptUsage,
    orientation?: "landscape" | "portrait" | "square",
  ) {
    const base = (a.provider.baseURL || "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    const size =
      orientation === "portrait"
        ? "1024x1536"
        : orientation === "square"
          ? "1024x1024"
          : "1536x1024";
    const res = await fetch(`${base}/images/generations`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.key(a)}`,
      },
      body: JSON.stringify({ model: a.model, prompt, size, n: 1 }),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok)
      throw Error(`HTTP ${res.status} ${json?.error?.message || ""}`.trim());
    metrics.usage = providerUsage(a.provider.protocol, json?.usage);
    const item = json?.data?.[0];
    if (item?.b64_json) {
      const data = Buffer.from(item.b64_json, "base64");
      return { data, mime: sniff(data) };
    }
    if (typeof item?.url === "string") {
      const img = await fetch(item.url, { signal });
      if (!img.ok) throw Error(`下载图片失败 (${img.status})`);
      const data = Buffer.from(await img.arrayBuffer());
      return { data, mime: sniff(data) };
    }
    throw Error("图片模型未返回图片");
  }
  private runnable(name: "research" | "coder") {
    const a = this.agent(name);
    if (a.runtime && !runtimeProtocols[a.runtime].includes(a.provider.protocol))
      throw Error(
        `${agentNames[name]} Agent 的运行时 ${a.runtime} 不支持 ${protocolLabels[a.provider.protocol]}，请在 Agent 设置中调整`,
      );
    this.key(a);
    return a;
  }
  private async runLongTask(
    a: ResolvedAgent,
    task: Parameters<typeof runAgentTask>[1],
  ) {
    const deadline = Date.now() + task.timeoutMs;
    const context = this.callContext(a, task.kind === "research" ? "investigate" : "buildProject", a.name, "runtime");
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error("Agent 执行超时，进度已保留");
      if (attempt)
        this.charge(
          task.kind === "research" || a.runtime === "claude-code"
            ? a.maxTurns
            : 8,
        );
      try {
        return await this.measured(context, attempt + 1, () => runAgentTask(
          a,
          { ...task, timeoutMs: remaining },
          this.drivers,
        ));
      } catch (e) {
        last = e;
        const message = e instanceof Error ? e.message : String(e);
        if (
          attempt === 2 ||
          !/network|socket|ECONN|暂时|临时|退出码/i.test(message)
        )
          throw e;
        await new Promise((r) =>
          setTimeout(
            r,
            Math.min(1500 * 2 ** attempt, Math.max(0, deadline - Date.now())),
          ),
        );
      }
    }
    throw last;
  }
  async investigate(prompt: string) {
    if (!this.jobId) throw Error("研究 Agent 必须绑定任务");
    const a = this.runnable("research");
    this.onProgress?.({
      agent: "research",
      model: a.model,
      provider: a.provider.label,
      action: "运行研究 Agent（检索和核对网页）",
    });
    this.charge(a.maxTurns);
    const folder = join(
      this.cfg.dataDir,
      "jobs",
      this.jobId,
      "claude-research",
    );
    await mkdir(folder, { recursive: true });
    return this.tracked(a, "研究运行时执行", () =>
      this.runLongTask(a, {
        kind: "research",
        cwd: folder,
        prompt,
        system: promptOf(this.cfg, "research"),
        statePath: join(folder, "session.txt"),
        eventsPath: join(folder, "events.jsonl"),
        timeoutMs: a.timeoutSeconds * 1000,
      }),
    );
  }
  async buildProject(workspace: string, prompt: string) {
    const a = this.runnable("coder");
    this.onProgress?.({
      agent: "coder",
      model: a.model,
      provider: a.provider.label,
      action: "运行编码 Agent（生成软件作品）",
    });
    this.charge(a.runtime === "claude-code" ? a.maxTurns : 8);
    const state = {
      codex: ".codex-thread-id",
      "claude-code": ".claude-session-id",
      opencode: ".opencode-session-id",
    }[a.runtime!];
    const base = join(this.cfg.dataDir, "jobs", this.jobId || "unbound", "agent-runtime");
    const workspacePath = resolve(workspace);
    const runtimeDir = join(base, Buffer.from(workspacePath).toString("hex").slice(-48));
    await mkdir(runtimeDir, { recursive: true });
    await this.tracked(a, "编码运行时执行", () =>
      this.runLongTask(a, {
        kind: "code",
        cwd: workspace,
        runtimeHome: join(runtimeDir, "home"),
        prompt,
        system: promptOf(this.cfg, "coder"),
        statePath: join(runtimeDir, state),
        eventsPath: join(runtimeDir, "events.jsonl"),
        timeoutMs: a.timeoutSeconds * 1000,
      }),
    );
  }
  async testAgent(
    name: AgentName,
  ): Promise<{
    agent: AgentName;
    model: string;
    provider: string;
    runtime?: string;
    detail: string;
  }> {
    const a = this.agent(name);
    this.key(a);
    if (a.runtime) {
      if (!runtimeProtocols[a.runtime].includes(a.provider.protocol))
        throw Error(
          `${name} 的运行时 ${a.runtime} 不支持 ${a.provider.protocol} 协议`,
        );
      if (!runtimeReady(a.runtime))
        throw Error(`${name} 的运行时 ${a.runtime} 未下载`);
      return {
        agent: name,
        model: a.model,
        provider: a.provider.label,
        runtime: a.runtime,
        detail: "密钥、协议和运行时均可用（未启动实际任务）",
      };
    }
    if (name === "image") {
      const img = await this.generateImage("Minimalist clean geometric icon on white background, no text.");
      return {
        agent: name,
        model: a.model,
        provider: a.provider.label,
        detail: `图片模型已成功响应（${img.mime}, ${img.data.length} bytes）`,
      };
    }
    await this.generate("reviewer", "只回复 OK。", name);
    return {
      agent: name,
      model: a.model,
      provider: a.provider.label,
      detail: "模型已成功响应",
    };
  }
}

/** 从夹带说明文字的返回里取出第一段完整 JSON 对象/数组；截断或损坏的 JSON 不会被修补。 */
function embeddedJSON(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (--depth) continue;
        try {
          const value = JSON.parse(text.slice(start, i + 1));
          if (value && typeof value === "object") return value;
        } catch { /* 不是有效 JSON，继续找下一段 */ }
        break;
      }
    }
  }
  return undefined;
}
