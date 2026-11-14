import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Document, Packer, Paragraph } from "docx";

// 仅替换本测试进程加载时捕获的 exec；不依赖真实 Office，也不改公共导出接口。
let renderer;
const originalExec = childProcess.execFile;
const fakeExec = () => { throw Error("expected promisified exec"); };
fakeExec[promisify.custom] = (...args) => renderer(...args);
childProcess.execFile = fakeExec;
syncBuiltinESMExports();
const { checkLayout } = await import("../dist/artifacts/layout-check.js");
const { renderers, textCoverage } = await import("../dist/artifacts/doc-render.js");
childProcess.execFile = originalExec;
syncBuiltinESMExports();
const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "layout-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, options.docx ? "test.docx" : "test.pptx");
  const full = options.full || "可核验的文档正文";
  if (options.docx) await writeFile(file, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(full)] }] })));
  const count = options.count ?? 3, calls = [], prompts = [];
  // Word 文档由同一份渲染结果提供页数、截图和文字；测试用假渲染器代替本机 Word。
  renderers.docx = async () => {
    if (options.renderFail) throw Error("无法把 Word 文档渲染成页面");
    return { pages: count, text: Array.from({ length: count }, (_, i) => i ? "" : options.rendered ?? full),
      png: async () => png, dispose: async () => {} };
  };
  renderer = async (_command, args) => {
    calls.push(args);
    if (args[0] === "--version" || args[0] === "close") return { stdout: "ok", stderr: "" };
    if (args[2] === "stats") return { stdout: options.unknown ? "Paragraphs: 3" : `Pages: ${count}`, stderr: "" };
    const page = Number(args[args.indexOf("--page") + 1]);
    if (args[2] === "screenshot") {
      if (page === options.failPage) throw Object.assign(Error(`Command failed: officecli view ${file} screenshot --page ${page}: renderer crashed`), { stderr: "renderer crashed" });
      if ((!options.repeatForever && page > count) || page === options.rangePage) throw Object.assign(Error(`Command failed: --page ${page}`), { stderr: `Error: Page ${page} is out of range (total ${count})` });
      const image = options.unknown && !options.repeatForever ? await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: page % 255, g: 30, b: 80 } } }).png().toBuffer() : png;
      await writeFile(args[args.indexOf("-o") + 1], options.emptyImage ? Buffer.alloc(0) : image);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "html") {
      if (options.htmlFail) throw Error("html renderer crashed");
      return { stdout: `<html><body>${options.htmlEmpty ? "" : options.html ?? full}</body></html>`, stderr: "" };
    }
    throw Error(`unexpected command ${args}`);
  };
  const gateway = { inspectImage: async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify(options.review ? options.review(prompt) : { issues: [], suggestions: [] });
  } };
  return { file, gateway, calls, prompts };
}

test("第二页渲染失败不能因命令含 --page 当正常结束", async (t) => {
  const x = await setup(t, { failPage: 2 });
  await assert.rejects(checkLayout(x.gateway, x.file), (error) => {
    assert.equal(error.report.totalPages, 3);
    assert.deepEqual(error.report.failedPages, [2]);
    assert.deepEqual(error.report.checkedPages, [1, 3]);
    assert.equal(error.report.complete, false);
    return true;
  });
  assert.ok(x.calls.some((args) => args[0] === "close"));
});

test("41页与相同页面图片全部检查，不以40页截断或去重冒充完整", async (t) => {
  for (const unknown of [false, true]) {
    const x = await setup(t, { count: 41, unknown });
    const report = await checkLayout(x.gateway, x.file);
    assert.equal(report.totalPages, 41);
    assert.equal(report.checked, 41);
    assert.equal(report.checkedPages.at(-1), 41);
    assert.equal(report.complete, true);
    assert.equal(x.prompts.length, 41);
  }
});

test("非连续抽检保留真实总页数和页码且明确未完整覆盖", async (t) => {
  const x = await setup(t, { count: 5, unknown: true });
  const report = await checkLayout(x.gateway, x.file, [3, 1, 3]);
  assert.equal(report.totalPages, 5);
  assert.deepEqual(report.checkedPages, [1, 3]);
  assert.equal(report.complete, false);
  assert.match(report.issues.join(" "), /未完整覆盖/);
  assert.match(x.prompts[1], /第 3 页，共 5 页/);
  assert.doesNotMatch(x.prompts[1], /（最后一页）/);
});

test("已知页数中间页越界也是失败，超过上限明确未完成", async (t) => {
  let x = await setup(t, { rangePage: 2 });
  await assert.rejects(checkLayout(x.gateway, x.file), (error) => error.report.failedPages.includes(2));
  x = await setup(t, { count: 501 });
  await assert.rejects(checkLayout(x.gateway, x.file), (error) => error.report.totalPages === 501 && !error.report.complete);
});

