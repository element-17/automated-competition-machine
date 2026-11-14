import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { Store } from "../dist/core/store.js";
import {
  runOrchestration,
  planProblems,
  Plan,
} from "../dist/workflows/orchestrator.js";
import { renderWork, Work } from "../dist/artifacts/artifacts.js";
import { readSource } from "../dist/competition/sources.js";

function reviewJSON(prompt, verdict) {
  const raw = prompt.match(/本次负责的标准：(\[[^\n]*\])。JSON/)?.[1]
    || prompt.match(/同时核验这些视觉标准：(\[[^\n]*\])。/)?.[1];
  const expected = raw ? JSON.parse(raw) : [];
  return JSON.stringify({
    ...verdict,
    criteria: expected.map(({ criterion, requirement }) => ({
      criterion,
      status: verdict.pass === false || verdict.issues?.length ? "failed" : "passed",
      evidence: `测试评审已核对实际产物：${requirement}`,
    })),
  });
}

test("profile 更新恢复会重建计划正文和文件名，规范化不变继续复用", async () => {
  const d = item("报告", ["txt"]);
  d.naming = "学校_作者姓名_作品名称";
  const c = await setup(brief([d]));
  c.cfg.profile = { name: "甲同学", school: "甲大学" };
  const g = documentGateway({ tasks: [documentTask()] });
  const generate = g.generate;
  let interrupt = true;
  g.generate = async (role, prompt) => {
    if (prompt.includes("任务：作品验收") && interrupt) throw Error("预算耗尽");
    if (prompt.includes("直接创作")) {
      g.calls.writes++;
      return JSON.stringify({ kind: "text", title: "报告", text: "作者【待补充：姓名】，学校【待补充：学校】。完整正文。", sources: [] });
    }
    return generate(role, prompt);
  };
  const input = { jobId: c.job, competitionId: c.id, idea };
  try {
    await assert.rejects(runOrchestration(c.cfg, c.store, g, input), /预算/);
    const folder = join(c.dir, "jobs", c.job);
    const stateFile = (await readdir(folder)).find((n) => n.endsWith("-r1-state.json"));
    const old = JSON.parse(await readFile(join(folder, stateFile), "utf8"));
    assert.ok(old.attempt.paths[0].endsWith("甲大学_甲同学_报告.txt"));
    c.cfg.profile = { school: "乙大学", name: "乙同学" };
    interrupt = false;
    const next = await runOrchestration(c.cfg, c.store, g, input);
    assert.equal(g.calls.plans, 2);
    assert.equal(g.calls.writes, 2);
    assert.ok(next.deliverables[0].artifactPaths[0].endsWith("乙大学_乙同学_报告.txt"));
    assert.match(await readFile(next.deliverables[0].artifactPaths[0], "utf8"), /乙同学.*乙大学/);
    assert.match(await readFile(old.attempt.paths[0], "utf8"), /甲同学.*甲大学/);
    const counts = { ...g.calls };
    c.cfg.profile = { name: " 乙同学 ", school: "乙大学 ", email: " " };
    await runOrchestration(c.cfg, c.store, g, input);
    assert.deepEqual(g.calls, counts);
    c.cfg.profile.name = "丙同学";
    const changed = await runOrchestration(c.cfg, c.store, g, input);
    assert.equal(g.calls.plans, counts.plans + 1);
    assert.equal(g.calls.writes, counts.writes + 1);
    assert.match(changed.deliverables[0].artifactPaths[0], /丙同学/);
    assert.match(await readFile(changed.deliverables[0].artifactPaths[0], "utf8"), /丙同学/);
  } finally { await c.done(); }
});

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
const idea = {
  title: "识物助盲",
  audience: "视障人士",
  problem: "识别日常物品",
  mechanism: "离线图像识别",
  verification: "识别率测试",
  evidence_urls: [],
};
async function setup(b) {
  const dir = await mkdtemp(join(tmpdir(), "orch-"));
  const store = new Store(dir);
  const cfg = {
    dataDir: dir,
    execution: { productionRounds: 2, plannerRounds: 2 },
    writer: { providerID: "google", id: "gemini-test" },
    reviewer: { providerID: "anthropic", id: "claude-test" },
    maxCalls: 40,
    sources: [],
    profile: {},
  };
  const id = store.addCompetition("https://example.edu.cn/contest", "华灿奖");
  store.setBrief(id, b);
  const job = store.createJob(id, "automatic", {}, 40);
  return {
    dir,
    store,
    cfg,
    id,
    job,
    done: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const bundlePlan = {
  tasks: [
    {
      id: "app",
      deliverable: 0,
      title: "识物助盲软件",
      kind: "software",
      format: "zip",
      instructions: "离线识别页面",
      acceptance: ["有识别功能"],
    },
    {
      id: "doc",
      deliverable: 0,
      title: "作品说明书",
      kind: "document",
      format: "docx",
      instructions: "说明设计与实现",
      acceptance: ["含设计思路"],
    },
    {
      id: "pledge",
      deliverable: 0,
      title: "作品原创承诺书",
      kind: "document",
      format: "docx",
      instructions: "签名处留空",
      acceptance: ["签名留空"],
    },
  ],
  packages: [
    {
      name: "软件赛道_识物助盲_作者.zip",
      deliverable: 0,
      includes: ["app", "doc", "pledge"],
    },
  ],
  notes: [],
};

test("规划 Agent 把压缩包交付物拆成软件和文档并打包；评审不通过的文档带意见返工", async () => {
  const ctx = await setup(
    brief([item("参赛作品压缩包（含作品文件、《作品原创承诺书》）", ["zip"])]),
  );
  try {
    const calls = [];
    let docReviews = 0,
      built = 0;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      buildProject: async (ws, prompt) => {
        built++;
        assert.match(prompt, /离线识别页面/);
        await writeFile(
          join(ws, "index.html"),
          '<html><body><h1>识物助盲</h1><script src="app.js"></script></body></html>',
        );
        await writeFile(join(ws, "app.js"), "console.log(1)");
        await writeFile(join(ws, "README.md"), "# 识物助盲");
      },
      generate: async (role, prompt, agent = role) => {
        calls.push({ role, agent, prompt });
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify(bundlePlan);
        if (prompt.includes("为实际网页交付物设计浏览器验收用例"))
          return JSON.stringify({
            cases: [
              {
                name: "首页显示标题",
                criterion: 0,
                steps: [{ action: "click", selector: "h1" }],
                expect: [{ selector: "h1", text: "识物助盲" }],
              },
            ],
          });
        if (prompt.includes("任务：作品验收")) {
          if (prompt.includes("任务：作品说明书")) {
            docReviews++;
            return reviewJSON(prompt,
              docReviews === 1
                ? { pass: false, issues: ["缺少设计思路章节"] }
                : { pass: true, issues: [] },
            );
          }
          return reviewJSON(prompt, { pass: true, issues: [] });
        }
        if (prompt.includes("请针对这项比赛的指定交付物直接创作")) {
          const fixed = prompt.includes("缺少设计思路章节");
          return JSON.stringify({
            kind: "text",
            title: prompt.includes("任务：作品原创承诺书")
              ? "作品原创承诺书"
              : "作品说明书",
            text: fixed ? "## 设计思路\n离线识别。" : "## 简介\n作品简介。",
            sources: [],
          });
        }
        throw Error("unexpected " + prompt.slice(0, 60));
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.ok(
      calls.some((c) => c.agent === "planner"),
      "规划由 planner Agent 完成",
    );
    assert.ok(
      calls
        .filter((c) => c.prompt.includes("任务：作品验收"))
        .every((c) => c.agent === "reviewer"),
    );
    assert.equal(built, 1);
    assert.equal(docReviews, 2);
    const doc = result.deliverables.find((d) => d.id === "doc");
    assert.equal(doc.status, "submission");
    assert.equal(doc.rounds, 2);
    const zipPath = result.outputs.find((x) => x.endsWith(".zip"));
    assert.match(zipPath, /华灿奖-最终提交包\.zip$/);
    const names = Object.keys(
      (await JSZip.loadAsync(await readFile(zipPath))).files,
    );
    assert.ok(names.some((x) => x.endsWith("/软件赛道_识物助盲_作者.zip")));
    assert.ok(
      !result.outputs.some((x) => x.endsWith(".md")),
      "不再降级为 Markdown",
    );
    assert.match(await readSource(doc.artifactPaths[0]), /设计思路/);
    // 软件在浏览器里跑过用例、看过截图，全部通过才算投稿件。
    assert.equal(
      result.deliverables.find((d) => d.id === "app").status,
      "submission",
    );
    // 子产物全部通过验收后，打包结果才登记为投稿件。
    assert.equal(result.deliverables.at(-1).status, "submission");
  } finally {
    await ctx.done();
  }
});

test("计划引用错误格式时带问题重试；始终无效则任务失败", async () => {
  const ctx = await setup(brief([item("方案报告", ["docx"])]));
  try {
    const prompts = [];
    const bad = {
      tasks: [
        {
          id: "a",
          deliverable: 0,
          title: "报告",
          kind: "slides",
          format: "docx",
          instructions: "x",
          acceptance: ["y"],
        },
      ],
    };
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务")) {
          prompts.push(prompt);
          return JSON.stringify(bad);
        }
        throw Error("unexpected");
      },
    };
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, {
        jobId: ctx.job,
        competitionId: ctx.id,
        idea,
      }),
      /没有给出可执行计划/,
    );
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /slides 只能制作 pptx/);
  } finally {
    await ctx.done();
  }
});

