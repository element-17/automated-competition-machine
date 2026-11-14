import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BrowserReport } from "../artifacts/browser-checks.js";
import { readModelMetrics } from "./model-metrics.js";

const Check = z.object({
  id: z.string(),
  status: z.enum(["passed", "failed", "unverified"]),
  details: z.array(z.string()).default([]),
  requirement: z.string().optional(),
  actual: z.number().optional(),
  unit: z.string().optional(),
});
const Delivery = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
  // 历史任务记录里可能有 draft/supporting_material/blocked；新流程只产出 submission。
  status: z.enum(["submission", "draft", "supporting_material", "blocked"]),
  rounds: z.number().optional(),
  artifactPaths: z.array(z.string()),
  gaps: z.array(z.string()).default([]),
  checks: z.array(Check).default([]),
});
const Requirement = z.object({
  deliverable: z.number(),
  type: z.string(),
  paths: z.array(z.string()).default([]),
  checks: z.array(Check),
  sources: z
    .array(z.object({ url: z.string(), quote: z.string() }))
    .default([]),
});
const Candidate = z.object({
  candidate: z.number(),
  title: z.string(),
  query: z.string(),
  searchStatus: z.enum(["available", "empty", "failed", "unavailable"]),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      excerpt: z.string().default(""),
    }),
  ),
  failures: z
    .array(z.object({ url: z.string(), error: z.string() }))
    .default([]),
  gaps: z.array(z.string()).default([]),
});
const Resume = z.object({
  id: z.string(),
  reused: z.boolean(),
  reason: z.string().optional(),
});
const Progress = z.object({
  stage: z.string(),
  action: z.string(),
  taskId: z.string().optional(),
  round: z.number().optional(),
  maxRounds: z.number().optional(),
  at: z.string(),
  elapsedSeconds: z.number().optional(),
  budget: z.object({ used: z.number(), limit: z.number() }).optional(),
});

const LayoutReport = z.object({
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  totalPages: z.number().int().positive().nullable(),
  checkedPages: z.array(z.number().int().positive()),
  failedPages: z.array(z.number().int().positive()),
  complete: z.boolean(),
  textCoverage: z.enum(["verified", "mismatch", "unverified", "not_applicable"]),
  textCoverageDetails: z.string(),
  criteria: z.array(z.object({
    criterion: z.number().int().nonnegative(),
    status: z.enum(["passed", "failed", "unverified"]),
    evidence: z.string(),
  })).optional(),
});

const ReuseRecord = z.object({
  taskId: z.string(), round: z.number().int().positive(), paths: z.array(z.string()), checkedAt: z.string(),
  report: z.object({
    status: z.enum(["clear", "review", "blocked", "unverified", "not_applicable"]),
    checked: z.boolean(), complete: z.boolean(), reason: z.string(),
    referenceCount: z.number(), comparedCharacters: z.number(), matchedCharacters: z.number(), coverage: z.number(),
    matches: z.array(z.object({ referenceId: z.string(), title: z.string(), kind: z.enum(["source", "history"]), quote: z.string(), sourceQuote: z.string(), outputStart: z.number(), outputEnd: z.number() })),
    limitations: z.array(z.string()),
  }),
});

export type JobDelivery = z.infer<typeof Delivery>;
export type JobView = {
  jobId: string;
  folder: string;
  manifest: "final" | "partial" | "missing";
  deliverables: JobDelivery[];
  requirements: z.infer<typeof Requirement>[];
  candidates: z.infer<typeof Candidate>[];
  resume: z.infer<typeof Resume>[];
  reuse: z.infer<typeof ReuseRecord>[];
  rounds: {
    taskId: string;
    round: number;
    artifactPaths: string[];
    review: "passed" | "failed" | "pending";
    issues: string[];
    browser?: BrowserReport;
    layout?: z.infer<typeof LayoutReport>;
    layoutPath?: string;
  }[];
  progress: z.infer<typeof Progress> | null;
  modelMetrics: Awaited<ReturnType<typeof readModelMetrics>> | null;
  quality: {
    deliverables: number;
    passed: number;
    acceptanceRate: number | null;
    savedAttempts: number;
    reworkAttempts: number;
    passedChecks: number;
    failedChecks: number;
    unverifiedChecks: number;
  };
  counts: Record<JobDelivery["status"], number>;
  warnings: string[];
  reports: { name: string; path: string; available: boolean }[];
};

