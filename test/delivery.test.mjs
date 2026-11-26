import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserDeliveryChannel,
  DeliveryRegistry,
  EmailDeliveryChannel,
  createDefaultDeliveryRegistry,
  detectSubmissionTargets,
  draftSubmissionEmail,
  resolveJobDeliverableFiles,
} from "../dist/delivery/index.js";
import { Store } from "../dist/core/store.js";

test("detectSubmissionTargets 自动从规则档案与证据提取投稿邮箱和在线提交网址", () => {
  const targets = detectSubmissionTargets(
    {
      title: "全国大学生绿色设计大赛",
      edition: "2026",
      eligibility: null,
      deadline: null,
      ai_rules: null,
      scoring: null,
      deliverables: [
        {
          type: "设计方案",
          quantity: "1",
          formats: ["pdf"],
          limits: [],
          naming: "学校-姓名-作品名.pdf",
          attachments: [],
          submission:
            "请发至 committee@green-contest.edu.cn（邮件主题：学校+姓名+作品名），或登录 https://submit.green-contest.edu.cn/upload 提交",
          official_template: null,
        },
      ],
      requires_idea: true,
      missing: [],
      citations: [],
      research: { past_winners: [], past_works: [], judging: [], missing: [] },
    },
    "https://green-contest.edu.cn",
  );
  assert.equal(targets[0].channel, "email");
  assert.equal(targets[0].target, "committee@green-contest.edu.cn");
  assert.match(targets[0].subjectHint || "", /学校\+姓名\+作品名/);
  assert.ok(
    targets.some(
      (t) =>
        t.channel === "browser" &&
        t.target === "https://submit.green-contest.edu.cn/upload",
    ),
  );
});

