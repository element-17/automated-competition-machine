import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { Brief } from "../dist/core/types.js";
import {
  parseBounds,
  fixedFileName,
  measureArtifact,
  checkDelivery,
  checkLimits,
  fieldsInRule,
  missingNamingParts,
  resolveFileName,
} from "../dist/artifacts/delivery-checks.js";
import { renderWork, Work } from "../dist/artifacts/artifacts.js";
import { Document, Packer, Paragraph, Table, TableRow, TableCell } from "docx";
import { inspectTemplate, fillTemplateSlots } from "../dist/artifacts/templates.js";

const fieldMetric = (text, extra = {}) => ({ path: join(tmpdir(), "form.docx"), bytes: 100, text, errors: [], ...extra });
test("空标签、跨行相邻标签和占位信息不能通过必填核验", () => {
  for (const text of ["姓名：", "姓名：\n学校：某大学", "姓名：待填写", "姓名：____", "姓名：{姓名}", "姓名：[请填写姓名]"])
    assert.equal(checkLimits(["稿末注明姓名"], [fieldMetric(text)])[0].status, "failed", text);
  assert.equal(checkLimits(["稿末注明姓名、学校"], [fieldMetric("姓名：\n程磊\n学校：东北师范大学")])[0].status, "passed");
});

test("复合字段逐项验证，不因姓名存在漏检其他字段", () => {
  const rule = "报名表需填写姓名、团队名称、参赛赛题和所在赛区";
  const partial = checkLimits([rule], [fieldMetric("姓名：程磊")])[0];
  assert.equal(partial.status, "failed");
  assert.equal(partial.actual, 1);
  assert.equal(partial.minimum, 4);
  assert.match(partial.details.join(" "), /团队名称.*参赛赛题.*所在赛区/);
  const full = fieldMetric("姓名：程磊\n团队名称：创新实验室\n参赛赛题：智能辅助\n所在赛区：东北赛区");
  assert.equal(checkLimits([rule], [full])[0].status, "passed");
  assert.equal(checkLimits(["填写队员1至队员2的姓名"], [fieldMetric("队员1姓名：程磊")])[0].status, "failed");
  assert.equal(checkLimits(["填写姓名并提供研究数据"], [fieldMetric("姓名：程磊")])[0].status, "unverified", "不能静默丢掉无法解析的子要求");
});

test("栏目存在、实际值和允许留空分别验收，签章不伪造", () => {
  const metric = fieldMetric("姓名：程磊\n指导教师签字：\n备注：", { fields: ["姓名", "指导教师签字", "备注"] });
  assert.equal(checkLimits(["报名表设置姓名、指导教师签字和备注栏"], [metric])[0].status, "passed");
  assert.equal(checkLimits(["报名表需填写姓名、指导教师签字"], [metric])[0].status, "failed");
  assert.equal(checkLimits(["报名表需填写姓名；指导教师签字允许留空；备注可留白"], [metric])[0].status, "passed");
  assert.equal(checkLimits(["报名表需填写姓名、学校"], [fieldMetric("姓名：程磊\n学院：计算机学院")])[0].status, "failed", "学院不能冒充学校");
});

