import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun } from "docx";
import { inspectTemplate, fillTemplateSlots, readTemplateValues, compareTemplate, renderTemplate, hasFieldValue } from "../dist/artifacts/templates.js";
const require = createRequire(import.meta.url);
const PizZip = require("pizzip");
const cell = (text, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold, size: 24 })] })] });
async function fixture() {
  return Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph("官方报名表"),
    new Table({ rows: [
      new TableRow({ children: [cell("团队名称：", true), cell(""), cell("姓名："), cell("")] }),
      new TableRow({ children: [cell("参赛赛题："), cell("")] }),
      new TableRow({ children: [cell("日期：", true)] }),
    ] }),
    new Paragraph("指导教师签字："), new Paragraph("二级学院盖章："),
  ] }] }));
}
const xmlOf = (data) => new PizZip(data).file("word/document.xml").asText();

test("填满相邻单元格后按原始slots核验实际值，不再误报blank", async () => {
  const source = await fixture(), original = inspectTemplate(source);
  const ids = Object.fromEntries(original.slots.map((slot) => [slot.label, slot.id]));
  const values = { [ids["团队名称"]]: "创新实验室", [ids["姓名"]]: "程磊", [ids["参赛赛题"]]: "研究方向：智能辅助", [ids["日期"]]: "2026-11-10" };
  const filled = fillTemplateSlots(source, values).data;
  assert.deepEqual(readTemplateValues(filled, original.slots), values, "值里的冒号不应被无条件裁掉");
  const result = compareTemplate(original, filled);
  assert.equal(result.preserved, true);
  assert.deepEqual(result.filled, ["团队名称", "姓名", "参赛赛题", "日期"]);
  assert.deepEqual(result.blank, ["指导教师签字", "二级学院盖章"]);
  assert.deepEqual(inspectTemplate(filled).fieldValues["姓名"], ["程磊"]);
  const before = new PizZip(source), after = new PizZip(filled);
  for (const name of Object.keys(before.files).filter((name) => name !== "word/document.xml" && !before.files[name].dir))
    assert.deepEqual(after.file(name).asUint8Array(), before.file(name).asUint8Array(), `保留原始部件 ${name}`);
  for (const tag of ["tblPr", "tblGrid", "tcPr", "sectPr"]) {
    const re = new RegExp(`<w:${tag}(?=[\\s>])[^>]*>[\\s\\S]*?</w:${tag}>`, "g");
    assert.deepEqual(xmlOf(filled).match(re), xmlOf(source).match(re));
  }
  assert.match(xmlOf(filled), /指导教师签字/);
  assert.match(xmlOf(filled), /二级学院盖章/);
});

test("同格填写保留标签，删除原位置不能由其他格值冒充完成", async () => {
  const source = await fixture(), original = inspectTemplate(source);
  const date = original.slots.find((slot) => slot.label === "日期");
  const filled = fillTemplateSlots(source, { [date.id]: "2026-11-10" }).data;
  assert.ok(compareTemplate(original, filled).filled.includes("日期"));
  assert.ok(compareTemplate(original, filled).blank.includes("姓名"));
  const zip = new PizZip(filled);
  zip.file("word/document.xml", xmlOf(filled).replace("姓名：", "参赛人："));
  const result = compareTemplate(original, zip.generate({ type: "nodebuffer" }));
  assert.equal(result.preserved, false);
  assert.ok(result.missing.includes("姓名"));
});

test("占位标签替换后按原始段落锚点读取真实填写值，未知值留空不写undefined", async () => {
  const source = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph("作者姓名：{姓名}"), new Paragraph("学校：{学校}"), new Paragraph("签字："),
  ] }] }));
  const original = inspectTemplate(source);
  const filled = renderTemplate(source, { 姓名: "程磊" });
  const result = compareTemplate(original, filled);
  assert.equal(result.preserved, true);
  assert.ok(result.filled.includes("姓名"));
  assert.ok(result.blank.includes("学校"));
  assert.doesNotMatch(xmlOf(filled), /undefined/);
});

test("不接受占位值和不存在的槽位，缺正文和坏模板不静默成功", async () => {
  const source = await fixture(), slot = inspectTemplate(source).slots[0];
  for (const value of ["", "姓名：", "待填写", "[请填写姓名]", "{姓名}", "____", "undefined", "N/A"])
    assert.equal(hasFieldValue(value), false, value);
  assert.equal(hasFieldValue("程磊"), true);
  assert.throws(() => fillTemplateSlots(source, { [slot.id]: "待填写" }), /实际值/);
  assert.throws(() => fillTemplateSlots(source, { t99r0c0: "程磊" }), /位置不存在/);
  const zip = new PizZip(source);
  zip.remove("word/document.xml");
  assert.throws(() => inspectTemplate(zip.generate({ type: "nodebuffer" })), /缺少正文/);
});