test("两轮仍未通过验收时任务失败，不产出任何投稿件", async () => {
  const ctx = await setup(brief([item("方案报告", ["docx"])]));
  try {
    let writes = 0;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [documentTask({ format: "docx" })],
            packages: [],
            notes: [],
          });
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { pass: false, issues: ["只有提纲"] });
        if (prompt.includes("直接创作")) {
          writes++;
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text: "提纲",
            sources: [],
          });
        }
        throw Error("unexpected");
      },
    };
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, {
        jobId: ctx.job,
        competitionId: ctx.id,
        idea,
      }),
      /仍未通过验收：只有提纲/,
    );
    assert.equal(writes, 2);
    assert.ok(
      !ctx.store.artifacts(ctx.job).some((a) => a.kind === "submission"),
    );
  } finally {
    await ctx.done();
  }
});

test("计划校验：每个交付物需有任务，翻译需原文，打包引用必须存在", () => {
  const b = brief([item("翻译作品", ["docx"]), item("演示", ["pptx"])]);
  const plan = Plan.parse({
    tasks: [
      {
        id: "t",
        deliverable: 0,
        title: "译文",
        kind: "translation",
        format: "DOCX",
        instructions: "x",
        acceptance: ["y"],
      },
    ],
    packages: [{ name: "p", deliverable: 0, includes: ["missing"] }],
  });
  const problems = planProblems(plan, b, false).join("\n");
  assert.match(problems, /没有比赛指定的原文/);
  assert.match(problems, /不存在的任务 missing/);
  assert.match(problems, /交付物 1（演示）没有对应任务/);
  const ok = Plan.parse({
    tasks: [
      {
        id: "t",
        deliverable: 0,
        title: "译文",
        kind: "translation",
        format: "docx",
        instructions: "忠实翻译提供的原文",
        acceptance: ["完整对应原文"],
      },
      {
        id: "s",
        deliverable: 1,
        title: "演示",
        kind: "slides",
        format: "pptx",
        instructions: "逐页展示方案",
        acceptance: ["含封面"],
      },
    ],
    packages: [],
  });
  assert.deepEqual(planProblems(ok, b, true), []);
});

test("Word 导出把 Markdown 标题和加粗转为样式，不残留标记", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docx-md-"));
  try {
    const out = await renderWork(
      Work.parse({
        kind: "text",
        title: "作品说明",
        text: "## 背景\n**重点**内容\n- 列表项",
        sources: [],
      }),
      "docx",
      dir,
    );
    const text = await readSource(out);
    assert.match(text, /作品说明/);
    assert.match(text, /背景/);
    assert.match(text, /重点内容/);
    assert.doesNotMatch(text, /##|\*\*/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const documentTask = (overrides = {}) => ({
  id: "report",
  deliverable: 0,
  title: "报告",
  kind: "document",
  format: "txt",
  instructions: "完整报告正文",
  acceptance: ["内容完整"],
  ...overrides,
});
for (const [label, verdict] of [
  ["空对象", {}],
  ["缺逐项证据", { issues: [] }],
  ["明确拒绝但空问题", { pass: false, issues: [], criteria: [{ criterion: 0, status: "passed", evidence: "正文完整" }] }],
  ["标准重复", { issues: [], criteria: [0, 0].map((criterion) => ({ criterion, status: "passed", evidence: "正文" })) }],
  ["标准未验证", { issues: [], criteria: [{ criterion: 0, status: "unverified", evidence: "缺少核验资料" }] }],
]) test(`评审${label}不能登记完成`, async () => {
  const c = await setup(brief([item("报告", ["txt"])]));
  try {
    const g = documentGateway({ tasks: [documentTask()] });
    const generate = g.generate;
    g.generate = async (role, prompt) => prompt.includes("任务：作品验收")
      ? JSON.stringify(verdict) : generate(role, prompt);
    await assert.rejects(runOrchestration(c.cfg, c.store, g, { jobId: c.job, competitionId: c.id, idea }), /验收|评审/);
    assert.ok(!c.store.artifacts(c.job).some((a) => a.kind === "submission"));
  } finally { await c.done(); }
});

test("未分类标准要求规划补齐，显式内容分配不能绕过功能硬检查", async () => {
  const { acceptanceAssignments } = await import("../dist/workflows/orchestrator.js");
  const unknown = Plan.parse({ tasks: [documentTask({ acceptance: ["达到承诺结果"] })] });
  assert.match(planProblems(unknown, brief([item("报告", ["txt"])]), true).join("；"), /未分类/);
  const task = Plan.parse({ tasks: [documentTask({ kind: "software", format: "html", acceptance: ["点击后显示结果"], acceptanceChecks: [{ criterion: 0, checks: ["content"] }] })] }).tasks[0];
  assert.deepEqual(acceptanceAssignments(task)[0].checks, ["interaction", "content"]);
});

test("空产物不能创建或复用完成收据", async () => {
  const { createTaskReceipt, checkTaskReceipt, taskInputHash } = await import("../dist/workflows/task-receipts.js");
  const c = await setup(brief([item("报告", ["txt"])]));
  try {
    await assert.rejects(createTaskReceipt({}, {}, [], c.dir), /没有实际产物/);
    const old = { version: 1, inputHash: taskInputHash({}, {}), files: [] };
    assert.equal((await checkTaskReceipt(old, {}, {}, [], c.dir)).valid, false);
  } finally { await c.done(); }
});

function documentGateway(
  plan,
  { review = { pass: true, issues: [] }, reviewError = false } = {},
) {
  const calls = { plans: 0, writes: 0, reviews: 0 };
  return {
    calls,
    search: async () => [],
    inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
    generate: async (role, prompt) => {
      if (prompt.includes("拆解成可以实际制作的文件任务")) {
        calls.plans++;
        return JSON.stringify(plan);
      }
      if (prompt.includes("任务：作品验收")) {
        calls.reviews++;
        if (reviewError) throw Error("评审服务离线");
        return reviewJSON(prompt, review);
      }
      if (prompt.includes("排版参考稿")) {
        calls.writes++;
        return JSON.stringify({
          kind: "text",
          title: "排版参考稿",
          text: "排版参考稿正文，供用户誊写对照",
          sources: [],
          needs_input: [],
        });
      }
      if (prompt.includes("直接创作")) {
        calls.writes++;
        return JSON.stringify({
          kind: "text",
          title: "报告",
          text: prompt.includes("更新后的规则")
            ? "依照新规则生成的正文"
            : "经过实际生成的正文",
          sources: [],
        });
      }
      throw Error("unexpected prompt");
    },
  };
}

test("规划器不能用制作器支持的格式替代官方格式，也不能跨交付物打包", () => {
  const b = brief([item("报告", ["PDF"]), item("软件包", ["ZIP"])]);
  const wrong = Plan.parse({
    tasks: [
      documentTask({ format: "docx" }),
      documentTask({
        id: "code",
        deliverable: 1,
        kind: "software",
        format: "zip",
      }),
    ],
  });
  assert.match(
    planProblems(wrong, b, true).join(" "),
    /docx 不符合交付物指定格式 PDF/,
  );
  const cross = Plan.parse({
    ...wrong,
    packages: [
      { name: "all.zip", deliverable: 1, includes: ["report", "code"] },
    ],
  });
  assert.match(
    planProblems(cross, b, true).join(" "),
    /其他交付物的任务 report/,
  );
  const wrapper = Plan.parse({
    tasks: [documentTask({ format: "pdf" })],
    packages: [{ name: "report.zip", deliverable: 0, includes: ["report"] }],
  });
  assert.match(
    planProblems(wrapper, brief([item("报告", ["pdf"])]), true).join(" "),
    /ZIP 不符合交付物指定格式/,
  );
});

test("规划始终用错官方格式时任务失败，不生成错格式作品", async () => {
  const ctx = await setup(brief([item("报告", ["txt"])]));
  try {
    const g = documentGateway({ tasks: [documentTask({ format: "docx" })] });
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, {
        jobId: ctx.job,
        competitionId: ctx.id,
        idea,
      }),
      /不符合交付物指定格式/,
    );
    assert.equal(g.calls.plans, 2);
    assert.equal(g.calls.writes, 0, "格式没对上就不该开始写");
  } finally {
    await ctx.done();
  }
});

