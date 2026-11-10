import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialGateway, IncompleteModelResponseError } from "../dist/core/gateway.js";
import { readModelCalls, readModelMetrics } from "../dist/core/model-metrics.js";

const body = '{"text":"PRIVATE_OUTPUT"}';
const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
const data = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const chunk = (content, finish_reason = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
const terminal = data(chunk("", "stop"));
const done = data("[DONE]");
const image = { data: Buffer.from("PRIVATE_IMAGE"), mime: "image/png" };
const invoke = (g, operation) => operation === "generate"
  ? g.generate("writer", "PRIVATE_PROMPT") : g.inspectImage("PRIVATE_PROMPT", image);

async function fixture(protocol, reply, run, attempts = 2) {
  const dir = await mkdtemp(join(tmpdir(), "gateway-completion-"));
  const requests = [];
  const progress = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push({ url: req.url, body: JSON.parse(raw) });
    res.setHeader("content-type", "application/json");
    reply(res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cfg = {
    dataDir: dir,
    providers: [{ id: "local", label: "Local", protocol, baseURL: `http://127.0.0.1:${server.address().port}` }],
    agents: {
      writer: { provider: "local", model: "fixed-model" },
      reviewer: { provider: "local", model: "fixed-model" },
    },
    execution: { requestTimeoutSeconds: 30, requestAttempts: attempts },
    search: { provider: "sources" }, sources: [], maxCalls: 10,
  };
  const g = new OfficialGateway(cfg, undefined, "job", {}, (event) => progress.push(event));
  try {
    await run({ g, dir, requests, progress });
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
}
function failure(reason) {
  return (error) => {
    assert.ok(error instanceof IncompleteModelResponseError);
    assert.equal(error.code, "INCOMPLETE_MODEL_RESPONSE");
    assert.equal(error.reason, reason);
    assert.equal(error.retryable, reason === "stream_interrupted");
    assert.ok(error.cause instanceof IncompleteModelResponseError);
    assert.doesNotMatch(error.message, /PRIVATE_/);
    assert.doesNotMatch(error.cause.message, /PRIVATE_/);
    return true;
  };
}
async function assertFailed({ dir, requests, progress }, count) {
  assert.equal(requests.length, count);
  assert.ok(requests.every((r) => r.body.model === "fixed-model" || r.url.includes("fixed-model")));
  assert.ok(progress.every((p) => p.raw === undefined));
  const metrics = await readModelMetrics(dir, "job");
  assert.equal(metrics.success, 0);
  assert.equal(metrics.failure, count);
  const events = await readModelCalls(dir, "job");
  assert.ok(events.filter((e) => e.event === "result").every((e) => e.status === "failure" && e.errorKind === "upstream"));
  assert.doesNotMatch(await readFile(join(dir, "jobs", "job", "model-calls.jsonl"), "utf8"), /PRIVATE_|finish_reason|refusal/);
}
function jsonResponse(protocol, reason, text = body) {
  if (protocol === "gemini") return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: reason }],
  };
  if (protocol === "anthropic") return {
    id: "msg", type: "message", role: "assistant", model: "fixed-model",
    content: [{ type: "text", text }], stop_reason: reason,
  };
  return { choices: [{ message: { content: text }, finish_reason: reason }], usage };
}

const cases = [
  ["openai", "length", "truncated"], ["openai", "max_tokens", "truncated"],
  ["openai", "content_filter", "refused"], ["openai", "tool_calls", "unfinished"],
  ["gemini", "MAX_TOKENS", "truncated"], ["gemini", "CONTINUATION", "truncated"],
  ["gemini", "SAFETY", "refused"], ["gemini", "BLOCKLIST", "refused"],
  ["gemini", "OTHER", "unfinished"],
  ["anthropic", "max_tokens", "truncated"], ["anthropic", "model_context_window_exceeded", "truncated"],
  ["anthropic", "refusal", "refused"], ["anthropic", "pause_turn", "unfinished"],
  ["anthropic", "tool_use", "unfinished"], ["anthropic", "stop_sequence", "unfinished"],
];
for (const operation of ["generate", "inspectImage"]) {
  for (const [protocol, stop, reason] of cases) {
    test(`${protocol} ${operation} ${stop} 拒绝非空 JSON 正文且不重复同一请求`, async () => {
      await fixture(protocol, (res) => res.end(JSON.stringify(jsonResponse(protocol, stop))), async (f) => {
        await assert.rejects(invoke(f.g, operation), failure(reason));
        await assertFailed(f, 1);
      });
    });
  }
  for (const [protocol, stop] of [["openai", "stop"], ["gemini", "STOP"], ["anthropic", "end_turn"]]) {
    test(`${protocol} ${operation} 正常 JSON 终止不要求 usage`, async () => {
      const response = jsonResponse(protocol, stop);
      delete response.usage;
      await fixture(protocol, (res) => res.end(JSON.stringify(response)), async ({ g, dir, requests }) => {
        assert.equal(await invoke(g, operation), body);
        assert.equal(requests.length, 1);
        const metrics = await readModelMetrics(dir, "job");
        assert.equal(metrics.success, 1);
        assert.equal(metrics.usageUnknownAttempts, 1);
      });
    });
  }
  test(`${operation} OpenAI refusal 与 Gemini promptFeedback 阻断优先于非空正文`, async () => {
    for (const protocol of ["openai", "gemini"]) {
      const response = jsonResponse(protocol, protocol === "openai" ? "stop" : "STOP");
      if (protocol === "openai") response.choices[0].message.refusal = "PRIVATE_REFUSAL";
      else response.promptFeedback = { blockReason: "SAFETY", blockReasonMessage: "PRIVATE_REFUSAL" };
      await fixture(protocol, (res) => res.end(JSON.stringify(response)), async (f) => {
        await assert.rejects(invoke(f.g, operation), failure("refused"));
        await assertFailed(f, 1);
      });
    }
  });
  test(`${operation} 空正文也不能掩盖明确截断`, async () => {
    for (const [protocol, stop] of [["openai", "length"], ["gemini", "MAX_TOKENS"], ["anthropic", "max_tokens"]]) {
      await fixture(protocol, (res) => res.end(JSON.stringify(jsonResponse(protocol, stop, ""))), async (f) => {
        await assert.rejects(invoke(f.g, operation), failure("truncated"));
        await assertFailed(f, 1);
      });
    }
  });
  for (const withUsage of [true, false]) {
    test(`SSE ${operation} 正常 terminal ${withUsage ? "有" : "无"} usage 均成功`, async () => {
      await fixture("openai", (res) => {
        res.setHeader("content-type", "text/event-stream");
        // 多行 SSE、CRLF 与分块正文均必须保真。
        res.write(': keep-alive\r\n\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"完整');
        res.write('正文"},"finish_reason":null}]}\r\n\r\n');
        res.write(terminal);
        if (withUsage) res.write(data({ choices: [], usage }));
        res.end("data: [DONE]");
      }, async ({ g, dir, requests }) => {
        assert.equal(await invoke(g, operation), "完整正文");
        assert.equal(requests.length, 1);
        const metrics = await readModelMetrics(dir, "job");
        assert.equal(metrics.success, 1);
        assert.equal(metrics.usageKnownAttempts, Number(withUsage));
        assert.equal(metrics.usageUnknownAttempts, Number(!withUsage));
      });
    });
  }
}

