#!/usr/bin/env node
/**
 * 固定样本端到端评测脚本（Benchmark）：
 * 固定 5 类典型高校赛事（散文 DOCX、技术方案书 DOCX、答辩 PPTX、海报 PNG、官方报名表模板），
 * 在独立临时 dataDir 中运行完整编排，统计成功率、轮次、评委模拟分、耗时、调用数与 token，
 * 结果落盘到 bench-results/<日期>.json，方便每次改提示词/渲染/模型后做对照。
 *
 * 用法：
 *   npm run bench -- --dry-run               # 离线校验全部 5 份样本，不消耗 API 额度
 *   npm run bench -- --case essay            # 运行单个样本
 *   npm run bench -- --case essay,pitch-deck # 运行多个样本
 *   npm run bench                            # 运行全部样本
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Table from "cli-table3";
import { Document, Packer, Paragraph, Table as DocxTable, TableRow, TableCell } from "docx";
import { loadConfig } from "../dist/core/config.js";
import { Store } from "../dist/core/store.js";
import { OfficialGateway } from "../dist/core/gateway.js";
import { modelWarnings } from "../dist/agents/models.js";
import { Brief } from "../dist/core/types.js";
import { runOrchestration } from "../dist/workflows/orchestrator.js";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const caseFilter = flagValue("--case")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const budgetOverride = flagValue("--budget") ? Number(flagValue("--budget")) : undefined;
const configArg = flagValue("--config");

const casesDir = resolve("scripts/bench/cases");
const files = (await readdir(casesDir)).filter((f) => f.endsWith(".json")).sort();
const allCases = await Promise.all(
  files.map(async (f) => JSON.parse(await readFile(join(casesDir, f), "utf8"))),
);
const selected = caseFilter?.length
  ? allCases.filter((c) => caseFilter.includes(c.id))
  : allCases;

if (!selected.length) {
  console.error(
    `未找到匹配的评测样本（可用：${allCases.map((c) => c.id).join("、")}）`,
  );
  process.exit(1);
}

/** 为 registration-form 样本生成真实官方表格 Word 模板并通过本地 HTTP 托管。 */
async function startTemplateServer() {
  const buf = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: "高校智能创新竞赛校内选拔赛报名表" }),
            new DocxTable({
              rows: [
                "姓名",
                "学校",
                "学院",
                "专业",
                "联系电话",
                "项目名称",
                "项目简介",
                "指导教师签字",
              ].map(
                (label) =>
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph(`${label}：`)] }),
                      new TableCell({ children: [new Paragraph("")] }),
                    ],
                  }),
              ),
            }),
          ],
        },
      ],
    }),
  );
  const server = createServer((_req, res) => {
    res.setHeader(
      "content-type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/official-registration-form.docx`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

async function readModelCallStats(jobDir) {
  const path = join(jobDir, "model-calls.jsonl");
  if (!existsSync(path)) return { requests: 0, inputTokens: 0, outputTokens: 0 };
  const lines = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
  let inputTokens = 0, outputTokens = 0, requests = 0;
  for (const row of lines) {
    if (row.phase === "end" || row.usage || row.durationMs !== undefined) requests++;
    if (row.usage?.inputTokens) inputTokens += row.usage.inputTokens;
    if (row.usage?.outputTokens) outputTokens += row.usage.outputTokens;
  }
  return { requests: requests || lines.length, inputTokens, outputTokens };
}

const baseCfg = loadConfig(configArg);
const warnings = modelWarnings(baseCfg);
if (warnings.length) {
  console.error("\n[配置质量提醒]");
  for (const w of warnings) console.error(`  - ${w}`);
}

if (dryRun) {
  const table = new Table({
    head: ["Case", "名称", "交付格式", "Brief 校验"],
  });
  for (const c of selected) {
    Brief.parse(c.brief);
    table.push([
      c.id,
      c.name,
      c.brief.deliverables.flatMap((d) => d.formats).join("/"),
      "OK",
    ]);
  }
  console.log(table.toString());
  console.log(`\n共校验 ${selected.length} 份固定评测样本（--dry-run 未调用模型）。`);
  process.exit(0);
}

const results = [];
for (const c of selected) {
  const dir = await mkdtemp(join(tmpdir(), `compete-bench-${c.id}-`));
  const tplServer = c.generateTemplate ? await startTemplateServer() : null;
  const started = Date.now();
  const cfg = { ...baseCfg, dataDir: dir };
  const store = new Store(dir);
  try {
    const brief = Brief.parse(
      JSON.parse(
        JSON.stringify(c.brief).replaceAll(
          "__LOCAL_TEMPLATE_URL__",
          tplServer?.url || "",
        ),
      ),
    );
    const compId = store.addCompetition(c.url, brief.title);
    store.setBrief(compId, brief);
    for (const ev of c.evidence || []) {
      store.putEvidence({
        id: randomUUID(),
        competitionId: compId,
        url: ev.url,
        title: ev.title,
        text: ev.text,
        fetchedAt: new Date().toISOString(),
        kind: ev.kind || "official",
      });
    }
    const maxCalls = budgetOverride || cfg.maxCalls;
    const jobId = store.createJob(compId, "automatic", {}, maxCalls);
    const gateway = new OfficialGateway(cfg, store, jobId);
    console.error(`\n[Bench] 开始运行样本：${c.id}（${c.name}）...`);
    const out = await runOrchestration(cfg, store, gateway, {
      jobId,
      competitionId: compId,
      idea: c.idea || null,
    });
    const stats = await readModelCallStats(join(dir, "jobs", jobId));
    const rounds = out.deliverables
      .filter((d) => typeof d.rounds === "number")
      .map((d) => `${d.id || d.type}:${d.rounds}`);
    const scores = out.deliverables
      .map((d) => d.review?.scorecard?.total)
      .filter((x) => typeof x === "number");
    results.push({
      id: c.id,
      name: c.name,
      ok: true,
      errorHead: "",
      rounds: rounds.join(", ") || "-",
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      seconds: Math.round((Date.now() - started) / 1000),
      ...stats,
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    results.push({
      id: c.id,
      name: c.name,
      ok: false,
      errorHead: err.split(/\r?\n/)[0].slice(0, 120),
      rounds: "-",
      avgScore: null,
      seconds: Math.round((Date.now() - started) / 1000),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  } finally {
    store.close();
    if (tplServer) await tplServer.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const table = new Table({
  head: ["Case", "结果", "轮次", "评委分", "耗时(s)", "请求数", "Tokens(in/out)", "首句原因"],
});
for (const r of results) {
  table.push([
    r.id,
    r.ok ? "PASS" : "FAIL",
    r.rounds,
    r.avgScore ?? "-",
    r.seconds,
    r.requests,
    `${r.inputTokens}/${r.outputTokens}`,
    r.errorHead || "-",
  ]);
}
console.log("\n" + table.toString());

const date = new Date().toISOString().slice(0, 10);
const outDir = resolve("bench-results");
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `${date}.json`);
await writeFile(
  outFile,
  JSON.stringify({ runAt: new Date().toISOString(), warnings, results }, null, 2) + "\n",
  "utf8",
);
console.log(`结果已写入：${outFile}`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