test("评审离线时任务失败，不把未验收的作品当成果", async () => {
  const ctx = await setup(brief([item("报告", ["txt"])]));
  try {
    const g = documentGateway(
      { tasks: [documentTask()] },
      { reviewError: true },
    );
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, {
        jobId: ctx.job,
        competitionId: ctx.id,
        idea,
      }),
      /评审 Agent 无法完成验收/,
    );
    assert.ok(
      !ctx.store.artifacts(ctx.job).some((a) => a.kind === "submission"),
    );
  } finally {
    await ctx.done();
  }
});

test("评审同时返回通过和问题时仍判不通过，返工后失败则任务失败", async () => {
  const ctx = await setup(brief([item("报告", ["txt"])]));
  try {
    const g = documentGateway(
      { tasks: [documentTask()] },
      { review: { pass: true, issues: ["没有完整正文"] } },
    );
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, {
        jobId: ctx.job,
        competitionId: ctx.id,
        idea,
      }),
      /仍未通过验收：没有完整正文/,
    );
    // 首轮就要返工，说明 pass:true 没有掩盖 issues。
    assert.equal(g.calls.writes, 2);
  } finally {
    await ctx.done();
  }
});

test("恢复核对产物：完整结果跳过，修改或丢失重新生成，规则变化不复用旧模型缓存", async () => {
  const ctx = await setup(brief([item("报告", ["txt"])]));
  try {
    const g = documentGateway({ tasks: [documentTask()] });
    const input = { jobId: ctx.job, competitionId: ctx.id, idea };
    const first = await runOrchestration(ctx.cfg, ctx.store, g, input);
    const path = first.deliverables[0].artifactPaths[0];
    const counts = { ...g.calls };
    await runOrchestration(ctx.cfg, ctx.store, g, input);
    assert.deepEqual(g.calls, counts);
    await writeFile(path, "损坏的文件");
    await runOrchestration(ctx.cfg, ctx.store, g, input);
    assert.match(await readFile(path, "utf8"), /经过实际生成/);
    assert.equal(g.calls.reviews, counts.reviews + 1);
    assert.equal(g.calls.writes, counts.writes);
    await rm(path);
    await runOrchestration(ctx.cfg, ctx.store, g, input);
    assert.match(await readFile(path, "utf8"), /经过实际生成/);
    const changed = brief([item("报告", ["txt"])]);
    changed.scoring = "更新后的规则";
    ctx.store.setBrief(ctx.id, changed);
    const updated = await runOrchestration(ctx.cfg, ctx.store, g, input);
    assert.equal(g.calls.plans, counts.plans + 1);
    assert.equal(g.calls.writes, counts.writes + 1);
    assert.notEqual(updated.deliverables[0].artifactPaths[0], path);
    assert.match(
      await readFile(updated.deliverables[0].artifactPaths[0], "utf8"),
      /依照新规则/,
    );
    assert.match(
      await readFile(path, "utf8"),
      /经过实际生成/,
      "旧输入的作品仍保留",
    );
  } finally {
    await ctx.done();
  }
});

test("任务中途预算耗尽后恢复，只继续未完成的交付物", async () => {
  const ctx = await setup(
    brief([item("报告", ["txt"]), item("说明", ["txt"])]),
  );
  try {
    const g = documentGateway({
      tasks: [
        documentTask(),
        documentTask({ id: "second", title: "说明", deliverable: 1 }),
      ],
    });
    const generate = g.generate;
    let fail = true;
    g.generate = async (role, prompt) => {
      if (
        fail &&
        prompt.includes("任务：作品验收") &&
        prompt.includes("任务：说明")
      )
        throw Error("模型调用预算耗尽");
      return generate(role, prompt);
    };
    const input = { jobId: ctx.job, competitionId: ctx.id, idea };
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, input),
      /预算/,
    );
    const counts = { ...g.calls };
    fail = false;
    const result = await runOrchestration(ctx.cfg, ctx.store, g, input);
    assert.equal(g.calls.plans, counts.plans);
    assert.equal(g.calls.writes, counts.writes);
    assert.equal(g.calls.reviews, counts.reviews + 1);
    assert.ok(result.deliverables.every((d) => d.status === "submission"));
    const audit = JSON.parse(
      await readFile(
        join(ctx.dir, "jobs", ctx.job, "resume-checks.json"),
        "utf8",
      ),
    );
    assert.equal(audit[0].reused, true);
    assert.equal(audit[1].reused, false);
  } finally {
    await ctx.done();
  }
});

test("评审模型没有看图能力时，图片作品不能算完成", async () => {
  const ctx = await setup(brief([item("海报", ["png"])]));
  try {
    const g = {
      search: async () => [],
      generateImage: async () => ({
        data: await sharp({
          create: {
            width: 800,
            height: 600,
            channels: 3,
            background: "#336699",
          },
        })
          .png()
          .toBuffer(),
        mime: "image/png",
      }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [documentTask({ kind: "image", format: "png" })],
          });
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { pass: true, issues: [] });
        if (prompt.includes("设计一张独特的图片作品"))
          return JSON.stringify({ image_prompt: "校园设计", caption: "" });
        throw Error("unexpected");
      },
    };
    // 评审只会读到设计说明、没有真正看图；图片作品必须看过实际画面才算完成。
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, {
        jobId: ctx.job,
        competitionId: ctx.id,
        idea,
      }),
      /未通过全部验收|没有看图能力|实际画面/,
    );
  } finally {
    await ctx.done();
  }
});

test("返工生成另一轮产物，失败时保留上一轮草稿文件", async () => {
  const ctx = await setup(brief([item("软件", ["zip"])]));
  try {
    let builds = 0;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      buildProject: async (ws, prompt) => {
        builds++;
        assert.match(prompt, /完整报告正文/);
        await writeFile(
          join(ws, "index.html"),
          builds === 1 ? "<html>上一版作品</html>" : "<html>失败的返工</html>",
        );
        await writeFile(
          join(ws, "app.js"),
          builds === 1 ? "console.log(1)" : "function {",
        );
      },
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [documentTask({ kind: "software", format: "zip", acceptance: ["页面内容可见"], acceptanceChecks: [{ criterion: 0, checks: ["interaction"] }] })],
          });
        if (prompt.includes("为实际网页交付物设计浏览器验收用例"))
          return JSON.stringify({
            cases: [
              {
                name: "页面可打开",
                criterion: 0,
                steps: [{ action: "click", selector: "html" }],
                expect: [{ selector: "html", visible: true }],
              },
            ],
          });
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { pass: false, issues: ["需完善功能"] });
        throw Error("unexpected");
      },
    };
    // 评审始终不通过：任务失败，但上一轮可用文件仍保留在原处，不被失败的返工覆盖。
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, {
        jobId: ctx.job,
        competitionId: ctx.id,
        idea,
      }),
      /需完善功能|制作失败|仍未通过验收/,
    );
    assert.ok(builds >= 1);
  } finally {
    await ctx.done();
  }
});

