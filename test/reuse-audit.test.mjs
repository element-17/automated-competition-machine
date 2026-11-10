import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { auditTextReuse } from "../dist/workflows/reuse-audit.js";
import { loadJobView, jobViewSummary } from "../dist/core/job-view.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "reuse-audit-"));
  const store = new Store(dir);
  const competition = store.addCompetition("https://example.test/current", "当前赛事");
  const job = store.createJob(competition, "automatic", {}, 50);
  const folder = join(dir, "jobs", job);
  await mkdir(folder, { recursive: true });
  const path = join(folder, "work.txt");
  const text = Array.from({ length: 450 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
  await writeFile(path, text);
  return { dir, store, job, folder, path, text, competition,
    input: { cfg: { dataDir: dir }, store, jobId: job, taskId: "report", round: 1, kind: "document", format: "txt", paths: [path], evidence: [] },
    async done() { store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("复用审计读取实际文件，报告来源片段且不重复计数", async () => {
  const c = await fixture();
  try {
    const input = { ...c.input, evidence: [{ url: "https://example.test/source", title: "参考作品", kind: "novelty", text: c.text }] };
    const report = await auditTextReuse(input);
    assert.equal(report.status, "blocked");
    assert.ok(report.matches.every((m) => c.text.includes(m.quote)));
    await auditTextReuse(input);
    const saved = JSON.parse(await readFile(join(c.folder, "text-reuse.json"), "utf8"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].artifactHashes.length, 1);
    assert.equal(saved[0].report.status, "blocked");
    const view = await loadJobView(c.dir, c.job);
    assert.equal(view.reuse[0].report.matches[0].referenceId, "source:https://example.test/source");
    assert.match(jobViewSummary(view).join(" "), /不是原创率或AI检测/);
  } finally { await c.done(); }
});

test("历史比较排除同赛事返工，只比较其他已完成作品", async () => {
  const c = await fixture();
  try {
    const same = c.store.createJob(c.competition, "automatic", {}, 50);
    c.store.setJob(same, "completed");
    c.store.artifact(same, "submission", c.path, null);
    assert.equal((await auditTextReuse(c.input)).status, "unverified");
    const otherId = c.store.addCompetition("https://example.test/history", "历史赛事");
    const other = c.store.createJob(otherId, "automatic", {}, 50);
    const folder = join(c.dir, "jobs", other);
    await mkdir(folder, { recursive: true });
    const path = join(folder, "old.txt");
    await writeFile(path, c.text);
    c.store.setJob(other, "completed");
    c.store.artifact(other, "submission", path, null);
    const report = await auditTextReuse(c.input);
    assert.equal(report.status, "blocked");
    assert.equal(report.matches[0].kind, "history");
    assert.match(report.matches[0].referenceId, new RegExp(other));
  } finally { await c.done(); }
});

test("翻译及官方模板显式不适用，损坏历史不冒充无复用", async () => {
  const c = await fixture();
  try {
    assert.equal((await auditTextReuse({ ...c.input, kind: "translation" })).status, "not_applicable");
    assert.equal((await auditTextReuse({ ...c.input, officialTemplate: "https://example.test/form" })).status, "not_applicable");
    await writeFile(join(c.folder, "text-reuse.json"), "{}");
    await assert.rejects(auditTextReuse(c.input), /历史结构损坏/);
  } finally { await c.done(); }
});

test("当前产物目录越界被拒绝，不能读取任意本地文件", async () => {
  const c = await fixture();
  try {
    const outside = join(c.dir, "outside.txt");
    await writeFile(outside, c.text);
    await assert.rejects(auditTextReuse({ ...c.input, paths: [outside] }), /目录外/);
  } finally { await c.done(); }
});
