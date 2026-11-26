import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserSessionStore,
  PlaywrightBrowserDriver,
  detectPageGate,
  runBrowserAgent,
  sanitizeProfileName,
} from "../dist/browser/index.js";
import {
  fetchDocumentWithBrowser,
  ingestDownloadedAttachments,
} from "../dist/competition/browser-fetcher.js";
import { fetchDocument } from "../dist/competition/sources.js";
import { Store } from "../dist/core/store.js";

async function startFixtureServer() {
  let lastSubmission = "";
  const server = createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/spa") {
      // 纯 JS 渲染页面：静态 fetch 提取正文为空，内置无头浏览器可完整渲染并下载附件。
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>2026 全国高校创新大赛</title></head>
      <body><div id="app"></div><script>
        document.getElementById("app").innerHTML =
          '<h1>2026 全国高校创新大赛官方通知</h1>' +
          '<p>本赛事面向全日制在校大学生，提交电子方案与源代码。</p>' +
          '<a href="/files/rules-2026.txt" download>下载比赛规程附件</a>';
      </script></body></html>`);
      return;
    }
    if (url === "/files/rules-2026.txt") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="rules-2026.txt"',
      });
      res.end("2026 官方比赛规程：作品须包含完整技术方案与演示程序，截止日期 2026-12-20。");
      return;
    }
    if (url === "/portal" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>作品提交系统</title></head>
      <body>
        <h1>赛事作品提交表单</h1>
        <form id="subForm" method="POST" action="/portal" enctype="multipart/form-data">
          <label>作品名称</label>
          <input id="title" name="title" placeholder="请输入作品名称" />
          <label>上传作品</label>
          <input id="file" name="file" type="file" />
          <button id="submitBtn" type="submit">提交作品</button>
        </form>
      </body></html>`);
      return;
    }
    if (url === "/portal" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastSubmission = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><title>提交成功</title></head>
        <body><h1>提交成功</h1><p>回执编号：SUB-2026-001</p></body></html>`);
      });
      return;
    }
    if (url === "/captcha") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>安全验证</title></head>
      <body><h1>请完成安全验证</h1><p>请拖动滑块完成拼图验证</p></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    getLastSubmission: () => lastSubmission,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("BrowserSessionStore 规范化会话名并支持父域名复用与删除", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acm-session-"));
  try {
    const store = new BrowserSessionStore(dir);
    store.ensureDir();
    assert.equal(sanitizeProfileName("https://www.Saikr.com/vse/1"), "saikr.com");
    const p = store.profilePath("contest.edu.cn");
    await writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
    assert.equal(store.has("contest.edu.cn"), true);
    assert.equal(
      store.resolveForUrl("https://sub.contest.edu.cn/login"),
      p,
    );
    assert.equal(store.list().length, 1);
    assert.equal(store.remove("contest.edu.cn"), true);
    assert.equal(store.list().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detectPageGate 识别验证码、登录墙与支付门禁", () => {
  assert.equal(
    detectPageGate({
      url: "https://a.com/verify",
      title: "验证",
      text: "请完成安全验证后继续",
      hasPasswordInput: false,
      hasCaptchaFrame: false,
    })?.reason,
    "captcha",
  );
  assert.equal(
    detectPageGate({
      url: "https://a.com/passport/login",
      title: "统一登录",
      text: "请输入密码",
      hasPasswordInput: true,
      hasCaptchaFrame: false,
    })?.reason,
    "login",
  );
  assert.equal(
    detectPageGate({
      url: "https://a.com/pay",
      title: "订单支付",
      text: "报名费 50 元，请微信支付",
      hasPasswordInput: false,
      hasCaptchaFrame: false,
    })?.reason,
    "payment",
  );
});

test("静态抓取 SPA 页面失败时自动回退内置无头浏览器并下载附件入库", async () => {
  const srv = await startFixtureServer();
  const dir = await mkdtemp(join(tmpdir(), "acm-spa-"));
  const store = new Store(dir);
  try {
    // 1. 不开 browserFallback 时静态 fetch 应因正文为空失败
    await assert.rejects(() => fetchDocument(`${srv.baseUrl}/spa`));

    // 2. 开启 browserFallback 时自动切换无头浏览器成功拿到渲染正文
    const doc = await fetchDocument(`${srv.baseUrl}/spa`, {
      browserFallback: { dataDir: dir },
    });
    assert.match(doc.title, /2026 全国高校创新大赛/);
    assert.match(doc.text, /全日制在校大学生/);

    // 3. 完整抓取并下载比赛规程附件、写入 SQLite 证据库
    const dlDir = join(dir, "attachments");
    const full = await fetchDocumentWithBrowser(`${srv.baseUrl}/spa`, {
      dataDir: dir,
      downloadDir: dlDir,
      downloadAttachments: true,
    });
    assert.equal(full.downloads.length, 1);
    assert.equal(existsSync(full.downloads[0].savedPath), true);
    const compId = store.addCompetition(full.url, full.title);
    const count = await ingestDownloadedAttachments(store, compId, full.downloads);
    assert.equal(count, 1);
    const ev = store.evidence(compId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, "attachment");
    assert.match(ev[0].text, /2026-12-20/);
  } finally {
    store.close();
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("内置无头浏览器 Computer-Use 代理支持填表、上传白名单校验、提交前拦截与正式提交", async () => {
  const srv = await startFixtureServer();
  const dir = await mkdtemp(join(tmpdir(), "acm-agent-"));
  const driver = new PlaywrightBrowserDriver();
  try {
    const uploadFile = join(dir, "my-entry.txt");
    await writeFile(uploadFile, "COMPETITION_ENTRY_PAYLOAD_2026", "utf8");

    // 场景 A：stopBeforeSubmit=true 填完并上传后在点击提交按钮前安全拦截
    const actionsA = [
      JSON.stringify({ action: "fill", ref: "e1", value: "智能环保作品" }),
      JSON.stringify({ action: "upload", ref: "e2", files: [uploadFile] }),
      JSON.stringify({ action: "click", ref: "e3" }),
    ];
    let idxA = 0;
    const sessionA = await driver.open({ headless: true, downloadDir: dir });
    try {
      const resA = await runBrowserAgent(
        sessionA,
        {
          supportsVision: false,
          async decide() {
            return actionsA[idxA++] || JSON.stringify({ action: "done", summary: "ok" });
          },
        },
        "填写并提交作品",
        {
          startUrl: `${srv.baseUrl}/portal`,
          maxSteps: 6,
          traceDir: join(dir, "trace-a"),
          stopBeforeSubmit: true,
          allowedUploadFiles: [uploadFile],
        },
      );
      assert.equal(resA.status, "needs_human");
      assert.equal(resA.humanReason, "confirm_submit");
      assert.equal(srv.getLastSubmission(), "");
    } finally {
      await sessionA.close();
    }

    // 场景 B：stopBeforeSubmit=false 完成提交并回传服务器已收到的文件
    const actionsB = [
      JSON.stringify({ action: "fill", ref: "e1", value: "智能环保作品" }),
      JSON.stringify({ action: "upload", ref: "e2", files: [uploadFile] }),
      JSON.stringify({ action: "click", ref: "e3" }),
      JSON.stringify({ action: "done", summary: "已提交，回执 SUB-2026-001" }),
    ];
    let idxB = 0;
    const sessionB = await driver.open({ headless: true, downloadDir: dir });
    try {
      const resB = await runBrowserAgent(
        sessionB,
        {
          supportsVision: false,
          async decide() {
            return actionsB[idxB++];
          },
        },
        "填写并提交作品",
        {
          startUrl: `${srv.baseUrl}/portal`,
          maxSteps: 6,
          traceDir: join(dir, "trace-b"),
          stopBeforeSubmit: false,
          allowedUploadFiles: [uploadFile],
        },
      );
      assert.equal(resB.status, "completed");
      assert.match(srv.getLastSubmission(), /COMPETITION_ENTRY_PAYLOAD_2026/);
      assert.match(srv.getLastSubmission(), /智能环保作品/);
      const trace = await readFile(join(dir, "trace-b", "trace.jsonl"), "utf8");
      assert.ok(trace.split("\n").filter(Boolean).length >= 3);
    } finally {
      await sessionB.close();
    }

    // 场景 C：遇到验证码页面立即停止并移交人工，不尝试绕过
    const sessionC = await driver.open({ headless: true, downloadDir: dir });
    try {
      const resC = await runBrowserAgent(
        sessionC,
        {
          supportsVision: false,
          async decide() {
            throw Error("不应在验证码页面调用模型决策");
          },
        },
        "访问目标页",
        { startUrl: `${srv.baseUrl}/captcha`, maxSteps: 3 },
      );
      assert.equal(resC.status, "needs_human");
      assert.equal(resC.humanReason, "captcha");
    } finally {
      await sessionC.close();
    }
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});
