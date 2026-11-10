import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { Document, Packer, Paragraph } from "docx";
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import {
  fetchDocument, saveSourceBestEffort, MAX_SOURCE_BYTES,
} from "../dist/competition/sources.js";

async function localServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function storeStub() {
  const attempts = [], evidence = [];
  return { attempts, evidence,
    sourceAttempt: (...args) => attempts.push(args),
    putEvidence: (item) => evidence.push(item),
  };
}
function observedResponse({ status = 200, headers = {}, chunkSize = 1024, chunks = 1 } = {}) {
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      state.pulls++;
      if (state.pulls > chunks) controller.close();
      else controller.enqueue(new Uint8Array(chunkSize).fill(65));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, response: new Response(body, { status, headers: { "content-type": "text/plain", ...headers } }) };
}

test("Content-Length 预检超限：不读取正文，取消响应且不重复下载", async (t) => {
  const { response, state } = observedResponse({ headers: { "content-length": String(MAX_SOURCE_BYTES + 1) } });
  const fetch = t.mock.method(globalThis, "fetch", async () => response);
  t.mock.method(console, "error", () => {});
  const store = storeStub();
  assert.equal(await saveSourceBestEffort(store, "id", "https://example.invalid/large", "official"), null);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(state.pulls, 0);
  assert.equal(state.cancelled, true);
  assert.equal(response.body.locked, false);
  assert.equal(store.attempts.length, 1);
  assert.match(store.attempts[0][3], /超过 15 MB/);
  assert.equal(store.evidence.length, 0);
});

test("缺失或低报 Content-Length 时按实际字节中止并释放 reader", async (t) => {
  for (const headers of [{}, { "content-length": "10" }]) {
    const { response, state } = observedResponse({ headers, chunkSize: 1_000_000, chunks: 100 });
    const fetch = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(fetchDocument("https://example.invalid/stream"), /超过 15 MB/);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(state.pulls, 16, "超过上限的块后不再读取");
    assert.equal(state.cancelled, true);
    assert.equal(response.body.locked, false);
    fetch.mock.restore();
  }
});

test("真实无 Content-Length 大流在下载完成前断开连接", async (t) => {
  let sent = 0, requests = 0, notifyClosed;
  const closed = new Promise((resolve) => { notifyClosed = resolve; });
  const total = 80_000_000;
  const url = await localServer(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => {
      sent += 256_000;
      res.write(Buffer.alloc(256_000, 65));
      if (sent >= total) res.end();
    }, 2);
    res.on("close", () => { clearInterval(timer); notifyClosed(); });
  });
  await assert.rejects(fetchDocument(url), /超过 15 MB/);
  await Promise.race([closed, delay(2000).then(() => { throw Error("超限后未及时关闭连接"); })]);
  assert.equal(requests, 1);
  assert.ok(sent < total / 2, `只应下载限额附近字节，实际 ${sent}`);
});

test("gzip 压缩大小未超限时仍限制实际解压字节", async (t) => {
  const compressed = gzipSync(Buffer.alloc(MAX_SOURCE_BYTES + 1, 65));
  let requests = 0;
  const url = await localServer(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": compressed.length });
    res.end(compressed);
  });
  await assert.rejects(fetchDocument(url), /超过 15 MB/);
  assert.equal(requests, 1);
});

test("恰好达到上限的正文允许解析", async (t) => {
  const { response } = observedResponse({ chunkSize: 1_000_000, chunks: 15 });
  t.mock.method(globalThis, "fetch", async () => response);
  const doc = await fetchDocument("https://example.invalid/boundary");
  assert.equal(doc.text.length, 120_000);
});