test("实际文件违反明确数值限制时先返工，模型说通过也不能跳过检查", async () => {
  const d = item("报告", ["txt"]);
  d.limits = ["含标点不含空白字符数：不少于20字"];
  d.naming = "report.txt";
  d.quantity = "1份";
  const ctx = await setup(brief([d]));
  try {
    let writes = 0,
      reviews = 0;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({ tasks: [documentTask()] });
        if (prompt.includes("直接创作")) {
          writes++;
          if (writes === 2) assert.match(prompt, /实测.*字符/);
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text:
              writes === 1
                ? "太短"
                : "这份完整作品描述了具体对象与问题，并说明了方案机制及后续验证计划。",
            sources: [],
          });
        }
        if (prompt.includes("任务：作品验收")) {
          reviews++;
          return reviewJSON(prompt, { pass: true, issues: [] });
        }
        throw Error("unexpected");
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.equal(writes, 2);
    assert.equal(reviews, 1);
    assert.equal(result.deliverables[0].status, "submission");
    assert.match(result.outputs[0], /最终提交包\.zip$/);
    assert.match(result.deliverables[0].artifactPaths[0], /report\.txt$/);
    assert.ok(result.outputs.some((x) => /final[\\/]1-报告[\\/]report\.txt$/.test(x)));
    const requirements = JSON.parse(
      await readFile(
        join(ctx.dir, "jobs", ctx.job, "requirements.json"),
        "utf8",
      ),
    );
    assert.ok(requirements[0].checks.every((c) => c.status === "passed"));
    assert.ok(requirements[0].metrics[0].characters >= 20);
  } finally {
    await ctx.done();
  }
});

test("命名规则无法自动核实时交付作品，并逐条列给用户终审", async () => {
  const d = item("报告", ["txt"]);
  d.naming = "学校_作者姓名_作品名称";
  d.limits = ["1000字以内"];
  const ctx = await setup(brief([d]));
  try {
    const g = documentGateway({ tasks: [documentTask()] });
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    // 无法核对不等于不合格：作品照常交付，但每条未核实的规则都要明确交给用户。
    assert.equal(result.deliverables[0].status, "submission");
    const gaps = result.gaps.join("；");
    assert.match(gaps, /需人工终审：学校_作者姓名_作品名称/);
  } finally {
    await ctx.done();
  }
});

test("明确要求多份作品时，规划必须补齐最终文件数量才能开工", async () => {
  const d = item("报告", ["txt"]);
  d.quantity = "2份";
  const ctx = await setup(brief([d]));
  try {
    let plans = 0,
      writes = 0,
      feedback = "";
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务")) {
          plans++;
          if (plans > 1) feedback = prompt;
          // 第一次只给一份；收到“计划只有 1 个最终文件”的反馈后补齐两份。
          const tasks =
            plans === 1
              ? [documentTask()]
              : [documentTask(), documentTask({ id: "report-2", title: "报告（第 2 份）" })];
          return JSON.stringify({ tasks, packages: [], notes: [] });
        }
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { issues: [] });
        if (prompt.includes("直接创作")) {
          writes++;
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text: "经过实际生成的正文",
            sources: [],
          });
        }
        throw Error("unexpected prompt");
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.equal(plans, 2);
    assert.match(feedback, /计划只有 1 个最终文件/);
    assert.equal(writes, 2, "两份作品都要真实生成");
    assert.equal(
      result.outputs.filter((x) => x.includes("final") && x.endsWith(".txt")).length,
      2,
    );
    assert.match(result.outputs[0], /最终提交包\.zip$/, "两份作品汇总成提交包");
    assert.ok(result.deliverables.every((d) => d.status === "submission"));
  } finally {
    await ctx.done();
  }
});

test("规则检查报告只关联可在来源中逐字核对的引用", async () => {
  const b = brief([item("报告", ["txt"])]);
  b.citations = [
    {
      field: "deliverables.0.formats",
      url: "https://example.edu.cn/rules",
      quote: "作品采用TXT格式",
    },
    {
      field: "deliverables[0].quantity",
      url: "https://example.edu.cn/rules",
      quote: "编造数量",
    },
  ];
  const ctx = await setup(b);
  try {
    ctx.store.putEvidence({
      id: "rule-evidence",
      competitionId: ctx.id,
      url: "https://example.edu.cn/rules",
      title: "规则",
      text: "作品采用TXT格式。",
      fetchedAt: new Date().toISOString(),
      kind: "official",
    });
    const g = documentGateway({ tasks: [documentTask()] });
    await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    const requirements = JSON.parse(
      await readFile(
        join(ctx.dir, "jobs", ctx.job, "requirements.json"),
        "utf8",
      ),
    );
    assert.equal(requirements[0].sources.length, 1);
    assert.equal(requirements[0].sources[0].quote, "作品采用TXT格式");
  } finally {
    await ctx.done();
  }
});

test("多轮任务在第三轮评审中断，恢复时不重复已完成的写作和评审", async () => {
  const ctx = await setup(brief([item("报告", ["txt"])]));
  ctx.cfg.execution.productionRounds = 4;
  try {
    let writes = 0,
      reviews = 0,
      interrupt = true;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({ tasks: [documentTask()] });
        if (prompt.includes("直接创作")) {
          writes++;
          if (writes > 1) {
            assert.match(prompt, /上一版作品：\{/);
            assert.match(prompt, new RegExp(`第${writes - 1}版正文`));
          }
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text: `第${writes}版正文`,
            sources: [],
          });
        }
        if (prompt.includes("任务：作品验收")) {
          if (interrupt && writes === 3) throw Error("预算耗尽");
          reviews++;
          return reviewJSON(prompt,
            reviews < 3
              ? { pass: false, issues: ["请补充论证"] }
              : { pass: true, issues: [] },
          );
        }
        throw Error("unexpected");
      },
    };
    const input = { jobId: ctx.job, competitionId: ctx.id, idea };
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, input),
      /预算/,
    );
    assert.equal(writes, 3);
    assert.equal(reviews, 2);
    interrupt = false;
    const result = await runOrchestration(ctx.cfg, ctx.store, g, input);
    assert.equal(writes, 3);
    assert.equal(reviews, 3);
    assert.equal(result.deliverables[0].rounds, 3);
    assert.equal(result.deliverables[0].status, "submission");
  } finally {
    await ctx.done();
  }
});

test("增加制作轮数后重新执行，直到验收通过", async () => {
  const ctx = await setup(brief([item("报告", ["txt"])]));
  try {
    let writes = 0,
      reviews = 0;
    const g = documentGateway({ tasks: [documentTask()] });
    const original = g.generate;
    g.generate = async (role, prompt) => {
      if (prompt.includes("直接创作")) writes++;
      if (prompt.includes("任务：作品验收")) {
        reviews++;
        return reviewJSON(prompt, {
          pass: reviews === 3,
          issues: reviews === 3 ? [] : ["需补充具体内容"],
        });
      }
      return original(role, prompt);
    };
    const input = { jobId: ctx.job, competitionId: ctx.id, idea };
    // 轮数用尽仍未通过时任务失败，不产出草稿。
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, g, input),
      /仍未通过验收/,
    );
    assert.equal(writes, 2);
    ctx.cfg.execution.productionRounds = 4;
    const next = await runOrchestration(ctx.cfg, ctx.store, g, input);
    assert.equal(next.deliverables[0].status, "submission");
    assert.ok(writes > 2, "增加轮数后继续制作");
    assert.ok(reviews > 2);
  } finally {
    await ctx.done();
  }
});

test("软件返工承接上一轮可用文件，同时保留上一轮原件", async () => {
  const ctx = await setup(brief([item("软件", ["zip"])]));
  try {
    let builds = 0,
      reviews = 0;
    const folders = [];
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      buildProject: async (ws) => {
        builds++;
        folders.push(ws);
        if (builds === 1) {
          await writeFile(
            join(ws, "index.html"),
            '<html><body><h1>识物助盲</h1><p>离线识别日常物品。</p><script src="state.js"></script></body></html>',
          );
          await writeFile(join(ws, "state.js"), "const preserved = 1;");
        } else {
          assert.equal(
            await readFile(join(ws, "state.js"), "utf8"),
            "const preserved = 1;",
          );
          await writeFile(
            join(ws, "index.html"),
            '<html><body><h1>修订界面</h1><p>补充后的界面说明。</p><script src="state.js"></script></body></html>',
          );
        }
      },
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [documentTask({ kind: "software", format: "zip", acceptance: ["页面内容可见"], acceptanceChecks: [{ criterion: 0, checks: ["interaction"] }] })],
          });
        if (prompt.includes("为实际网页交付物设计浏览器验收用例"))
          return JSON.stringify({
            cases: [
              {
                name: "页面可打开",
                criterion: 0,
                steps: [{ action: "click", selector: "html" }],
                expect: [{ selector: "html", visible: true }],
              },
            ],
          });
        if (prompt.includes("任务：作品验收")) {
          reviews++;
          return reviewJSON(prompt, {
            pass: reviews === 2,
            issues: reviews === 2 ? [] : ["补充界面"],
          });
        }
        throw Error("unexpected");
      },
    };
    await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.ok(builds >= 2);
    assert.doesNotMatch(
      await readFile(join(folders[0], "index.html"), "utf8"),
      /修订界面/,
    );
  } finally {
    await ctx.done();
  }
});