test("从填好模板实际单元格提取值再核验，空标签必填失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "field-values-"));
  try {
    const source = await Packer.toBuffer(new Document({ sections: [{ children: [new Table({ rows: ["姓名", "团队名称"].map((label) => new TableRow({ children: [new TableCell({ children: [new Paragraph(`${label}：`)] }), new TableCell({ children: [new Paragraph("")] })] })) })] }] }));
    const path = join(dir, "报名表.docx");
    await writeFile(path, source);
    assert.equal(checkLimits(["需填写姓名、团队名称"], [await measureArtifact(path)])[0].status, "failed");
    const slots = inspectTemplate(source).slots;
    const data = fillTemplateSlots(source, Object.fromEntries(slots.map((slot) => [slot.id, slot.label === "姓名" ? "程磊" : "创新实验室"]))).data;
    await writeFile(path, data);
    const metric = await measureArtifact(path);
    assert.deepEqual(metric.fieldValues.姓名, ["程磊"]);
    assert.equal(checkLimits(["需填写姓名、团队名称"], [metric])[0].status, "passed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("无后缀命名使用唯一实际格式，多格式歧义未核实，读取失败明确失败", () => {
  const item = Brief.parse({ title: "测试", deliverables: [{ type: "作品", formats: ["docx", "pdf"], naming: "作品名称_姓名" }] }).deliverables[0];
  const values = { workTitle: "识物助盲", name: "程磊" };
  const metric = fieldMetric("", { path: join(tmpdir(), "识物助盲_程磊.docx") });
  assert.equal(checkDelivery(item, [metric], values).find((x) => x.id === "naming").status, "passed");
  assert.equal(checkDelivery(item, [metric, { ...metric, path: "report.pdf" }], values).find((x) => x.id === "naming").status, "unverified");
  assert.equal(checkDelivery(item, [{ ...metric, errors: ["损坏文件"] }], values).find((x) => x.id === "read-1").status, "failed");
});

test("确定性规则只解析完整且无歧义的数值限制", () => {
  assert.deepEqual(parseBounds("不少于10页", "页"), { minimum: 10 });
  assert.deepEqual(parseBounds("2～5页", "页"), { minimum: 2, maximum: 5 });
  assert.equal(parseBounds("正文10页，附录不限", "页"), null);
  assert.equal(parseBounds("至少10页以内", "页"), null);
  assert.equal(fixedFileName("文件名为 report.txt"), "report.txt");
  assert.equal(fixedFileName("学校_姓名.txt"), null);
  assert.equal(fixedFileName("../report.txt"), null);
  assert.equal(fixedFileName("CON.txt"), null);
  assert.equal(
    checkLimits(["摘要200字，全文3000字"], [])[0].status,
    "unverified",
  );
});

test("从导出文件测量正文和文件体积，命名与数量不会被模型意见覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-measure-"));
  try {
    const path = join(dir, "report.txt");
    await writeFile(path, "标题\n甲乙丙丁。\n");
    const metric = await measureArtifact(path);
    assert.equal(metric.characters, 7);
    const item = Brief.parse({
      title: "测试",
      deliverables: [
        {
          type: "报告",
          formats: ["txt"],
          quantity: "2份",
          naming: "report.txt",
          limits: ["含标点不含空白字符数：不少于10字", "文件大小不超过1KB"],
        },
      ],
    }).deliverables[0];
    const checks = checkDelivery(item, [metric]);
    assert.equal(checks.find((c) => c.id === "quantity").status, "failed");
    assert.equal(checks.find((c) => c.id === "naming").status, "passed");
    assert.equal(checks.find((c) => c.id === "limit-1").status, "failed");
    assert.equal(checks.find((c) => c.id === "limit-2-1").status, "passed");
    // 只写“字数不超过1000字”时按实测字符数核对，不再一律判为无法核实。
    const plain = checkLimits(["字数不超过1000字"], [metric])[0];
    assert.equal(plain.status, "passed");
    assert.equal(plain.actual, metric.characters);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("页数读取实际 PPTX，附件检查读取实际压缩包目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-pages-"));
  try {
    const file = await renderWork(
      Work.parse({
        kind: "slides",
        title: "演示",
        slides: [{ elements: [{ text: "第一页", x: 1, y: 1, w: 4, h: 1 }] }],
      }),
      "pptx",
      dir,
    );
    const m = await measureArtifact(file);
    assert.equal(m.pages, 1);
    assert.equal(checkLimits(["至少2页"], [m])[0].status, "failed");
    const zip = new JSZip();
    zip.file("材料/承诺书.txt", "签名待填写");
    const path = join(dir, "作品.zip");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const item = Brief.parse({
      title: "测试",
      deliverables: [
        {
          type: "作品",
          formats: ["zip"],
          attachments: ["承诺书.txt", "调查数据.csv"],
        },
      ],
    }).deliverables[0];
    const checks = checkDelivery(item, [await measureArtifact(path)]);
    assert.equal(checks.find((c) => c.id === "attachment-1").status, "passed");
    assert.equal(checks.find((c) => c.id === "attachment-2").status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("带姓名、学校的命名规则用用户资料解析成真实文件名", () => {
  const values = {
    name: "程磊",
    school: "东北师范大学",
    workTitle: "识物助盲",
  };
  assert.equal(
    resolveFileName("学校_姓名.txt", values),
    "东北师范大学_程磊.txt",
  );
  assert.equal(
    resolveFileName("作品名称_作者姓名_学校.docx", values),
    "识物助盲_程磊_东北师范大学.docx",
  );
  // 规则没写扩展名时用实际产物格式补上。
  assert.equal(
    resolveFileName("作品名称_作者姓名", values, "zip"),
    "识物助盲_程磊.zip",
  );
  // 缺作者信息时不猜文件名，交给人工命名。
  assert.equal(resolveFileName("作品名称_作者姓名.docx", { workTitle: "识物助盲" }), null);
  // 赛道名称无法由程序推断。
  assert.equal(
    resolveFileName("赛道名称_作品名称_作者姓名", values, "zip"),
    null,
  );
  assert.deepEqual(missingNamingParts("学校_姓名_学号.docx", { school: "东北师范大学" }), [
    "作者姓名",
    "学号",
  ]);
  const item = Brief.parse({
    title: "测试",
    deliverables: [{ type: "作品", formats: ["txt"], naming: "学校_姓名.txt" }],
  }).deliverables[0];
  const checks = checkDelivery(item, [{ path: join(tmpdir(), "东北师范大学_程磊.txt"), bytes: 10, errors: [] }], values);
  assert.equal(checks.find((c) => c.id === "naming").status, "passed");
});

test("报名表规则按生成文件的栏目标签逐项核对，缺栏目判失败", () => {
  const fields = [
    "团队名称",
    "队员1姓名",
    "身份证号",
    "队员2姓名",
    "参赛赛题",
    "所在赛区",
    "指导教师签字",
    "二级学院盖章",
    "日期",
  ];
  assert.deepEqual(fieldsInRule("报名表需填写团队名称、参赛赛题和所在赛区。", fields), [
    "团队名称",
    "参赛赛题",
    "所在赛区",
  ]);
  assert.deepEqual(fieldsInRule("报名表设置队员1至队员2的姓名、身份证号栏。", fields), [
    "队员1姓名",
    "队员2姓名",
    "身份证号",
  ]);
  // 章节要求不是表单栏目，交人工确认。
  assert.equal(fieldsInRule("论文需包含摘要、正文和参考文献", fields), null);
  // 即使当前文件没有栏目，明确的必填规则也必须识别并判失败。
  assert.deepEqual(fieldsInRule("报名表需填写团队名称、参赛赛题和所在赛区。", []), ["团队名称", "参赛赛题", "所在赛区"]);
  const item = Brief.parse({
    title: "测试",
    deliverables: [
      {
        type: "报名表",
        formats: ["docx"],
        limits: ["报名表需填写团队名称、参赛赛题和所在赛区。"],
      },
    ],
  }).deliverables[0];
  const metric = {
    path: join(tmpdir(), "报名表.docx"),
    bytes: 100,
    fields,
    errors: [],
  };
  assert.equal(checkLimits(item.limits, [metric])[0].status, "failed", "只有栏目不能满足填写要求");
  const pass = checkLimits(item.limits, [{ ...metric, fieldValues: { 团队名称: ["创新实验室"], 参赛赛题: ["智能辅助"], 所在赛区: ["东北赛区"] } }])[0];
  assert.equal(pass.status, "passed");
  assert.match(pass.details[0], /团队名称、参赛赛题、所在赛区/);
  const fail = checkLimits(item.limits, [{ ...metric, fields: ["日期"] }])[0];
  assert.equal(fail.status, "failed");
  assert.match(fail.details[0], /缺少/);
});