test("本地正常 HTML、纯文本、XML、PDF、DOCX、PPTX 附件保持可用", async (t) => {
  const pdf = new PDFDocument();
  const pdfChunks = [];
  pdf.on("data", (chunk) => pdfChunks.push(chunk));
  const pdfDone = once(pdf, "end");
  pdf.text("PDF competition notice");
  pdf.end();
  await pdfDone;
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("DOCX competition notice")] }] }));
  const zip = new JSZip();
  zip.file("ppt/slides/slide2.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>PPTX competition notice</a:t></p:sld>');
  zip.file("ppt/slides/slide10.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Later slide</a:t></p:sld>');
  const pptx = await zip.generateAsync({ type: "nodebuffer" });
  const fixtures = new Map([
    ["/html", ["Text/HTML; charset=utf-8", '<title>赛事公告</title><body><h1>比赛报名</h1><a href="/file.docx#top">附件</a><script>ignored</script></body>', "比赛报名"]],
    ["/text", ["text/plain", "纯文本比赛公告", "纯文本比赛公告"]],
    ["/xml", ["application/xml", "<notice>XML competition notice</notice>", "XML competition notice"]],
    ["/gbk", ["text/html; charset=gbk", Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), "中文"]],
    ["/file.pdf", ["application/octet-stream", Buffer.concat(pdfChunks), "PDF competition notice"]],
    ["/file.docx", ["application/octet-stream", docx, "DOCX competition notice"]],
    ["/file.pptx", ["application/octet-stream", pptx, "PPTX competition notice\nLater slide"]],
  ]);
  const url = await localServer(t, (req, res) => {
    const [type, bytes] = fixtures.get(req.url);
    res.writeHead(200, { "content-type": type });
    // 两次 write，确保无 Content-Length 的正常正文也支持。
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    res.write(data.subarray(0, 5));
    res.end(data.subarray(5));
  });
  for (const [path, [, , expected]] of fixtures) {
    const doc = await fetchDocument(url + path);
    assert.ok(doc.text.includes(expected), `${path}: ${doc.text}`);
    assert.equal(doc.url, url + path);
    if (path === "/html") {
      assert.equal(doc.title, "赛事公告");
      assert.deepEqual(doc.links, [{ url: `${url}/file.docx`, title: "附件" }]);
      assert.ok(!doc.text.includes("ignored"));
    }
  }
});

test("永久 HTTP 错误和不支持类型只请求一次并取消响应", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const entry of [{ status: 404 }, { status: 400 }, { status: 501 }, { status: 505 },
    { headers: { "content-type": "image/png" } }]) {
    const { response, state } = observedResponse(entry);
    const fetch = t.mock.method(globalThis, "fetch", async () => response);
    const store = storeStub();
    assert.equal(await saveSourceBestEffort(store, "id", "https://example.invalid/source", "official"), null);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(state.cancelled, true);
    assert.equal(state.pulls, 0);
    assert.equal(store.attempts.length, 1);
    fetch.mock.restore();
  }
});

test("暂时 HTTP 错误可恢复，所有尝试共享同一个截止信号", async (t) => {
  for (const status of [408, 425, 429, 500, 503]) {
    const failed = observedResponse({ status });
    const signals = [];
    const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
      signals.push(init.signal);
      return signals.length === 1 ? failed.response : new Response("比赛公告", { headers: { "content-type": "text/plain" } });
    });
    assert.equal((await fetchDocument("https://example.invalid/retry")).text, "比赛公告");
    assert.equal(signals.length, 2);
    assert.equal(signals[0], signals[1]);
    assert.equal(failed.state.cancelled, true);
    fetch.mock.restore();
  }
});

test("网络或正文连接中断可以重试，三次失败不会被 best-effort 放大", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) return new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }), { headers: { "content-type": "text/plain" } });
    return new Response("已恢复", { headers: { "content-type": "text/plain" } });
  });
  const store = storeStub();
  assert.equal((await saveSourceBestEffort(store, "id", "https://example.invalid/recovery", "official")).text, "已恢复");
  assert.equal(calls, 3);
  assert.equal(store.attempts.length, 1);
  assert.equal(store.evidence.length, 1);
  fetch.mock.restore();
  const responses = [];
  const failing = t.mock.method(globalThis, "fetch", async () => {
    const next = observedResponse({ status: 503 });
    responses.push(next);
    return next.response;
  });
  const failedStore = storeStub();
  assert.equal(await saveSourceBestEffort(failedStore, "id", "https://example.invalid/failure", "official"), null);
  assert.equal(failing.mock.callCount(), 3);
  assert.ok(responses.every(({ state }) => state.cancelled));
  assert.equal(failedStore.attempts.length, 1);
  assert.equal(failedStore.evidence.length, 0);
});

