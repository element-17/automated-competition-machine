import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { assertArtifactResources } from "../dist/artifacts/resource-checks.js";
import { buildSoftware, makeSoftware } from "../dist/artifacts/software.js";
import { inspectSoftware } from "../dist/artifacts/browser-checks.js";

const bundle = (entries) => new Map(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]));
const spec = { brief: {}, idea: {}, task: { title: "离线作品", instructions: "完整交付", acceptance: [] } };

const missing = [
  '<img loading="lazy" src="poster.png" style="margin-top:20000px">',
  '<img srcset="data:image/png;base64,AAAA 1x, poster.png 2x">',
  '<picture><source srcset="poster.png 2x"></picture>',
  '<video poster="poster.png"></video>',
  '<audio src="poster.png"></audio>',
  '<video><source src="poster.png"><track src="poster.png"></video>',
  '<input type="image" src="poster.png">',
  '<object data="poster.png"></object>',
  '<embed src="poster.png">',
  '<iframe src="poster.png"></iframe>',
  '<svg><use href="poster.png#icon"/></svg>',
  '<svg><image xlink:href="poster.png"/></svg>',
  '<svg><rect fill="url(poster.png#paint)"/></svg>',
  '<div style="background:url(poster.png)"></div>',
  '<style>@import "poster.png";</style>',
  '<style>@import url("poster.png");</style>',
  String.raw`<style>div { background: u\72l("post\65r.png") }</style>`,
  '<link rel="stylesheet alternate" href="poster.png">',
  '<link rel="preload" as="image" imagesrcset="poster.png 1x">',
  '<iframe srcdoc="&lt;img src=&quot;poster.png&quot;&gt;"></iframe>',
];

test("单 HTML 拒绝未内嵌资源，ZIP 静态预检覆盖尚未加载的资源", () => {
  for (const html of missing) {
    for (const mode of ["html", "zip"])
      assert.throws(() => assertArtifactResources(bundle({ "index.html": html }), mode), /poster\.png/, `${mode}: ${html}`);
  }
  assert.throws(() => assertArtifactResources(bundle({ "index.html": '<img src="https://example.com/p.png">' }), "zip"), /外部资源/);
});

test("data、同文档 fragment、普通外链和非资源 CSS 文本保留", () => {
  const html = `<!doctype html><a href="https://example.com/paper">参考资料</a>
    <link rel="canonical" href="https://example.com/page">
    <img src="data:image/png;base64,AAAA" srcset="data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x">
    <svg><defs><symbol id="icon"/><filter id="blur"/></defs><use href="#icon"/><use xlink:href="#icon"/><rect filter="url(#blur)"/></svg>
    <style>/* url(missing-comment.png) */ div::after {content:'url(missing-string.png)'}
    div {background:url("data:image/png;base64,AAAA")} @import "data:text/css,body%7Bcolor:red%7D";</style>`;
  for (const mode of ["html", "zip"]) assert.doesNotThrow(() => assertArtifactResources(bundle({ "index.html": html }), mode));
});

test("ZIP 按真实引用文件解析 CSS 相对路径、查询、fragment 与转义路径", () => {
  const entries = {
    "index.html": '<link rel="stylesheet" href="css/main.css?v=1"><a href="https://example.com">资料</a>',
    "css/main.css": '@import "nested/theme.css"; div {background:url(../images/poster%20one.png?x=1#part)}',
    "css/nested/theme.css": 'div {mask:url(../../icons.svg#icon)}',
    "images/poster one.png": "image",
    "icons.svg": '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="icon"/></svg>',
  };
  assert.doesNotThrow(() => assertArtifactResources(bundle(entries), "zip"));
  delete entries["images/poster one.png"];
  assert.throws(() => assertArtifactResources(bundle(entries), "zip"), /css\/main\.css.*poster one\.png/);
});

test("buildSoftware 不再成功导出遗漏工作区图片的单 HTML", async () => {
  const dir = await mkdtemp(join(tmpdir(), "software-resource-"));
  try {
    const gateway = { buildProject: async (workspace) => {
      await writeFile(join(workspace, "poster.png"), "image");
      await writeFile(join(workspace, "index.html"), '<button>操作</button><img loading="lazy" src="poster.png" style="margin-top:20000px">');
    } };
    await assert.rejects(buildSoftware(gateway, spec, "html", dir), /未内嵌资源 poster\.png/);
    await assert.rejects(access(join(dir, "submission.html")));
    gateway.buildProject = async (workspace) => writeFile(join(workspace, "index.html"), '<a href="https://example.com">说明</a><img src="data:image/png;base64,AAAA"><svg><use href="#icon"/></svg>');
    const out = await buildSoftware(gateway, spec, "html", dir);
    assert.match(await readFile(out, "utf8"), /data:image\/png;base64,AAAA/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("makeSoftware 同样拒绝未内嵌图片并允许 data 和 fragment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "software-copy-resource-"));
  try {
    let source = "poster.png";
    const gateway = { buildProject: async (workspace) => writeFile(join(workspace, "index.html"), `<html><head><script src="copy.js"></script></head><body><img src="${source}"><svg><use href="#icon"/></svg></body></html>`) };
    await assert.rejects(makeSoftware(gateway, { title: "标题", strings: {} }, {}, {}, "html", dir), /未内嵌资源 poster\.png/);
    source = "data:image/png;base64,AAAA";
    const out = await makeSoftware(gateway, { title: "标题", strings: {} }, {}, {}, "html", dir);
    assert.match(await readFile(out, "utf8"), /COMPETITION_COPY/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("实际 ZIP 缺失懒加载图片在启动浏览器前失败，不借用 workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-resource-"));
  try {
    await mkdir(join(dir, "workspace"));
    await writeFile(join(dir, "workspace", "poster.png"), "image");
    const archive = new JSZip();
    archive.file("index.html", '<button>操作</button><img loading="lazy" src="poster.png" style="margin-top:20000px">');
    const artifact = join(dir, "submission.zip");
    await writeFile(artifact, await archive.generateAsync({ type: "nodebuffer" }));
    const report = await inspectSoftware(artifact, join(dir, "reports"));
    assert.equal(report.status, "failed");
    assert.match(report.issues.join(" "), /实际归档缺少资源 poster\.png/);
    assert.deepEqual(report.checks.map((check) => check.id), ["artifact"]);
    assert.deepEqual(report.screenshots, []);
    assert.match(report.artifactSha256, /^[a-f0-9]{64}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
