import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendModelCall, providerUsage, readModelCalls, readModelMetrics, summarizeModelCalls } from "../dist/core/model-metrics.js";

function event(callId, extra = {}) {
  return {
    version: 1, callId, scope: "model", operation: "generate", role: "writer",
    agent: "writer", providerId: "local", protocol: "openai", model: "fixed",
    attempt: 1, at: new Date().toISOString(), event: "start", ...extra,
  };
}

test("并发追加有序、只写白名单字段，恢复后保留历史", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-metrics-"));
  try {
    assert.equal((await readModelMetrics(dir, "job")).attempts, 0);
    const records = Array.from({ length: 40 }, (_, i) => event(`call-${i}`, {
      prompt: "PRIVATE_PROMPT", content: "PRIVATE_CONTENT", apiKey: "PRIVATE_KEY",
    }));
    assert.ok((await Promise.all(records.map((e) => appendModelCall(dir, "job", e)))).every(Boolean));
    const path = join(dir, "jobs", "job", "model-calls.jsonl");
    const first = await readFile(path, "utf8");
    assert.doesNotMatch(first, /PRIVATE_|prompt|content|apiKey/);
    assert.deepEqual((await readModelCalls(dir, "job")).map((e) => e.callId), records.map((e) => e.callId));
    await appendModelCall(dir, "job", event("resumed"));
    assert.ok((await readFile(path, "utf8")).startsWith(first));
    const summary = await readModelMetrics(dir, "job");
    assert.equal(summary.calls, 41);
    assert.equal(summary.attempts, 41);
    assert.equal(summary.pending, 41);
    assert.equal(summary.usageUnknownAttempts, 41);
    assert.equal(summary.usage.totalTokens, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("汇总去重 start/result，失败计入且不估算缺失 usage 或运行时模型次数", () => {
  const result = event("one", { event: "result", status: "failure", durationMs: 11, usage: { inputTokens: 7 }, errorKind: "empty_response" });
  const events = [
    event("one"), result, result,
    event("one", { attempt: 2 }),
    event("one", { attempt: 2, event: "result", status: "success", durationMs: 17, usage: { inputTokens: 0, outputTokens: 5, totalTokens: 8 } }),
    event("interrupted"),
    event("orphan-result", { event: "result", status: "success", durationMs: 3, usage: null }),
    event("runtime", { scope: "runtime", operation: "investigate" }),
    event("runtime", { scope: "runtime", operation: "investigate", event: "result", status: "success", durationMs: 50, usage: null }),
  ];
  const summary = summarizeModelCalls(events);
  assert.equal(summary.calls, 3);
  assert.equal(summary.attempts, 4);
  assert.equal(summary.failure, 1);
  assert.equal(summary.success, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.durationMs, 31);
  assert.equal(summary.usageKnownAttempts, 2);
  assert.equal(summary.usageUnknownAttempts, 2);
  assert.equal(summary.usage.inputTokens, 7);
  assert.equal(summary.usage.totalTokens, 8);
  assert.equal(summary.usage.cachedInputTokens, null);
  assert.equal(summary.usageReportedAttempts.inputTokens, 2);
  assert.equal(summary.usageReportedAttempts.totalTokens, 1);
  assert.equal(summary.runtime.attempts, 1);
  assert.equal(summary.runtime.durationMs, 50);
  assert.equal(summary.runtime.usageUnknownAttempts, 1);
});

test("真实 usage 严格保留供应商语义，缺省与无效值未知而不是零或估算", () => {
  assert.equal(providerUsage("openai", undefined), null);
  assert.equal(providerUsage("openai", { prompt_tokens: -2, completion_tokens: "8", total_tokens: NaN }), null);
  assert.deepEqual(providerUsage("openai", { prompt_tokens: 0, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } }), { inputTokens: 0, outputTokens: 5, reasoningTokens: 3 });
  assert.deepEqual(providerUsage("anthropic", { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 9, cache_creation_input_tokens: 8 }), { inputTokens: 2, outputTokens: 4, cachedInputTokens: 9, cacheWriteInputTokens: 8 });
  assert.deepEqual(providerUsage("gemini", { promptTokenCount: 2, candidatesTokenCount: 4, thoughtsTokenCount: 10, totalTokenCount: 16 }), { inputTokens: 2, outputTokens: 4, totalTokens: 16, reasoningTokens: 10 });
});

test("指标写入失败明确报告且队列可以恢复，损坏历史不能静默忽略", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-metrics-failure-"));
  const warn = console.warn;
  const warnings = [];
  try {
    console.warn = (...args) => warnings.push(args.join(" "));
    await writeFile(join(dir, "jobs"), "blocked");
    assert.equal(await appendModelCall(dir, "job", event("failed-write")), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /统计可能不完整/);
    await rm(join(dir, "jobs"));
    assert.equal(await appendModelCall(dir, "job", event("recovered")), true);
    assert.equal((await readModelCalls(dir, "job")).length, 1);
    await writeFile(join(dir, "jobs", "job", "model-calls.jsonl"), '{"interrupted":');
    await assert.rejects(readModelMetrics(dir, "job"), /第 1 行损坏/);
  } finally {
    console.warn = warn;
    await rm(dir, { recursive: true, force: true });
  }
});
