import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { planProblems, planWork } from "../dist/workflows/orchestrator.js";
import { renderWork, Work, validateWork } from "../dist/artifacts/artifacts.js";
import { measureArtifact } from "../dist/artifacts/delivery-checks.js";
import { readXlsx } from "../dist/artifacts/xlsx.js";
import { officecliAvailable } from "../dist/artifacts/officecli.js";

const item = (type, formats = []) => ({
  type,
  formats,
  quantity: null,
  limits: [],
  naming: null,
  attachments: [],
  submission: null,
  official_template: null,
});
const brief = (deliverables) => ({
  title: "华灿奖",
  edition: "2026",
  eligibility: null,
  deadline: null,
  ai_rules: null,
  scoring: null,
  deliverables,
  requires_idea: true,
  missing: [],
  citations: [],
  research: { past_winners: [], past_works: [], judging: [], missing: [] },
});
const workbook = {
  kind: "spreadsheet",
  title: "参赛项目汇总表",
  sources: [],
  needs_input: [],
  sheets: [
    {
      name: "项目汇总",
      rows: [
        ["学校", "学院", "项目负责人"],
        ["东北师范大学", "信息科学与技术学院", "程磊"],
      ],
    },
  ],
};

test("xlsx 交付物由 spreadsheet 任务满足；zip 冒充或视觉验收被拒", () => {
  const b = brief([item("报名信息", ["docx"]), item("参赛项目汇总表", ["xlsx"])]);
  const plan = {
    tasks: [
      {
        id: "apply-doc",
        deliverable: 0,
        title: "报名表",
        kind: "document",
        format: "docx",
        instructions: "按官方栏目填写",
        acceptance: ["栏目齐全"],
        acceptanceChecks: [{ criterion: 0, checks: ["content"] }],
      },
      {
        id: "summary-xlsx",
        deliverable: 1,
        title: "参赛项目汇总表",
        kind: "spreadsheet",
        format: "xlsx",
        instructions: "表头与官方栏目一致",
        acceptance: ["表头 12 栏", "数据与资料一致"],
        acceptanceChecks: [
          { criterion: 0, checks: ["file"] },
          { criterion: 1, checks: ["content"] },
        ],
      },
    ],
    packages: [],
    notes: [],
  };
  assert.deepEqual(planProblems(plan, b, false), []);
  // 规划仍可能用 zip 冒充 xlsx：必须拒绝
  const zipPlan = {
    ...plan,
    tasks: [plan.tasks[0], { ...plan.tasks[1], kind: "software", format: "zip" }],
  };
  assert.match(
    planProblems(zipPlan, b, false).join("\n"),
    /不符合交付物指定格式 xlsx/,
  );
  // 表格没有真实页面视觉验收，不能承诺 visual 标准
  const visualPlan = {
    ...plan,
    tasks: [
      plan.tasks[0],
      {
        ...plan.tasks[1],
        acceptanceChecks: [{ criterion: 0, checks: ["visual"] }],
      },
    ],
  };
  assert.match(
    planProblems(visualPlan, b, false).join("\n"),
    /暂无真实页面视觉验收/,
  );
});

test("纯体裁交付物不构成格式约束", () => {
  const b = brief([item("小说作品", ["小说"])]);
  const plan = {
    tasks: [
      {
        id: "novel",
        deliverable: 0,
        title: "小说",
        kind: "document",
        format: "docx",
        instructions: "完整正文",
        acceptance: ["有完整正文"],
        acceptanceChecks: [{ criterion: 0, checks: ["content"] }],
      },
    ],
    packages: [],
    notes: [],
  };
  assert.deepEqual(planProblems(plan, b, false), []);
});

test("交付物要求的格式无法制作时，规划前快速失败且不调用模型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xlsx-"));
  const store = new Store(dir);
  try {
    const cfg = {
      dataDir: dir,
      execution: { productionRounds: 1, plannerRounds: 2 },
      writer: { providerID: "google", id: "gemini-test" },
      reviewer: { providerID: "anthropic", id: "claude-test" },
      maxCalls: 40,
      sources: [],
      profile: {},
    };
    const id = store.addCompetition("https://example.edu.cn/contest", "视频大赛");
    store.setBrief(id, brief([item("宣传视频", ["mp4"])]));
    const job = store.createJob(id, "automatic", {}, 40);
    let calls = 0;
    await assert.rejects(
      planWork(cfg, store, { generate: async () => { calls++; return "{}"; } }, {
        jobId: job,
        brief: brief([item("宣传视频", ["mp4"])]),
        idea: null,
        evidence: [],
        hasSource: false,
      }),
      /交付物 0（宣传视频）要求 mp4.*无法制作该格式/s,
    );
    assert.equal(calls, 0, "规划前就应失败，不消耗模型调用");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("spreadsheet 作品结构检查：空表、公式、非法表名、重复表名都拦下", () => {
  assert.match(
    validateWork({
      ...workbook,
      sheets: [{ ...workbook.sheets[0], name: "a/b" }],
    }).join(";"),
    /Excel 不允许的字符/,
  );
  assert.match(
    validateWork({
      ...workbook,
      sheets: [workbook.sheets[0], workbook.sheets[0]],
    }).join(";"),
    /工作表名称重复/,
  );
  assert.match(
    validateWork({
      ...workbook,
      sheets: [
        {
          name: "项目汇总",
          rows: [
            ["A", "B"],
            ["=SUM(A1:A2)", "x"],
          ],
        },
      ],
    }).join(";"),
    /不写公式/,
  );
  const parsed = Work.parse(workbook);
  assert.equal(parsed.kind, "spreadsheet");
  const bad = Work.safeParse({ ...workbook, sheets: [] });
  assert.equal(bad.success, false);
  assert.match(bad.error.message, /工作簿没有工作表/);
});

test("renderWork 产出真实 OOXML 工作簿并逐格可读；measureArtifact 读回表头与数据", { skip: !(await officecliAvailable()) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "xlsx-render-"));
  try {
    const out = await renderWork(Work.parse(workbook), "xlsx", dir, "参赛项目汇总表");
    assert.match(out, /参赛项目汇总表\.xlsx$/);
    const written = await readXlsx(await import("node:fs/promises").then((f) => f.readFile(out)));
    assert.equal(written.sheets.length, 1);
    assert.equal(written.sheets[0].name, "项目汇总");
    assert.deepEqual(written.sheets[0].rows[0], ["学校", "学院", "项目负责人"]);
    assert.deepEqual(written.sheets[0].rows[1], ["东北师范大学", "信息科学与技术学院", "程磊"]);
    const metrics = await measureArtifact(out);
    assert.deepEqual(metrics.errors, []);
    assert.equal(metrics.sheets, 1);
    assert.equal(metrics.rows, 2);
    assert.deepEqual(metrics.fields, ["学校", "学院", "项目负责人"]);
    assert.equal(metrics.fieldValues["学校"]?.[0], "东北师范大学");
    assert.match(metrics.text, /程磊/);
    // 数值单元格以数值写入也能被读回（officecli 自动判型）
    const numeric = await renderWork(
      Work.parse({
        ...workbook,
        sheets: [
          {
            name: "数据",
            rows: [
              ["数量", "学号"],
              ["42", "2025013180"],
            ],
          },
        ],
      }),
      "xlsx",
      dir,
      "numeric",
    );
    const got = await readXlsx(await import("node:fs/promises").then((f) => f.readFile(numeric)));
    assert.equal(got.sheets[0].rows[1][0], "42");
    assert.equal(got.sheets[0].rows[1][1], "2025013180");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