test("规划中断后恢复已保存的错误计划，后续轮次接到原计划与具体反馈", async () => {
  const ctx = await setup(brief([item("报告", ["txt"])]));
  ctx.cfg.execution.plannerRounds = 3;
  try {
    let plans = 0,
      stop = true;
    const base = documentGateway({ tasks: [documentTask()] });
    const original = base.generate;
    base.generate = async (role, prompt) => {
      if (prompt.includes("拆解成可以实际制作的文件任务")) {
        plans++;
        if (plans === 1)
          return JSON.stringify({ tasks: [documentTask({ format: "docx" })] });
        if (stop) throw Error("规划预算耗尽");
        assert.match(prompt, /上一份计划：.*docx/s);
        assert.match(prompt, /不符合交付物指定格式/);
        return JSON.stringify({ tasks: [documentTask()] });
      }
      return original(role, prompt);
    };
    const input = { jobId: ctx.job, competitionId: ctx.id, idea };
    await assert.rejects(
      runOrchestration(ctx.cfg, ctx.store, base, input),
      /预算/,
    );
    stop = false;
    const result = await runOrchestration(ctx.cfg, ctx.store, base, input);
    assert.equal(plans, 3);
    assert.equal(result.deliverables[0].status, "submission");
  } finally {
    await ctx.done();
  }
});

test("计划里安排执行 Agent 打包其他任务文件时被拦下，要求改用 packages", () => {
  const b = brief([item("参赛作品压缩包", ["zip"])]);
  const plan = Plan.parse({
    tasks: [
      {
        id: "doc",
        deliverable: 0,
        title: "说明书",
        kind: "document",
        format: "pdf",
        instructions: "x",
        acceptance: ["y"],
      },
      {
        id: "pack",
        deliverable: 0,
        title: "打包参赛作品压缩包",
        kind: "software",
        format: "zip",
        instructions: "包内含 doc 的 PDF",
        acceptance: ["y"],
      },
    ],
  });
  assert.match(
    planProblems(plan, b, false).join("\n"),
    /任务 pack 在打包其他任务的文件/,
  );
});

test("一个图片任务要求多张图时被拦下，要求拆分", () => {
  const b = brief([item("作品图片", ["png"])]);
  const plan = Plan.parse({
    tasks: [
      {
        id: "renders",
        deliverable: 0,
        title: "渲染图（主视图、爆炸图、场景图）",
        kind: "image",
        format: "png",
        instructions: "x",
        acceptance: ["交付3张PNG，文件名分别含main / exploded / scenario"],
      },
    ],
  });
  assert.match(
    planProblems(plan, b, false).join("\n"),
    /任务 renders 要求多张图片/,
  );
});

test("正文仍依赖未提供的资料时保留产物但不登记完成", async () => {
  const ctx = await setup(brief([item("方案报告", ["docx"])]));
  try {
    let writes = 0,
      reviewPrompt = "",
      writePrompt = "";
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({ tasks: [documentTask({ format: "docx" })], packages: [], notes: [] });
        if (prompt.includes("任务：作品验收")) {
          reviewPrompt = prompt;
          return reviewJSON(prompt, {
            issues: [],
            suggestions: ["第3节标题层级可统一"],
            needs_input: ["团队实测的开启力数据"],
          });
        }
        if (prompt.includes("直接创作")) {
          writes++;
          writePrompt = prompt;
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text: "## 背景\n用户调研显示【待补充：用户访谈记录】。",
            sources: [],
            needs_input: ["10 名目标用户的访谈记录"],
          });
        }
        throw Error("unexpected");
      },
    };
    await assert.rejects(runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job, competitionId: ctx.id, idea,
    }), /缺少完成作品所需资料/);
    assert.equal(writes, 2);
    assert.match(writePrompt, /不要防御性写作/);
    assert.ok(!ctx.store.artifacts(ctx.job).some((a) => a.kind === "submission"));
    const states = (await readdir(join(ctx.dir, "jobs", ctx.job))).filter((x) => x.endsWith("-state.json"));
    assert.equal(states.length, 2);
    const state = JSON.parse(await readFile(join(ctx.dir, "jobs", ctx.job, states[0]), "utf8"));
    assert.equal(state.review.pass, false);
    assert.match(await readSource(state.attempt.paths[0]), /待补充/);
  } finally {
    await ctx.done();
  }
});

test("评审给出阻塞问题时，即使模型写 pass:true 也判不通过", async () => {
  const ctx = await setup(brief([item("方案报告", ["docx"])]));
  try {
    let writes = 0;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({ tasks: [documentTask({ format: "docx" })], packages: [], notes: [] });
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt,
            writes === 1
              ? { pass: true, issues: ["核心机制只有一句话，没有原理说明"] }
              : { issues: [] },
          );
        if (prompt.includes("直接创作")) {
          writes++;
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text: "正文",
            sources: [],
          });
        }
        throw Error("unexpected");
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.equal(writes, 2);
    assert.equal(result.deliverables[0].rounds, 2);
  } finally {
    await ctx.done();
  }
});

test("评审看实际图片：通过即完成视觉验收；PPT 嵌入先生成的图片", async () => {
  const ctx = await setup(brief([item("参赛作品压缩包", ["zip"])]));
  try {
    const seen = [];
    let slidePrompt = "";
    const g = {
      search: async () => [],
      generateImage: async () => ({
        data: await sharp({
          create: {
            width: 800,
            height: 600,
            channels: 3,
            background: "#336699",
          },
        })
          .png()
          .toBuffer(),
        mime: "image/png",
      }),
      inspectImage: async (prompt, image, agent) => {
        seen.push({ agent, mime: image.mime, bytes: image.data.length });
        assert.doesNotMatch(prompt, /undefined|NaN/);
        if (prompt.includes("实际生成的图片"))
          assert.match(prompt, /实际生成的图片/);
        return reviewJSON(prompt, { issues: [], suggestions: [], needs_input: [] });
      },
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [
              {
                id: "deck",
                deliverable: 0,
                title: "展示PPT",
                kind: "slides",
                format: "pptx",
                instructions: "展示作品",
                acceptance: ["含效果图"],
              },
              {
                id: "render",
                deliverable: 0,
                title: "效果图",
                kind: "image",
                format: "png",
                instructions: "产品主视图",
                acceptance: ["主体清晰"],
              },
            ],
            packages: [
              {
                name: "作品.zip",
                deliverable: 0,
                includes: ["deck", "render"],
              },
            ],
          });
        if (prompt.includes("设计一张独特的图片作品"))
          return JSON.stringify({ image_prompt: "产品", caption: "效果图" });
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { issues: [] });
        if (prompt.includes("直接创作")) {
          slidePrompt = prompt;
          return JSON.stringify({
            kind: "slides",
            title: "展示",
            sources: [],
            slides: [
              {
                background: "FFFFFF",
                elements: [
                  {
                    type: "text",
                    text: "作品外观",
                    x: 0.5,
                    y: 0.3,
                    w: 6,
                    h: 0.8,
                    fontSize: 28,
                  },
                  {
                    type: "image",
                    ref: "render",
                    x: 0.5,
                    y: 1.3,
                    w: 8,
                    h: 5.5,
                  },
                ],
              },
            ],
          });
        }
        throw Error("unexpected " + prompt.slice(0, 40));
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    // 图片作品的真实画面必须经过看图评审。
    assert.ok(
      seen.some((x) => x.agent === "reviewer" && x.mime === "image/jpeg"),
    );
    assert.ok(seen.every((x) => x.mime === "image/jpeg"));
    const render = result.deliverables.find((d) => d.id === "render");
    assert.equal(render.checks.find((c) => c.id === "visual").status, "passed");
    assert.match(slidePrompt, /"ref":"render"/, "PPT 写作时已知道图片");
    const deck = result.deliverables.find((d) => d.id === "deck");
    const pptx = await JSZip.loadAsync(await readFile(deck.artifactPaths[0]));
    assert.ok(
      Object.keys(pptx.files).some((n) =>
        /^ppt\/media\/.+\.(jpe?g|png)$/i.test(n),
      ),
      "PPT 内含图片",
    );
    assert.deepEqual(
      result.deliverables.slice(0, 2).map((d) => d.id),
      ["deck", "render"],
      "结果按计划顺序输出",
    );
  } finally {
    await ctx.done();
  }
});