test("本地 503 恢复成功，永久 404 及损坏附件不重试", async (t) => {
  t.mock.method(console, "error", () => {});
  const requests = new Map();
  const url = await localServer(t, (req, res) => {
    const count = (requests.get(req.url) || 0) + 1;
    requests.set(req.url, count);
    if (req.url === "/retry" && count === 1) res.writeHead(503);
    else if (req.url === "/missing") res.writeHead(404);
    else res.writeHead(200, { "content-type": req.url === "/broken.docx" ? "application/octet-stream" : "text/plain" });
    res.end("notice");
  });
  const store = storeStub();
  assert.equal((await saveSourceBestEffort(store, "id", `${url}/retry`, "official")).text, "notice");
  for (const path of ["/missing", "/broken.docx"]) {
    assert.equal(await saveSourceBestEffort(store, "id", url + path, "official"), null);
    assert.equal(requests.get(path), 1);
  }
  assert.equal(requests.get("/retry"), 2);
});

test("已取消不发请求，退避中取消不再重试", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw Error("不应调用"); });
  await assert.rejects(fetchDocument("https://example.invalid/abort", { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(saveSourceBestEffort(storeStub(), "id", "https://example.invalid/abort", "official", undefined, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0);
  fetch.mock.restore();
  const during = new AbortController();
  const retry = t.mock.method(globalThis, "fetch", async () => {
    setTimeout(() => during.abort(), 30);
    return new Response(null, { status: 503 });
  });
  await assert.rejects(fetchDocument("https://example.invalid/abort", { signal: during.signal }), { name: "AbortError" });
  assert.equal(retry.mock.callCount(), 1);
});

test("正文读取中取消会断开本地连接，不保存半截证据", async (t) => {
  const controller = new AbortController();
  let requests = 0, notifyClosed;
  const closed = new Promise((resolve) => { notifyClosed = resolve; });
  const url = await localServer(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    const timer = setTimeout(() => controller.abort(), 50);
    res.on("close", () => { clearTimeout(timer); notifyClosed(); });
  });
  const store = storeStub();
  await assert.rejects(saveSourceBestEffort(store, "id", url, "official", undefined, { signal: controller.signal }), { name: "AbortError" });
  await Promise.race([closed, delay(2000).then(() => { throw Error("取消后未关闭连接"); })]);
  assert.equal(requests, 1);
  assert.equal(store.evidence.length, 0);
});

test("退避期间共享截止时间到期保留 TimeoutError 且不重新开启请求", async (t) => {
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const failed = observedResponse({ status: 503 });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 30);
    return failed.response;
  });
  await assert.rejects(fetchDocument("https://example.invalid/expired-retry"), { name: "TimeoutError" });
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(timeout.mock.calls[0].arguments[0], 30_000);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(failed.state.cancelled, true);
});

test("共享截止时间到期与 AbortError 都不会再尝试 fetch", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new DOMException("deadline", "TimeoutError")));
  const unused = t.mock.method(globalThis, "fetch", async () => { throw Error("不应调用"); });
  await assert.rejects(fetchDocument("https://example.invalid/deadline"), { name: "TimeoutError" });
  assert.equal(timeout.mock.calls[0].arguments[0], 30_000);
  assert.equal(unused.mock.callCount(), 0);
  timeout.mock.restore();
  unused.mock.restore();
  const aborted = t.mock.method(globalThis, "fetch", async () => { throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(fetchDocument("https://example.invalid/abort-error"), { name: "AbortError" });
  assert.equal(aborted.mock.callCount(), 1);
});