test("Word 渲染失败不能按通过处理；页面没有文字是阻塞缺陷", async (t) => {
  let x = await setup(t, { docx: true, renderFail: true });
  await assert.rejects(checkLayout(x.gateway, x.file), (error) => {
    assert.equal(error.report.complete, false);
    assert.match(error.message, /渲染/);
    return true;
  });
  x = await setup(t, { docx: true, rendered: "" });
  const report = await checkLayout(x.gateway, x.file);
  assert.equal(report.textCoverage, "mismatch");
  assert.match(report.issues.join(" "), /没有任何可提取文字/);
});

test("Word 页数、截图和文字同源：不调用 officecli，抽检仍标明未完整覆盖", async (t) => {
  const x = await setup(t, { docx: true });
  const report = await checkLayout(x.gateway, x.file, [1, 3]);
  assert.equal(report.totalPages, 3);
  assert.equal(report.complete, false);
  assert.equal(report.textCoverage, "verified");
  assert.deepEqual(x.calls, []);
  assert.match(x.prompts[1], /第 3 页，共 3 页（最后一页）/);
});

test("未知页数且CLI越界仍返回同一PNG，快速明确失败不循环至500页", async (t) => {
  const x = await setup(t, { unknown: true, repeatForever: true });
  await assert.rejects(checkLayout(x.gateway, x.file), (error) => {
    assert.equal(error.report.totalPages, null);
    assert.equal(error.report.complete, false);
    assert.deepEqual(error.report.failedPages, [2]);
    assert.match(error.message, /重复截图/);
    return true;
  });
  assert.equal(x.calls.filter((args) => args[2] === "screenshot").length, 2);
});

test("渲染页面缺少文档结尾是阻塞缺陷；结尾完整时分页断句不算截断", async (t) => {
  const full = "第一段写河湾的夜色与灯火。".repeat(30) + "全文在这里完整结束，没有丢失任何内容。";
  let x = await setup(t, { docx: true, count: 2, full, rendered: full.slice(0, 200) });
  let report = await checkLayout(x.gateway, x.file);
  assert.equal(report.complete, true);
  assert.equal(report.textCoverage, "mismatch");
  assert.match(report.issues.join(" "), /结尾/);
  x = await setup(t, { docx: true, count: 2, full });
  report = await checkLayout(x.gateway, x.file);
  assert.equal(report.textCoverage, "verified");
  assert.deepEqual(report.issues, []);
  assert.match(x.prompts[0], /分页可以断在句子中间/);
  // 页眉页脚等少量差异只提示，不阻塞。
  const pages = [full.slice(0, 150) + "页眉", full.slice(150)];
  assert.equal(textCoverage(full, pages).blocking, false);
});

test("视觉标准复用逐页评审，适用页证据通过且不适用页不强求重复元素", async (t) => {
  const x = await setup(t, { count: 2, review: (prompt) => ({
    issues: [], suggestions: [], criteria: [
      { criterion: 0, status: /这是第 1 页/.test(prompt) ? "passed" : "not_applicable", evidence: /这是第 1 页/.test(prompt) ? "封面有完整标题" : "正文页无封面要求" },
      { criterion: 1, status: "passed", evidence: "" },
    ],
  }) });
  const result = await checkLayout(x.gateway, x.file, undefined, [{ criterion: 0, requirement: "封面有标题" }, { criterion: 1, requirement: "图表可读" }]);
  assert.equal(x.prompts.length, 2);
  assert.deepEqual(result.criteria.map((x) => x.status), ["passed", "unverified"]);
});

test("视觉标准相关页失败或缺失证据不能被其他页通过覆盖", async (t) => {
  for (const status of ["failed", "unverified"]) {
    const x = await setup(t, { count: 2, review: (prompt) => ({ issues: [], suggestions: [], criteria: [{ criterion: 0, status: /这是第 1 页/.test(prompt) ? "passed" : status, evidence: "页面实际证据" }] }) });
    const result = await checkLayout(x.gateway, x.file, undefined, [{ criterion: 0, requirement: "文字清晰" }]);
    assert.equal(result.criteria[0].status, status);
  }
});

test("空评审对象和空截图不默认成功", async (t) => {
  for (const options of [{ review: () => ({}) }, { emptyImage: true }]) {
    const x = await setup(t, { count: 1, ...options });
    await assert.rejects(checkLayout(x.gateway, x.file), (error) => !error.report.complete);
  }
});