test("PPT 引用不存在的图片时要求修复", async () => {
  const { validateWork } = await import("../dist/artifacts/artifacts.js");
  const work = Work.parse({
    kind: "slides",
    title: "t",
    sources: [],
    slides: [
      {
        background: "FFFFFF",
        elements: [{ type: "image", ref: "nope", x: 0, y: 0, w: 4, h: 3 }],
      },
    ],
  });
  assert.match(
    validateWork(work, { render: "x.png" }).join(" "),
    /不存在的图片 nope/,
  );
});

test("图题默认放在画面下方的色带里，不遮挡画面", async () => {
  const { makeVisual, VisualBrief } =
    await import("../dist/artifacts/visual.js");
  const dir = await mkdtemp(join(tmpdir(), "band-"));
  try {
    const g = {
      generateImage: async () => ({
        data: await sharp({
          create: {
            width: 800,
            height: 600,
            channels: 3,
            background: "#ff0000",
          },
        })
          .png()
          .toBuffer(),
        mime: "image/png",
      }),
    };
    const out = await makeVisual(
      g,
      VisualBrief.parse({
        image_prompt: "x",
        caption: "这是一个很长的图题用来检查自动缩小字号是否生效",
      }),
      "png",
      dir,
    );
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 800);
    assert.ok(meta.height > 600, "色带加在画面下方");
    const { data } = await sharp(out)
      .extract({ left: 400, top: 300, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data].slice(0, 3), [255, 0, 0], "画面本身未被覆盖");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("长文档先列大纲再逐章写，返工时只重写评审指出的章节", async () => {
  const ctx = await setup(brief([item("设计说明书", ["docx"])]));
  try {
    const calls = { outline: 0, section: [] };
    let reviews = 0;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [
              documentTask({
                format: "docx",
                instructions: "写一份 8000-12000字的设计说明书",
                acceptance: ["内容完整"],
              }),
            ],
          });
        if (prompt.includes("先只输出大纲")) {
          calls.outline++;
          const revise = prompt.includes("这是返工");
          return JSON.stringify({
            title: "设计说明书",
            sections: [
              {
                heading: "## 背景",
                points: ["问题"],
                chars: 3000,
                rewrite: !revise,
              },
              {
                heading: "## 机制",
                points: ["原理"],
                chars: 5000,
                rewrite: true,
              },
            ],
            needs_input: [],
          });
        }
        if (prompt.includes("分章写作：现在只写")) {
          const n = prompt.match(/第 (\d+)\/2 章/)[1];
          calls.section.push(n);
          return n === "1"
            ? "## 背景\n背景正文。"
            : `## 机制\n${prompt.includes("机制只有一句话") ? "机制原理的详细说明，附后续用户访谈验证方案。" : "机制一句话。"}`;
        }
        if (prompt.includes("任务：作品验收")) {
          reviews++;
          return reviewJSON(prompt,
            reviews === 1
              ? { issues: ["机制只有一句话，需展开原理"] }
              : { issues: [] },
          );
        }
        throw Error("unexpected " + prompt.slice(0, 40));
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.equal(calls.outline, 2);
    assert.deepEqual(calls.section, ["1", "2", "2"], "返工只重写第 2 章");
    const d = result.deliverables[0];
    assert.equal(d.review.pass, true);
    assert.equal(d.rounds, 2);
    const text = await readSource(d.artifactPaths[0]);
    assert.match(text, /背景正文/);
    assert.match(text, /机制原理的详细说明/);
    assert.deepEqual(d.needsInput, [], "通过的正文没有未提供的硬输入");
  } finally {
    await ctx.done();
  }
});

function chapterGateway(outlineForRound, bodyForChapter) {
  const calls = { outlines: 0, chapters: [], reviews: 0 };
  return {
    calls,
    search: async () => [],
    inspectImage: async (prompt) => reviewJSON(prompt, { issues: [] }),
    generate: async (role, prompt) => {
      if (prompt.includes("拆解成可以实际制作的文件任务"))
        return JSON.stringify({ tasks: [documentTask({ instructions: "写一份 8000 字的设计说明书" })] });
      if (prompt.includes("先只输出大纲"))
        return JSON.stringify(outlineForRound(++calls.outlines, prompt));
      if (prompt.includes("分章写作：现在只写")) {
        const heading = prompt.match(/以「([^」]+)」开头/)[1];
        calls.chapters.push(heading);
        return bodyForChapter(heading, prompt, calls.outlines);
      }
      if (prompt.includes("任务：作品验收")) {
        calls.reviews++;
        return reviewJSON(prompt, { issues: calls.reviews === 1 ? ["请按评审完善内容"] : [] });
      }
      throw Error("unexpected " + prompt.slice(0, 60));
    },
  };
}
const chapterOutline = () => ({
  title: "设计说明书",
  facts: ["设计参数：厚度：5 mm"],
  sections: ["## 背景", "## 机制"].map((heading) => ({
    heading, points: ["设计依据"], chars: 4000, rewrite: false,
  })),
  needs_input: [],
});
const chapterBody = (heading, prompt, round) =>
  `${heading}\n${(prompt.includes('厚度：8 mm') ? "设计厚度8毫米。" : "设计厚度5毫米。").repeat(600)}第${round}版正文。`;

for (const [name, change, expected] of [
  ["共享参数变化", (o) => { o.facts = ["设计参数：厚度：8 mm"]; }, ["## 背景", "## 机制"]],
  ["章节重排", (o) => { o.sections.reverse(); }, ["## 机制", "## 背景"]],
  ["章节要点变化", (o) => { o.sections[0].points = ["更新后的设计依据"]; }, ["## 背景", "## 机制"]],
  ["篇幅分配变化", (o) => { o.sections[0].chars = 4500; o.sections[1].chars = 3500; }, ["## 背景", "## 机制"]],
  ["上章正文变化", (o) => { o.sections[0].rewrite = true; }, ["## 背景", "## 机制"]],
  ["依赖无变化", () => {}, []],
]) test(`分章复用：${name}时不能仅相信 rewrite:false`, async () => {
  const c = await setup(brief([item("报告", ["txt"])]));
  const g = chapterGateway((round) => {
    const outline = chapterOutline();
    if (round > 1) change(outline);
    return outline;
  }, chapterBody);
  const input = { jobId: c.job, competitionId: c.id, idea };
  try {
    const result = await runOrchestration(c.cfg, c.store, g, input);
    assert.deepEqual(g.calls.chapters, ["## 背景", "## 机制", ...expected]);
    assert.equal(g.calls.outlines, 2);
    assert.equal(result.deliverables[0].rounds, 2);
    const text = await readFile(result.deliverables[0].artifactPaths[0], "utf8");
    if (name === "共享参数变化") {
      assert.doesNotMatch(text, /厚度5毫米/);
      assert.match(text, /厚度8毫米/);
      const saved = await readdir(join(c.dir, "jobs", c.job));
      assert.ok(saved.some((file) => file.endsWith("-r1-sections.json")), "保留旧章文件便于恢复");
    }
    if (name === "章节重排") assert.ok(text.indexOf("机制") < text.indexOf("背景"));
    const beforeResume = structuredClone(g.calls);
    await runOrchestration(c.cfg, c.store, g, input);
    assert.deepEqual(g.calls, beforeResume, "输入无变化时复用已通过的生成和验收结果");
  } finally { await c.done(); }
});