/** 界面只读已有记录；缺失、格式损坏与尚未完成验收分别呈现。 */
export async function loadJobView(
  dataDir: string,
  jobId: string,
): Promise<JobView> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(jobId))
    throw Error("任务 ID 格式无效");
  const folder = join(dataDir, "jobs", jobId),
    warnings: string[] = [],
    reports: JobView["reports"] = [];
  async function load<T>(
    name: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const path = join(folder, name);
    let available = false;
    try {
      const info = await stat(path);
      available = true;
      if (!info.isFile() || info.size > 8_000_000)
        throw Error("记录不是普通文件或超过 8 MB");
      return schema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(
          `${name} 无法读取或结构不完整：${e instanceof z.ZodError ? "记录字段不符合要求" : e instanceof Error ? e.message : String(e)}`,
        );
      return null;
    } finally {
      reports.push({ name, path, available });
    }
  }
  const [manifest, partial, requirements, candidates, resume, progress, reuse] =
    await Promise.all([
      load("deliverables.json", z.object({ deliverables: z.array(Delivery) })),
      load("orchestration.json", z.record(z.string(), Delivery)),
      load("requirements.json", z.array(Requirement)),
      load("candidate-evidence.json", z.array(Candidate)),
      load("resume-checks.json", z.array(Resume)),
      load("runtime-progress.json", Progress),
      load("text-reuse.json", z.array(ReuseRecord)),
    ]);
  const deliveries = manifest?.deliverables || Object.values(partial || {});
  const rounds: JobView["rounds"] = [];
  const Round = z.object({
    attempt: z.object({ paths: z.array(z.string()) }),
    review: z
      .object({ pass: z.boolean(), issues: z.array(z.string()).default([]) })
      .optional(),
    browser: BrowserReport.optional(),
  });
  let files: string[] = [];
  try {
    files = await readdir(folder);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      warnings.push("无法列出任务目录");
  }
  for (const name of files
    .filter((n) => /^task-.+-[a-f0-9]{20}-r\d+-state\.json$/.test(n))
    .slice(-100)) {
    const match = /^task-(.+)-[a-f0-9]{20}-r(\d+)-state\.json$/.exec(name)!;
    const value = await load(name, Round);
    const layoutName = name.replace(/-state\.json$/, "-layout.json");
    const layout = files.includes(layoutName) ? await load(layoutName, LayoutReport) : null;
    if (value)
      rounds.push({
        taskId: match[1]!,
        round: Number(match[2]),
        artifactPaths: value.attempt.paths,
        review: value.review
          ? value.review.pass
            ? "passed"
            : "failed"
          : "pending",
        issues: [...new Set([...(value.review?.issues || []), ...(layout?.issues || [])])],
        ...(value.browser ? { browser: value.browser } : {}),
        ...(layout ? { layout, layoutPath: join(folder, layoutName) } : {}),
      });
  }
  const counts: JobView["counts"] = {
    submission: 0,
    draft: 0,
    supporting_material: 0,
    blocked: 0,
  };
  for (const item of deliveries) counts[item.status]++;
  let modelMetrics: JobView["modelMetrics"] = null;
  const metricsPath = join(folder, "model-calls.jsonl");
  let metricsAvailable = false;
  try {
    const info = await stat(metricsPath);
    metricsAvailable = true;
    if (!info.isFile() || info.size > 32_000_000)
      throw Error("调用记录不是普通文件或超过 32 MB");
    modelMetrics = await readModelMetrics(dataDir, jobId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      warnings.push(`模型调用统计无法读取：${e instanceof Error ? e.message : String(e)}`);
  }
  reports.push({ name: "model-calls.jsonl", path: metricsPath, available: metricsAvailable });
  const checks = (requirements || []).flatMap((r) => r.checks);
  const quality: JobView["quality"] = {
    deliverables: deliveries.length,
    passed: counts.submission,
    acceptanceRate: manifest && deliveries.length ? counts.submission / deliveries.length : null,
    savedAttempts: rounds.length,
    reworkAttempts: rounds.filter((r) => r.round > 1).length,
    passedChecks: checks.filter((c) => c.status === "passed").length,
    failedChecks: checks.filter((c) => c.status === "failed").length,
    unverifiedChecks: checks.filter((c) => c.status === "unverified").length,
  };
  return {
    jobId,
    folder,
    manifest: manifest ? "final" : partial ? "partial" : "missing",
    deliverables: deliveries,
    requirements: requirements || [],
    candidates: candidates || [],
    resume: resume || [],
    reuse: reuse || [],
    rounds,
    progress,
    modelMetrics,
    quality,
    counts,
    warnings,
    reports: reports.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function jobViewSummary(view: JobView): string[] {
  const lines = [
    `产物记录：${view.manifest === "final" ? "已有最终清单" : view.manifest === "partial" ? "部分任务已保存，尚无最终清单" : "尚无可读取的产物清单"}`,
    `投稿候选 ${view.counts.submission} | 历史草稿 ${view.counts.draft} | 历史辅助材料 ${view.counts.supporting_material} | 历史阻塞 ${view.counts.blocked}`,
    "流程结束不等于作品符合全部赛事要求。",
  ];
  if (view.progress) {
    const p = view.progress;
    lines.push(
      `最近记录：${p.stage} · ${p.action}${p.taskId ? ` | ${p.taskId}` : ""}${p.round !== undefined ? ` | 第 ${p.round}/${p.maxRounds ?? "?"} 轮` : ""}`,
      `记录时间：${p.at}${p.elapsedSeconds !== undefined ? ` | 本次动作已用 ${p.elapsedSeconds} 秒` : ""}${p.budget ? ` | 预算 ${p.budget.used}/${p.budget.limit}` : ""}`,
    );
  }
  const checks = view.requirements.flatMap((r) => r.checks);
  if (checks.length)
    lines.push(
      `规则检查：通过 ${checks.filter((c) => c.status === "passed").length} | 失败 ${checks.filter((c) => c.status === "failed").length} | 未核实 ${checks.filter((c) => c.status === "unverified").length}`,
    );
  if (view.resume.length)
    lines.push(
      `恢复记录：复用 ${view.resume.filter((r) => r.reused).length} 项 | 重新执行 ${view.resume.filter((r) => !r.reused).length} 项`,
    );
  if (view.rounds.length)
    lines.push(`已保存 ${view.rounds.length} 份逐轮产物与评审记录，其中返工 ${view.quality.reworkAttempts} 份`);
  if (view.quality.acceptanceRate !== null)
    lines.push(`当前清单验收通过率：${Math.round(view.quality.acceptanceRate * 100)}%（${view.quality.passed}/${view.quality.deliverables}，不代表真实参赛成绩）`);
  if (view.modelMetrics) {
    const m = view.modelMetrics;
    lines.push(
      `模型调用：${m.calls} 次调用、${m.attempts} 次请求（含重试）；请求成功 ${m.success}、失败 ${m.failure}、未记录结果 ${m.pending}`,
      `请求累计耗时：${(m.durationMs / 1000).toFixed(1)} 秒（并发请求累加，不是任务总时长）；token 用量有记录 ${m.usageKnownAttempts} 次、未知 ${m.usageUnknownAttempts} 次`,
    );
    if (m.runtime.attempts)
      lines.push(`外部 Agent 执行：${m.runtime.attempts} 次；内部模型调用量未统计`);
  } else lines.push("模型调用统计：无可用记录，用量未知");
  if (view.reuse.length)
    lines.push(`文本相似线索：${view.reuse.length} 份逐轮记录；较长匹配 ${view.reuse.filter((r) => r.report.status === "blocked" || r.report.status === "review").length}。仅供正常评审参考，不按比例自动返工，也不要求补交原创证明；这不是原创率或AI检测结果。`);
  if (view.candidates.length)
    lines.push(
      `选题：${view.candidates.length} 个候选，共 ${view.candidates.reduce((n, c) => n + c.sources.length, 0)} 条关联来源；没有证据不代表原创`,
    );
  return [...lines, ...view.warnings.map((w) => `记录警告：${w}`)];
}
