import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { Brief } from "../dist/core/types.js";
import { runOrchestration } from "../dist/workflows/orchestrator.js";
import { browserAvailability } from "../dist/artifacts/browser-checks.js";
import { loadJobView } from "../dist/core/job-view.js";

function reviewJSON(prompt, verdict = { issues: [] }) {
  const raw = prompt.match(/本次负责的标准：(\[[^\n]*\])。JSON/)?.[1];
  const expected = raw ? JSON.parse(raw) : [];
  return JSON.stringify({ ...verdict, criteria: expected.map(({ criterion, requirement }) => ({
    criterion, status: verdict.pass === false || verdict.issues.length ? "failed" : "passed",
    evidence: `测试检查实际产物：${requirement}`,
  })) });
}

const suite = {
  cases: [
    {
      name: "点击计数",
      criterion: 0,
      steps: [{ action: "click", selector: "#add" }],
      expect: [{ selector: "#count", text: "1" }],
    },
  ],
};
const plan = {
  tasks: [
    {
      id: "counter",
      deliverable: 0,
      title: "计数器",
      kind: "software",
      format: "html",
      instructions: "离线计数器，点击加一",
      acceptance: ["点击一次按钮后计数从0变成1"],
    },
  ],
  packages: [],
  notes: [],
};
for (const mode of ["seven", "mixed", "missing", "visual-failed", "file-failed"]) test(
  `逐标准分配验收：${mode}`,
  { skip: !browserAvailability().available },
  async () => {
    const c = await setup();
    try {
      const mixed = mode !== "seven" && mode !== "missing";
      const count = mixed ? 1 : 7;
      const acceptance = Array.from({ length: count }, (_, i) => `点击第${i + 1}个按钮显示${i + 1}`);
      if (mixed) acceptance.push("界面布局清晰无重叠", mode === "file-failed" ? "文件名为wrong.html" : "文件名为counter.html");
      const task = { ...plan.tasks[0], acceptance };
      const selected = { tasks: [task], packages: [] };
      c.store.setBrief(c.id, Brief.parse({ title: "软件赛", deliverables: [{ type: "网页软件", formats: ["html"], naming: "counter.html" }] }));
      let suites = 0;
      const g = {
        search: async () => [],
        generate: async (_role, prompt) => {
          if (prompt.includes("拆解成可以实际制作的文件任务")) return JSON.stringify(selected);
          if (prompt.includes("为实际网页交付物设计浏览器验收用例")) {
            suites++;
            assert.match(prompt, /最多12个用例/);
            return JSON.stringify({ cases: Array.from({ length: mode === "missing" ? 6 : count }, (_, criterion) => ({
              name: `按钮${criterion + 1}显示结果`, criterion,
              steps: [{ action: "click", selector: `#b${criterion}` }],
              expect: [{ selector: `#o${criterion}`, text: String(criterion + 1) }],
            })) });
          }
          if (prompt.includes("任务：作品验收")) return reviewJSON(prompt);
          throw Error("unexpected prompt");
        },
        inspectImage: async (prompt) => reviewJSON(prompt, mode === "visual-failed"
          ? { issues: ["文字遮挡按钮"] } : { issues: [] }),
        buildProject: async (folder) => writeFile(join(folder, "index.html"),
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>计数器</title><body>${Array.from({ length: count }, (_, i) => `<p><button id="b${i}">按钮${i + 1}</button><output id="o${i}">0</output></p>`).join("")}<script>${Array.from({ length: count }, (_, i) => `document.querySelector('#b${i}').onclick=()=>document.querySelector('#o${i}').textContent='${i + 1}';`).join("")}</script></body>`),
      };
      const input = { jobId: c.job, competitionId: c.id, idea: null };
      if (["missing", "visual-failed", "file-failed"].includes(mode)) {
        await assert.rejects(runOrchestration(c.cfg, c.store, g, input), /覆盖全部交互|未通过验收|未通过全部验收/);
        assert.ok(!c.store.artifacts(c.job).some((a) => a.kind === "submission"));
      } else {
        const result = await runOrchestration(c.cfg, c.store, g, input);
        const checks = result.deliverables[0].checks.filter((c) => c.id.startsWith("criterion-"));
        assert.equal(checks.length, acceptance.length);
        assert.ok(checks.every((c) => c.status === "passed"));
        assert.equal(checks.filter((c) => c.id.endsWith("interaction")).length, count);
        if (mixed) {
          assert.ok(checks.some((c) => c.id === "criterion-1-visual"));
          assert.ok(checks.some((c) => c.id === "criterion-2-file"));
        }
        assert.equal(suites, 1);
      }
    } finally { c.store.close(); await rm(c.dir, { recursive: true, force: true }); }
  },
);

const html = (value) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>计数器</title><body><button id="add">加一</button><output id="count">0</output><script>document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent='${value}'</script></body>`;
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "browser-orch-"));
  const store = new Store(dir);
  const id = store.addCompetition("https://example.org/software", "软件赛");
  store.setBrief(
    id,
    Brief.parse({
      title: "软件赛",
      deliverables: [{ type: "网页软件", formats: ["html"] }],
      requires_idea: false,
    }),
  );
  const job = store.createJob(id, "automatic", {}, 40);
  return {
    dir,
    store,
    id,
    job,
    cfg: { dataDir: dir, execution: { productionRounds: 2 } },
  };
}

test(
  "实际浏览器失败驱动第二轮修复，沿用首轮用例并保留每轮截图",
  { skip: !browserAvailability().available },
  async () => {
    const c = await setup();
    let builds = 0,
      suites = 0,
      reviews = 0;
    try {
      const gateway = {
        search: async () => [],
        inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
        generate: async (_role, prompt) => {
          if (prompt.includes("拆解成可以实际制作的文件任务"))
            return JSON.stringify(plan);
          if (prompt.includes("为实际网页交付物设计浏览器验收用例")) {
            suites++;
            return JSON.stringify(suite);
          }
          if (prompt.includes("任务：作品验收")) {
            reviews++;
            return reviewJSON(prompt, { pass: true, issues: [] });
          }
          throw Error("unexpected");
        },
        buildProject: async (folder, prompt) => {
          builds++;
          if (builds === 2) assert.match(prompt, /浏览器实测/);
          await writeFile(
            join(folder, "index.html"),
            html(builds === 1 ? "2" : "1"),
          );
        },
      };
      const result = await runOrchestration(c.cfg, c.store, gateway, {
        jobId: c.job,
        competitionId: c.id,
        idea: null,
      });
      assert.equal(builds, 2);
      assert.equal(suites, 1);
      assert.equal(reviews, 1);
      const delivery = result.deliverables[0];
      assert.equal(delivery.rounds, 2);
      assert.equal(
        delivery.checks.find((x) => x.id === "interaction").status,
        "passed",
      );
      // 浏览器交互和截图视觉都通过，才算投稿件。
      assert.equal(delivery.status, "submission");
      const view = await loadJobView(c.dir, c.job);
      assert.deepEqual(
        view.rounds.map((r) => r.browser.status),
        ["failed", "passed"],
      );
      assert.ok(view.rounds.every((r) => r.browser.screenshots.length >= 2));
      const before = builds;
      await runOrchestration(c.cfg, c.store, gateway, {
        jobId: c.job,
        competitionId: c.id,
        idea: null,
      });
      assert.equal(builds, before);
    } finally {
      c.store.close();
      await rm(c.dir, { recursive: true, force: true });
    }
  },
);

test(
  "软件制作后暂停保存归档，恢复只继续浏览器与内容验收",
  { skip: !browserAvailability().available },
  async () => {
    const c = await setup();
    let builds = 0;
    try {
      const gateway = {
        search: async () => [],
        inspectImage: async (prompt) => reviewJSON(prompt, { issues: [], suggestions: [] }),
        generate: async (_role, prompt) => {
          if (prompt.includes("拆解成可以实际制作的文件任务"))
            return JSON.stringify(plan);
          if (prompt.includes("为实际网页交付物设计浏览器验收用例"))
            return JSON.stringify(suite);
          if (prompt.includes("任务：作品验收"))
            return reviewJSON(prompt, { pass: true, issues: [] });
          throw Error("unexpected");
        },
        buildProject: async (folder) => {
          builds++;
          await writeFile(join(folder, "index.html"), html("1"));
          c.store.requestJobControl(c.job, "pause");
        },
      };
      await assert.rejects(
        runOrchestration(c.cfg, c.store, gateway, {
          jobId: c.job,
          competitionId: c.id,
          idea: null,
        }),
        /暂停/,
      );
      const folder = join(c.dir, "jobs", c.job),
        state = (await readdir(folder)).find((n) =>
          n.endsWith("-r1-state.json"),
        );
      assert.ok(state);
      const saved = JSON.parse(await readFile(join(folder, state), "utf8"));
      assert.match(await readFile(saved.attempt.paths[0], "utf8"), /计数器/);
      c.store.resumeJob(c.job);
      const result = await runOrchestration(c.cfg, c.store, gateway, {
        jobId: c.job,
        competitionId: c.id,
        idea: null,
      });
      assert.equal(builds, 1);
      assert.equal(
        result.deliverables[0].checks.find((c) => c.id === "interaction")
          .status,
        "passed",
      );
    } finally {
      c.store.close();
      await rm(c.dir, { recursive: true, force: true });
    }
  },
);