for (const [name, change, body, error] of [
  ["大纲篇幅不足", (o) => { o.sections.forEach((s) => { s.chars = 1000; }); }, chapterBody, /大纲.*字数/],
  ["标题重复", (o) => { o.sections[1].heading = o.sections[0].heading; }, chapterBody, /章节标题.*重复/],
  ["标题样式不同但同名", (o) => { o.sections[1].heading = " 背景 "; }, chapterBody, /章节标题.*重复/],
  ["只有标题没有正文", () => {}, (heading) => `${heading}\n\n### 小节标题`, /章节正文为空/],
]) test(`分章校验：${name}经过有界返工仍不合格就失败`, async () => {
  const c = await setup(brief([item("报告", ["txt"])]));
  const g = chapterGateway(() => {
    const outline = chapterOutline();
    change(outline);
    return outline;
  }, body);
  try {
    await assert.rejects(runOrchestration(c.cfg, c.store, g, {
      jobId: c.job, competitionId: c.id, idea,
    }), error);
    assert.equal(g.calls.outlines, 2, "遵守既有 productionRounds，不降低要求或无限重试");
    assert.equal(g.calls.reviews, 0, "结构无效不能送去由模型放行");
    assert.ok(!c.store.artifacts(c.job).some((a) => a.kind === "submission"));
    if (name !== "只有标题没有正文") assert.deepEqual(g.calls.chapters, []);
  } finally { await c.done(); }
});

test("大纲篇幅检查给下一轮同标准反馈，修复后可以完成", async () => {
  const c = await setup(brief([item("报告", ["txt"])]));
  const g = chapterGateway((round, prompt) => {
    const outline = chapterOutline();
    if (round === 1) outline.sections.forEach((s) => { s.chars = 1000; });
    else {
      assert.match(prompt, /大纲.*字数/);
      assert.match(prompt, /chars 之和不少于 8000/);
    }
    return outline;
  }, chapterBody);
  // 此用例只触发制作返工，不额外制造一次评审返工。
  g.calls.reviews = 1;
  try {
    const result = await runOrchestration(c.cfg, c.store, g, {
      jobId: c.job, competitionId: c.id, idea,
    });
    assert.equal(result.deliverables[0].rounds, 2);
    assert.deepEqual(g.calls.chapters, ["## 背景", "## 机制"]);
  } finally { await c.done(); }
});

test("从制作要求中识别目标字数", async () => {
  const { targetLength } = await import("../dist/workflows/orchestrator.js");
  assert.equal(
    targetLength({ instructions: "正文 8000–12000字", acceptance: [] }),
    8000,
  );
  assert.equal(
    targetLength({ instructions: "不少于1.5万字", acceptance: ["摘要300字"] }),
    15000,
  );
  assert.equal(targetLength({ instructions: "简短说明", acceptance: [] }), 0);
});

test("compete materials 导入用户资料，写作提示词把它当作可用事实", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await mkdtemp(join(tmpdir(), "materials-"));
  try {
    let store = new Store(dir);
    const id = store.addCompetition("https://example.edu.cn/m", "赛事");
    store.setBrief(id, brief([item("方案报告", ["docx"])]));
    const job = store.createJob(id, "automatic", {}, 40);
    store.close();
    const file = join(dir, "访谈.md");
    await writeFile(file, "# 用户访谈\n受访者 A：每天服药 5 次。");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["dist/cli.js", "materials", id, file],
      {
        cwd: process.cwd(),
        env: { ...process.env, COMPETE_DATA_DIR: dir },
        timeout: 20000,
      },
    );
    assert.match(stdout, /资料已导入/);
    store = new Store(dir);
    try {
      const e = store.evidence(id).find((x) => x.kind === "user");
      assert.ok(e);
      assert.match(e.text, /每天服药 5 次/);
      let prompt = "";
      const cfg = {
        dataDir: dir,
        execution: { productionRounds: 2, plannerRounds: 2 },
        writer: { providerID: "google", id: "gemini-test" },
        reviewer: { providerID: "anthropic", id: "claude-test" },
        maxCalls: 40,
        sources: [],
        profile: {},
      };
      const g = {
        search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
        generate: async (role, p) => {
          if (p.includes("拆解成可以实际制作的文件任务"))
            return JSON.stringify({
              tasks: [documentTask({ format: "docx" })],
              packages: [],
              notes: [],
            });
          if (p.includes("任务：作品验收"))
            return reviewJSON(p, { issues: [] });
          if (p.includes("直接创作")) {
            prompt = p;
            return JSON.stringify({
              kind: "text",
              title: "报告",
              text: "正文",
              sources: [],
            });
          }
          throw Error("unexpected");
        },
      };
      await runOrchestration(cfg, store, g, {
        jobId: job,
        competitionId: id,
        idea,
      });
      assert.match(prompt, /kind 为 user/);
      assert.match(prompt, /每天服药 5 次/);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("评审输出不是有效 JSON 时重试一次，而不是记为未评审", async () => {
  const ctx = await setup(brief([item("方案报告", ["docx"])]));
  try {
    let reviews = 0;
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [documentTask({ format: "docx" })],
            packages: [],
            notes: [],
          });
        if (prompt.includes("任务：作品验收")) {
          reviews++;
          return reviews === 1
            ? '{"issues":["被截断'
            : reviewJSON(prompt, { issues: [] });
        }
        if (prompt.includes("直接创作"))
          return JSON.stringify({
            kind: "text",
            title: "报告",
            text: "正文",
            sources: [],
          });
        throw Error("unexpected");
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.equal(reviews, 2);
    assert.equal(result.deliverables[0].review.pass, true);
  } finally {
    await ctx.done();
  }
});

