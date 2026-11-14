import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { parseJSON } from "../dist/core/gateway.js";
import { splitClauses } from "../dist/workflows/orchestrator.js";
import { measureArtifact, checkLimits } from "../dist/artifacts/delivery-checks.js";
import { textCoverage } from "../dist/artifacts/doc-render.js";

test("模型在 JSON 前后夹带说明时取出完整 JSON；截断的 JSON 仍然报错", () => {
  assert.deepEqual(
    parseJSON('We need answer only JSON. 注意 {不是JSON}。\n{"tasks":[{"id":"a","text":"含 } 和 \\" 的字符串"}],"notes":[]}\n以上。'),
    { tasks: [{ id: "a", text: '含 } 和 " 的字符串' }], notes: [] },
  );
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJSON('思考中…… {"tasks":[{"id":"a"'), /不是有效 JSON/);
  assert.throws(() => parseJSON("没有任何结构化内容"), /不是有效 JSON/);
});

test("复合文件标准按句读拆分，引号内的标点不拆", () => {
  assert.deepEqual(
    splitClauses("文件为 DOCX，文件名精确为“夜间防跌，起夜辅助装置_方案书.docx”，可正常打开，正文不少于 7000 字。"),
    ["文件为 DOCX", "文件名精确为“夜间防跌，起夜辅助装置_方案书.docx”", "可正常打开", "正文不少于 7000 字"],
  );
});

test("作品正文里的公式花括号不会让 DOCX 被判为无法读取", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "braces-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "work.docx");
  await writeFile(file, await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph("波长 $\\lambda = c / f_c \\approx 46.15\\ \\text{mm}$，功率 $\\le -41.3\\ \\text{dBm/MHz}$。"),
    new Paragraph("帧率 ($F_{\\text{frame}}$) 为 20 Hz，未闭合的 { 也不应报错。"),
  ] }] })));
  const metrics = await measureArtifact(file);
  assert.deepEqual(metrics.errors, []);
  assert.ok(metrics.characters > 20);
});

test("文字比对：结尾丢失阻塞，完整时通过，空页面阻塞", () => {
  const full = "河湾的夜色里只有一盏灯还亮着。".repeat(40) + "全文到这里结束。";
  assert.equal(textCoverage(full, [full.slice(0, 300), full.slice(300)]).status, "verified");
  const lost = textCoverage(full, [full.slice(0, 300)]);
  assert.equal(lost.blocking, true);
  assert.match(lost.details, /结尾/);
  assert.equal(textCoverage(full, ["", ""]).blocking, true);
});

test("稿末写“作者：”“所在学校：”也满足“注明作者姓名、学校、联系电话”", () => {
  const text = "正文。\n\n作者：程磊  \n所在学校：东北师范大学  \n联系电话：17807047850";
  const [check] = checkLimits(["稿末注明作者姓名、学校、联系电话"], [{ path: "a.docx", bytes: 1, errors: [], text }]);
  assert.equal(check.status, "passed", check.details.join("；"));
  const [missing] = checkLimits(["稿末注明作者姓名、学校、联系电话"], [{ path: "a.docx", bytes: 1, errors: [], text: "正文。\n学校：东北师范大学" }]);
  assert.equal(missing.status, "failed");
});