for (const [name, tail, reason] of [
  ["长度截断", data(chunk("", "length")) + done, "truncated"],
  ["安全终止", data(chunk("", "content_filter")) + done, "refused"],
  ["拒绝片段", data({ choices: [{ delta: { refusal: "PRIVATE_REFUSAL" } }] }) + terminal + done, "refused"],
  ["非法事件", "data: {broken\n\n" + terminal + done, "invalid_response"],
  ["错误事件", data({ error: { message: "PRIVATE_ERROR" } }) + terminal + done, "invalid_response"],
  ["命名错误事件", "event: error\ndata: PRIVATE_ERROR\n\n" + done, "invalid_response"],
  ["终止之后仍有正文", terminal + data(chunk("PRIVATE_EXTRA")) + done, "invalid_response"],
]) {
  test(`SSE ${name} 不返回已收到的合法 JSON 前缀`, async () => {
    await fixture("openai", (res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end(data(chunk(body)) + tail);
    }, async (f) => {
      await assert.rejects(f.g.generate("writer", "PRIVATE_PROMPT"), failure(reason));
      await assertFailed(f, 1);
    });
  });
}
for (const [name, tail] of [["缺全部终止", ""], ["只有 DONE", done], ["只有 stop", terminal]]) {
  test(`SSE 非空 ${name} 重试有界且最终明确失败`, async () => {
    await fixture("openai", (res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end(data(chunk(body)) + tail);
    }, async (f) => {
      await assert.rejects(f.g.generate("writer", "PRIVATE_PROMPT"), failure("stream_interrupted"));
      await assertFailed(f, 2);
      const events = await readModelCalls(f.dir, "job");
      assert.equal(new Set(events.map((e) => e.callId)).size, 1);
    });
  });
}
for (const socketClose of [false, true]) {
  test(`SSE ${socketClose ? "socket中断" : "无terminal正常EOF"} 后重试只返回新请求的完整正文`, async () => {
    await fixture("openai", (res, count) => {
      res.setHeader("content-type", "text/event-stream");
      if (count === 1) {
        res.write(data(chunk("PRIVATE_PREFIX")));
        if (socketClose) setTimeout(() => res.destroy(), 20);
        else res.end();
      } else res.end(data(chunk("完整新正文")) + terminal + done);
    }, async ({ g, dir, requests, progress }) => {
      assert.equal(await g.generate("writer", "PRIVATE_PROMPT"), "完整新正文");
      assert.equal(requests.length, 2);
      assert.ok(progress.filter((p) => p.raw !== undefined).every((p) => p.raw === "完整新正文"));
      const metrics = await readModelMetrics(dir, "job");
      assert.equal(metrics.failure, 1);
      assert.equal(metrics.success, 1);
      assert.equal(metrics.usageUnknownAttempts, 2);
    });
  });
}
test("OpenAI 已截断的 HTTP JSON 包络拒绝为类型化失败", async () => {
  await fixture("openai", (res) => res.end('{"choices":[{"message":{"content":"PRIVATE_PREFIX'), async (f) => {
    await assert.rejects(f.g.generate("writer", "PRIVATE_PROMPT"), failure("invalid_response"));
    await assertFailed(f, 1);
  });
});
for (const protocol of ["openai", "gemini", "anthropic"]) {
  for (const operation of ["generate", "inspectImage"]) {
    for (const reason of [undefined, null]) {
      test(`${protocol} ${operation} 非空 HTTP JSON 结束字段 ${reason} 必须失败`, async () => {
        await fixture(protocol, (res) => res.end(JSON.stringify(jsonResponse(protocol, reason))), async (f) => {
          await assert.rejects(invoke(f.g, operation), failure("unfinished"));
          await assertFailed(f, 1);
        });
      });
    }
  }
}