test("EmailDeliveryChannel 支持演练生成 .eml 预览、SMTP 正式发送与 Store 回执持久化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acm-email-"));
  const store = new Store(dir);
  const oldPass = process.env.TEST_SMTP_PASS;
  process.env.TEST_SMTP_PASS = "fake-auth-code";
  try {
    const jobDir = join(dir, "jobs", "job-1");
    await mkdir(join(jobDir, "final"), { recursive: true });
    const entryFile = join(jobDir, "final", "方案正文.txt");
    await writeFile(entryFile, "这是完整的参赛方案内容", "utf8");

    const resolved = resolveJobDeliverableFiles(jobDir);
    assert.deepEqual(resolved.files, [entryFile]);

    const drafted = draftSubmissionEmail({
      competitionTitle: "2026 创新挑战赛",
      files: resolved.files,
      profile: { school: "示例大学", name: "张三", phone: "13800000000" },
    });
    assert.match(drafted.subject, /示例大学-张三/);
    assert.match(drafted.body, /方案正文\.txt/);

    // 1. 演练模式：生成真实 .eml 文件，不发信
    const registry = createDefaultDeliveryRegistry();
    const dryReceipt = await registry.execute(
      {
        jobId: "job-1",
        competitionId: "comp-1",
        competitionTitle: "2026 创新挑战赛",
        files: resolved.files,
        profile: { school: "示例大学", name: "张三" },
        dryRun: true,
        target: { channel: "email", address: "judge@contest.edu.cn" },
      },
      { dataDir: dir },
    );
    assert.equal(dryReceipt.status, "dry_run");
    assert.ok(dryReceipt.previewPath && existsSync(dryReceipt.previewPath));
    const eml = await readFile(dryReceipt.previewPath, "utf8");
    assert.match(eml, /To: judge@contest\.edu\.cn/);

    // 2. 正式发送（注入 mock transport，完全解耦真实 SMTP 服务器）
    let sentMail = null;
    const customRegistry = new DeliveryRegistry().register(
      new EmailDeliveryChannel(() => ({
        async sendMail(opts) {
          sentMail = opts;
          return { messageId: "<mock-msg-2026@contest>" };
        },
      })),
    );
    const liveReceipt = await customRegistry.execute(
      {
        jobId: "job-1",
        competitionId: "comp-1",
        competitionTitle: "2026 创新挑战赛",
        files: resolved.files,
        profile: { school: "示例大学", name: "张三" },
        dryRun: false,
        target: { channel: "email", address: "judge@contest.edu.cn" },
      },
      {
        dataDir: dir,
        email: {
          host: "smtp.example.com",
          port: 465,
          secure: true,
          user: "sender@example.com",
          passwordEnv: "TEST_SMTP_PASS",
        },
      },
    );
    assert.equal(liveReceipt.status, "delivered");
    assert.equal(liveReceipt.messageId, "<mock-msg-2026@contest>");
    assert.equal(sentMail.to, "judge@contest.edu.cn");
    assert.equal(sentMail.attachments.length, 1);

    // 3. 写入并查询 Store 回执
    store.addDelivery(liveReceipt);
    const saved = store.deliveries("job-1");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].messageId, "<mock-msg-2026@contest>");
  } finally {
    if (oldPass === undefined) delete process.env.TEST_SMTP_PASS;
    else process.env.TEST_SMTP_PASS = oldPass;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("BrowserDeliveryChannel 支持演练截图预览与自动上传交付，并支持注册自定义通道", async () => {
  let received = "";
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>在线交稿平台</title></head>
      <body>
        <form method="POST" action="/upload" enctype="multipart/form-data">
          <input name="team" placeholder="团队名" />
          <input name="work" type="file" />
          <button type="submit">提交</button>
        </form>
      </body></html>`);
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>交稿成功</h1></body></html>");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  const dir = await mkdtemp(join(tmpdir(), "acm-bdel-"));
  try {
    const file = join(dir, "entry.pdf");
    await writeFile(file, "PDF_CONTENT_TEST");

    const registry = new DeliveryRegistry().register(new BrowserDeliveryChannel());

    // 演练模式：打开页面识别文件控件并截预览图
    const dry = await registry.execute(
      {
        jobId: "job-b1",
        competitionId: "comp-b1",
        competitionTitle: "测试赛",
        files: [file],
        dryRun: true,
        target: { channel: "browser", url },
      },
      { dataDir: dir },
    );
    assert.equal(dry.status, "dry_run");
    assert.ok(dry.previewPath && existsSync(dry.previewPath));
    assert.match(dry.summary, /文件上传控件 1 个/);

    // 正式提交模式（stopBeforeSubmit=false）
    const steps = [
      JSON.stringify({ action: "fill", ref: "e1", value: "先锋队" }),
      JSON.stringify({ action: "upload", ref: "e2", files: [file] }),
      JSON.stringify({ action: "click", ref: "e3" }),
      JSON.stringify({ action: "done", summary: "平台显示交稿成功" }),
    ];
    let i = 0;
    const live = await registry.execute(
      {
        jobId: "job-b1",
        competitionId: "comp-b1",
        competitionTitle: "测试赛",
        files: [file],
        dryRun: false,
        stopBeforeSubmit: false,
        target: { channel: "browser", url },
      },
      {
        dataDir: dir,
        browserModel: {
          supportsVision: false,
          async decide() {
            return steps[i++];
          },
        },
      },
    );
    assert.equal(live.status, "delivered");
    assert.match(received, /PDF_CONTENT_TEST/);

    // 验证插件化解耦：可无侵入注册第三方新通道
    registry.register({
      id: "webhook",
      label: "自定义 Webhook",
      async validate() {
        return { ok: true, errors: [] };
      },
      async prepare(req) {
        return {
          channel: "webhook",
          summary: "webhook",
          recipient: req.target.url || "",
          files: req.files,
          warnings: [],
        };
      },
      async deliver(req) {
        return {
          id: "wh-1",
          jobId: req.jobId,
          competitionId: req.competitionId,
          channel: "webhook",
          status: "delivered",
          target: req.target.url || "",
          files: req.files,
          summary: "webhook ok",
          createdAt: new Date().toISOString(),
        };
      },
    });
    assert.equal(registry.list().length, 2);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
