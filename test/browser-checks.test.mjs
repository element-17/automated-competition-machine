import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import JSZip from "jszip";
import {
  BrowserSuite,
  browserAvailability,
  inspectSoftware,
} from "../dist/artifacts/browser-checks.js";

const suite = {
  cases: [
    {
      name: "加入待办",
      criterion: 0,
      steps: [
        { action: "fill", selector: "#title", value: "提交作品" },
        { action: "click", selector: "#add" },
      ],
      expect: [{ selector: "#items", text: "提交作品" }],
    },
  ],
};
const html = (script) =>
  `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>待办</title><body><label>任务<input id="title"></label><button id="add">添加</button><ul id="items"></ul><script>${script}</script></body></html>`;

test(
  "真实 Chromium 执行交互、桌面与手机检查，并保存截图和文件指纹",
  { skip: !browserAvailability().available },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-real-"));
    try {
      const artifact = join(dir, "app.html");
      await writeFile(
        artifact,
        html(
          "document.querySelector('#add').onclick=()=>{const item=document.createElement('li');item.textContent=document.querySelector('#title').value;document.querySelector('#items').append(item)}",
        ),
      );
      const report = await inspectSoftware(
        artifact,
        join(dir, "reports"),
        suite,
      );
      assert.equal(report.status, "passed", JSON.stringify(report.issues));
      assert.equal(report.cases[0].status, "passed");
      assert.equal(report.screenshots.length, 3);
      assert.match(report.artifactSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(
        JSON.parse(await readFile(report.reportPath, "utf8")),
        report,
      );
      assert.equal(
        (await readFile(report.screenshots[0])).subarray(1, 4).toString(),
        "PNG",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "错误交互及 JavaScript 错误导致失败，页面能打开不会冒充功能通过",
  { skip: !browserAvailability().available },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-fail-"));
    try {
      const artifact = join(dir, "app.html");
      await writeFile(
        artifact,
        html(
          "document.querySelector('#add').onclick=()=>{document.querySelector('#items').textContent='错误结果'}",
        ),
      );
      const report = await inspectSoftware(artifact, join(dir, "bad"), suite);
      assert.equal(report.status, "failed");
      assert.match(report.issues.join(" "), /未出现预期文字/);
      await writeFile(artifact, html("throw Error('broken-page')"));
      const broken = await inspectSoftware(artifact, join(dir, "error"));
      assert.equal(broken.status, "failed");
      assert.match(broken.issues.join(" "), /broken-page/);
      await writeFile(artifact, html(""));
      // 没有交互用例、没有截图，不能算通过。
      const untested = await inspectSoftware(artifact, join(dir, "none"));
      assert.equal(untested.status, "failed");
      assert.match(untested.issues.join(" "), /用例|截图/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "实际 ZIP 缺资源和外网访问被识别，外部服务器没有收到请求",
  { skip: !browserAvailability().available },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-offline-"));
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      res.end("external");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const archive = new JSZip();
      archive.file(
        "index.html",
        html(`fetch('http://127.0.0.1:${server.address().port}/private')`) +
          '<script src="missing.js"></script>',
      );
      const artifact = join(dir, "app.zip");
      await writeFile(
        artifact,
        await archive.generateAsync({ type: "nodebuffer" }),
      );
      const report = await inspectSoftware(
        artifact,
        join(dir, "reports"),
        suite,
      );
      assert.equal(report.status, "failed");
      assert.match(report.issues.join(" "), /missing.js|资源错误/);
      assert.equal(hits, 0);
      archive.file("missing.js", "// 本地资源已补齐");
      await writeFile(artifact, await archive.generateAsync({ type: "nodebuffer" }));
      const dynamic = await inspectSoftware(artifact, join(dir, "dynamic"), suite);
      assert.equal(dynamic.status, "failed");
      assert.match(dynamic.issues.join(" "), /Content Security Policy|blocked|Refused to connect/);
      assert.equal(hits, 0, "静态资源齐全时仍禁止运行期间访问外部服务");
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("拒绝归档越界与任意脚本步骤；浏览器缺失直接判失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-guard-"));
  const previous = process.env.COMPETE_BROWSER_EXECUTABLE;
  try {
    assert.equal(
      BrowserSuite.safeParse({
        cases: [
          {
            ...suite.cases[0],
            steps: [
              { action: "evaluate", selector: "body", value: "fetch(...)" },
            ],
          },
        ],
      }).success,
      false,
    );
    const zip = new JSZip();
    zip.file("index.html", html(""));
    zip.file("../outside.txt", "escape");
    const artifact = join(dir, "app.zip");
    await writeFile(artifact, await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(
      (await inspectSoftware(artifact, join(dir, "bad"))).status,
      "failed",
    );
    process.env.COMPETE_BROWSER_EXECUTABLE = join(dir, "missing.exe");
    const page = join(dir, "app.html");
    await writeFile(page, html(""));
    // 浏览器缺失时验收必须失败，不能以“未核实”蒙混过关。
    const report = await inspectSoftware(page, join(dir, "missing"), suite);
    assert.equal(report.status, "failed");
    assert.match(report.issues.join(" "), /浏览器不可用/);
    assert.equal(report.screenshots.length, 0);
  } finally {
    if (previous === undefined) delete process.env.COMPETE_BROWSER_EXECUTABLE;
    else process.env.COMPETE_BROWSER_EXECUTABLE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