async function formatServer(html) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/notice` };
}
const formatGateway = (url, quote, writes) => ({
  search: async () => [{ url, title: "征文要求", snippet: "" }],
  inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
  generate: async (role, prompt) => {
    if (prompt.includes("没有写提交文件格式"))
      return JSON.stringify({
        items: [{ deliverable: 0, formats: ["docx"], url, quote }],
      });
    if (prompt.includes("拆解成可以实际制作的文件任务"))
      return JSON.stringify({
        tasks: [documentTask({ format: "docx" })],
        packages: [],
        notes: [],
      });
    if (prompt.includes("任务：作品验收"))
      return reviewJSON(prompt, { issues: [] });
    if (prompt.includes("直接创作")) {
      writes.push(prompt);
      return JSON.stringify({
        kind: "text",
        title: "论文",
        text: "正文",
        sources: [],
      });
    }
    throw Error("unexpected " + prompt.slice(0, 40));
  },
});

test("公告没写格式时搜索官方要求，引用核对通过后作品成为投稿件", async () => {
  const { server, url } = await formatServer(
    "<title>征文要求</title><p>论文请以 Word 格式提交，正文不少于 3000 字。</p>",
  );
  const ctx = await setup(brief([item("征文论文", [])]));
  try {
    const writes = [];
    const result = await runOrchestration(
      ctx.cfg,
      ctx.store,
      formatGateway(url, "论文请以 Word 格式提交", writes),
      { jobId: ctx.job, competitionId: ctx.id, idea },
    );
    const d = result.deliverables[0];
    assert.equal(d.format, "docx");
    assert.equal(d.checks.find((c) => c.id === "format").status, "passed");
    assert.equal(d.status, "submission");
    const saved = ctx.store.competition(ctx.id).brief;
    assert.deepEqual(saved.deliverables[0].formats, ["docx"]);
    assert.ok(
      saved.citations.some(
        (c) => c.field === "deliverables.0.formats" && c.url === url,
      ),
    );
    assert.ok(!result.outputs.some((x) => x.endsWith("需要你提供的资料.md")));
  } finally {
    server.close();
    await ctx.done();
  }
});

test("格式引用在页面里找不到时不采纳，任务失败并要求补充官方要求", async () => {
  const { server, url } = await formatServer(
    "<title>征文通知</title><p>欢迎投稿，具体要求见网盘附件。</p>",
  );
  const ctx = await setup(brief([item("征文论文", [])]));
  try {
    const writes = [];
    await assert.rejects(
      runOrchestration(
        ctx.cfg,
        ctx.store,
        formatGateway(url, "论文请以 PDF 格式提交", writes),
        { jobId: ctx.job, competitionId: ctx.id, idea },
      ),
      /提交文件格式未核实[\s\S]*compete materials/,
    );
    assert.deepEqual(
      ctx.store.competition(ctx.id).brief.deliverables[0].formats,
      [],
    );
    assert.equal(writes.length, 0, "格式没核实就不该开始写");
  } finally {
    server.close();
    await ctx.done();
  }
});

test("只承认引用里写明的文件格式", async () => {
  const { formatsInQuote } = await import("../dist/workflows/formats.js");
  assert.deepEqual(formatsInQuote("请以 Word 格式提交"), ["docx"]);
  assert.deepEqual(formatsInQuote("作品打包为压缩包，附 PDF 说明"), [
    "pdf",
    "zip",
  ]);
  assert.deepEqual(formatsInQuote("稿件字数不少于 3000 字"), []);
});

test("待补资料清单合并重复和互相包含的条目", async () => {
  const { mergeRequests } = await import("../dist/workflows/orchestrator.js");
  assert.deepEqual(
    mergeRequests([
      "作者姓名",
      "作者姓名、单位及院系：用于题名页",
      "作者姓名",
      "实测开启力数据",
    ]),
    ["作者姓名、单位及院系：用于题名页", "实测开启力数据"],
  );
});

test("图片模型拒绝某个画面时只返工这张图，不中止整个任务", async () => {
  const ctx = await setup(brief([item("效果图", ["png"])]));
  try {
    let draws = 0;
    const briefs = [];
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generateImage: async () => {
        draws++;
        if (draws === 1)
          throw Error(
            "图片模型调用失败：HTTP 400 目前无法在此对话中直接生成或编辑图片。",
          );
        return {
          data: await sharp({
            create: {
              width: 800,
              height: 600,
              channels: 3,
              background: "#336699",
            },
          })
            .png()
            .toBuffer(),
          mime: "image/png",
        };
      },
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [documentTask({ kind: "image", format: "png" })],
          });
        if (prompt.includes("设计一张独特的图片作品")) {
          briefs.push(prompt);
          return JSON.stringify({ image_prompt: "产品渲染", caption: "" });
        }
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { issues: [] });
        throw Error("unexpected");
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.equal(draws, 2);
    assert.match(briefs[1], /图片模型拒绝了上一版画面描述/);
    assert.equal(result.deliverables[0].review.pass, true);
  } finally {
    await ctx.done();
  }
});

test("最后一步把所有交付物汇总成一个最终提交包，按交付物分目录", async () => {
  const ctx = await setup(
    brief([item("方案报告", ["docx"]), item("展示PPT", ["pptx"])]),
  );
  try {
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [
              {
                id: "report",
                deliverable: 0,
                title: "方案报告",
                kind: "document",
                format: "docx",
                instructions: "写方案",
                acceptance: ["有方案"],
              },
              {
                id: "deck",
                deliverable: 1,
                title: "展示PPT",
                kind: "slides",
                format: "pptx",
                instructions: "展示",
                acceptance: ["有封面"],
              },
            ],
            packages: [],
          });
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { issues: [] });
        if (prompt.includes("直接创作"))
          return JSON.stringify(
            prompt.includes("任务：展示PPT")
              ? {
                  kind: "slides",
                  title: "展示",
                  sources: [],
                  slides: [
                    {
                      background: "FFFFFF",
                      elements: [
                        {
                          type: "text",
                          text: "封面",
                          x: 0.5,
                          y: 0.5,
                          w: 6,
                          h: 1,
                          fontSize: 28,
                        },
                      ],
                    },
                  ],
                }
              : {
                  kind: "text",
                  title: "方案报告",
                  text: "## 方案\n正文",
                  sources: [],
                },
          );
        throw Error("unexpected " + prompt.slice(0, 40));
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    assert.match(result.outputs[0], /最终提交包\.zip$/, "最终包排在输出最前");
    const names = Object.keys(
      (await JSZip.loadAsync(await readFile(result.outputs[0]))).files,
    );
    assert.ok(
      names.some((n) => /^1-方案报告\/.+\.docx$/.test(n)),
      names.join(","),
    );
    assert.ok(
      names.some((n) => /^2-展示PPT\/.+\.pptx$/.test(n)),
      names.join(","),
    );
    assert.ok(
      !names.some((n) => n.includes("需要你提供的资料")),
      "待补资料不进提交包",
    );
  } finally {
    await ctx.done();
  }
});

test("规划里只有真正的硬缺口才交给用户确认", async () => {
  const ctx = await setup(brief([item("散文作品", ["docx"])]));
  try {
    const g = {
      search: async () => [],
      inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
      generate: async (role, prompt) => {
        if (prompt.includes("拆解成可以实际制作的文件任务"))
          return JSON.stringify({
            tasks: [documentTask({ format: "docx" })],
            packages: [],
            notes: [
              "本轮仅需提交1个DOCX文件，直接作为作品提交，不需要打包。",
              "征稿未提供官方模板或文件命名规则；计划采用可识别文件名。",
              "通知未显示报名截止时间与提交方式，无法确定是否仍需报名。",
            ],
          });
        if (prompt.includes("任务：作品验收"))
          return reviewJSON(prompt, { issues: [] });
        if (prompt.includes("直接创作"))
          return JSON.stringify({
            kind: "text",
            title: "作品",
            text: "## 正文\n经过实际生成的正文。",
            sources: [],
          });
        throw Error("unexpected prompt");
      },
    };
    const result = await runOrchestration(ctx.cfg, ctx.store, g, {
      jobId: ctx.job,
      competitionId: ctx.id,
      idea,
    });
    const file = result.outputs.find((x) => x.endsWith("需要你提供的资料.md"));
    assert.ok(file, "仍有硬缺口时生成待补文件");
    const text = await readFile(file, "utf8");
    assert.match(text, /报名截止时间/, "硬缺口交给用户");
    assert.doesNotMatch(text, /不需要打包/, "执行说明不是用户待办");
    assert.doesNotMatch(text, /未提供官方模板/, "系统已自行处理的不要重复问");
    assert.equal(result.deliverables[0].status, "submission");
  } finally {
    await ctx.done();
  }
});

test("官方模板格式无法保留时快速失败，不空耗制作轮次", async () => {
  const d = item("手写件扫描PDF", ["pdf"]);
  d.official_template = "https://example.org/template.pdf";
  const c = await setup(brief([d]));
  const g = documentGateway({ tasks: [documentTask({ format: "pdf" })] });
  try {
    await assert.rejects(
      runOrchestration(c.cfg, c.store, g, { jobId: c.job, competitionId: c.id, idea }),
      (e) => /无法自动保留/.test(e.message) && !/制作失败/.test(e.message),
    );
    // 手写原件类：快速失败前生成排版参考稿与风险点声明，不进入正式制作返工
    assert.equal(g.calls.writes, 1);
    assert.ok(c.store.artifacts(c.job).some((a) => a.kind === "risk-note"));
  } finally {
    await c.done();
  }
});

test("官方要求本人手写原件时生成排版参考稿与风险点声明，不伪造扫描件", async () => {
  const d = item("亲笔手写作品扫描件", ["pdf"]);
  const c = await setup(brief([d]));
  const calls = { writes: 0, plans: 0 };
  const g = {
    search: async () => [],
    inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
    generate: async (role, prompt) => {
      if (prompt.includes("拆解成可以实际制作的文件任务")) {
        calls.plans++;
        return JSON.stringify({
          tasks: [
            documentTask({
              format: "pdf",
              title: "亲笔手写作品扫描件",
              instructions: "本人手写完成后扫描提交，保持手写原件风貌",
            }),
          ],
          packages: [],
          notes: [],
        });
      }
      if (prompt.includes("排版参考稿")) {
        calls.writes++;
        return JSON.stringify({
          kind: "text",
          title: "排版参考稿",
          text: "排版参考稿正文，供用户誊写对照",
          sources: [],
          needs_input: ["官方要求本人手写完成后扫描并替换本稿"],
        });
      }
      throw Error("unexpected prompt: " + prompt.slice(0, 80));
    },
  };
  try {
    await assert.rejects(
      runOrchestration(c.cfg, c.store, g, { jobId: c.job, competitionId: c.id, idea }),
      (e) => /本人手写.*排版参考稿|排版参考稿.*本人手写/s.test(e.message) && !/制作失败/.test(e.message),
    );
    assert.equal(calls.writes, 1, "只生成一份排版参考稿，不伪造扫描件");
    const artifacts = c.store.artifacts(c.job);
    assert.ok(artifacts.some((a) => a.kind === "risk-note"), "风险点声明已登记");
    assert.ok(artifacts.some((a) => a.kind === "reference-draft"), "排版参考稿已登记");
  } finally {
    await c.done();
  }
});
