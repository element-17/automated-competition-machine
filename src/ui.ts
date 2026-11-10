import * as p from "@clack/prompts";
import pc from "picocolors";
import Table from "cli-table3";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  loadConfig,
  saveModels,
  saveSearchConfig,
  savePrompt,
  timeRanges,
  executionSettings,
  saveExecutionConfig,
  configPath,
  type AppConfig,
} from "./core/config.js";
import {
  agentReady,
  agentRuntimes,
  builtinProviders,
  explicitAgents,
  findProvider,
  hasKey,
  modelLabel,
  modelProblems,
  protocolLabels,
  protocols,
  providers,
  resolveAgent,
  runtimeNames,
  runtimeProtocols,
  saveEnvKey,
  type Provider,
  type Protocol,
  type RuntimeName,
} from "./agents/models.js";
import {
  installRuntime,
  isInstalled,
  removeRuntime,
  runtimeReady,
  runtimeStateText,
  runtimeStatus,
  runtimes,
} from "./agents/runtimes.js";
import { agentRows } from "./agents/agents.js";
import {
  agents,
  agentLabels,
  defaultPrompts,
  inheritsReviewer,
  isCustomPrompt,
  promptOf,
  type AgentName,
} from "./agents/prompts.js";
import { Store } from "./core/store.js";
import { loadJobView, jobViewSummary } from "./core/job-view.js";
import { OfficialGateway, type GatewayProgress } from "./core/gateway.js";
import { runAutomatic } from "./workflows/autonomous.js";
import { runJob } from "./workflows/workflow.js";
import { browserAvailability } from "./artifacts/browser-checks.js";
import {
  discoverCompetitions,
  isCompetitionCandidate,
  plannedQueries,
  siteOf,
  SCREEN_RECORD,
} from "./competition/discovery.js";
import { fetchDocument, normalizeUrl } from "./competition/sources.js";
import { processQueue } from "./competition/queue.js";
import { screenQueue } from "./competition/screening.js";

type Entry = {
  competitionId: string;
  title: string;
  url: string;
  state: string;
  jobId: string | null;
  error: string | null;
  reviewStatus: string;
  reviewReason: string | null;
  reviewUrl: string | null;
  reviewQuote: string | null;
  reviewDeadline: string | null;
  reviewedBy: string | null;
};
const stateLabels: Record<string, string> = {
  candidate: "待审核",
  queued: "等待",
  pending: "等待执行",
  running: "正在执行",
  processing: "处理中",
  completed: "流程结束",
  failed: "执行中断",
  paused: "已暂停",
  stopped: "已停止",
};
const reviewLabels: Record<string, string> = {
  unreviewed: "未审核",
  valid: "通过",
  invalid: "无效",
  needs_review: "待确认",
};
/** 接近 git log 的 pager：按当前终端高度读取一屏，避免固定输出大块内容。 */
const queuePageSize = () =>
  Math.max(5, Math.min(30, (process.stdout.rows || 24) - 6));
const menuPageSize = () =>
  Math.max(5, Math.min(10, (process.stdout.rows || 24) - 12));
/** 历史赛事名称可能包含整段公告；菜单和标题只展示安全的单行摘要。 */
const jobTitle = (title: string) => {
  const chars = Array.from(
    title
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return chars.length > 28 ? `${chars.slice(0, 28).join("")}…` : chars.join("");
};
export function queueSummary(items: Entry[]) {
  const counts = { queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const item of items)
    if (item.state in counts) counts[item.state as keyof typeof counts]++;
  return counts;
}
function credentials(cfg: AppConfig) {
  return {
    writer: agentReady(cfg, "writer"),
    reviewer: agentReady(cfg, "reviewer"),
    search:
      cfg.search.provider === "sources"
        ? cfg.sources.length > 0
        : cfg.search.provider === "brave"
          ? !!process.env.BRAVE_SEARCH_API_KEY
          : !!cfg.search.url,
    coder: agentReady(cfg, "coder"),
  };
}
const cancelled = (value: unknown) => p.isCancel(value);
const yesno = (ready: boolean) =>
  ready ? pc.green("已配置") : pc.yellow("未配置");
// 新流程只产出 submission；其余是旧任务的历史状态，仅用于显示。
const deliveryLabels: Record<string, string> = {
  submission: "投稿候选",
  draft: "历史草稿",
  supporting_material: "历史辅助材料",
  blocked: "历史阻塞",
};
const checkLabels: Record<string, string> = {
  passed: "通过",
  failed: "失败",
  unverified: "未核实",
};
let showRawResponses = false;

/** 运行中保留简单按键控制；当前调用完成后由持久控制请求在安全边界生效。 */
function taskKeys(store: Store, current: () => string | undefined) {
  if (!process.stdin.isTTY) return () => {};
  const prior = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const onData = (chunk: Buffer) => {
    const key = chunk.toString().toLowerCase();
    if (!["p", "s", "\u0003"].includes(key)) return;
    const id = current();
    if (!id) return;
    try {
      const result = store.requestJobControl(
        id,
        key === "s" ? "stop" : "pause",
      );
      p.log.info(
        result.pending
          ? "控制请求已保存，当前调用及产物保存后生效。"
          : "任务控制已生效。",
      );
    } catch (e) {
      p.log.warn(e instanceof Error ? e.message : String(e));
    }
  };
  process.stdin.on("data", onData);
  return () => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode(prior);
    process.stdin.pause();
  };
}

async function logMenu() {
  const value = await p.select({
    message: "本次界面的运行日志显示",
    initialValue: showRawResponses ? "raw" : "concise",
    options: [
      { value: "concise", label: "简洁进度", hint: "动作、轮次、耗时和预算" },
      {
        value: "raw",
        label: "显示原始模型返回",
        hint: "用于诊断；长文本可能刷屏",
      },
    ],
  });
  if (!cancelled(value)) {
    showRawResponses = value === "raw";
    p.log.success(
      showRawResponses ? "已启用原始模型返回。" : "已使用简洁进度。",
    );
  }
}

async function showReportLines(title: string, lines: string[]) {
  const pageSize = Math.max(6, Math.min(18, (process.stdout.rows || 28) - 10));
  let offset = 0;
  if (!lines.length) {
    p.log.info(`${title}：尚无记录。`);
    return;
  }
  while (true) {
    p.note(
      lines.slice(offset, offset + pageSize).join("\n"),
      `${title} · ${Math.floor(offset / pageSize) + 1}/${Math.ceil(lines.length / pageSize)}`,
    );
    const choice = await p.select({
      message: "查看记录",
      options: [
        ...(offset + pageSize < lines.length
          ? [{ value: "next", label: "下一页" }]
          : []),
        ...(offset > 0 ? [{ value: "previous", label: "上一页" }] : []),
        { value: "back", label: "返回任务" },
      ],
    });
    if (cancelled(choice) || choice === "back") return;
    offset =
      choice === "next" ? offset + pageSize : Math.max(0, offset - pageSize);
  }
}

/** 从主菜单或赛事详情检查已落盘的任务，不把流程状态混同为作品验收。 */
async function inspectJob(cfg: AppConfig, store: Store, jobId?: string) {
  if (!jobId) {
    const recent = store.db
      .prepare(
        "SELECT j.id,j.state,c.title FROM jobs j JOIN competitions c ON c.id=j.competition_id ORDER BY j.updated_at DESC,j.rowid DESC LIMIT 30",
      )
      .all() as { id: string; state: string; title: string }[];
    if (!recent.length) {
      p.log.info("还没有任务。");
      return;
    }
    const value = await p.select({
      message: "选择任务（最近 30 项）",
      maxItems: menuPageSize(),
      options: [
        ...recent.map((j) => ({
          value: j.id,
          label: jobTitle(j.title),
          hint: `${j.state} | ${j.id}`,
        })),
        { value: "__id", label: "输入其他任务 ID" },
        { value: "__back", label: "返回" },
      ],
    });
    if (cancelled(value) || value === "__back") return;
    if (value === "__id") {
      const input = await p.text({
        message: "任务 ID",
        validate: (v) => (v?.trim() ? undefined : "请输入任务 ID"),
      });
      if (cancelled(input)) return;
      jobId = input.trim();
    } else jobId = value;
  }
  while (true) {
    const job = store.job(jobId),
      view = await loadJobView(cfg.dataDir, jobId),
      control = store.jobControl(jobId);
    p.note(
      [
        `任务：${job.id}`,
        `执行状态：${job.state === "failed" && /剩余预算不足|已达到模型调用次数上限/.test(job.error || "") ? "预算不足，等待调整" : stateLabels[job.state] || job.state} | 预算 ${job.calls}/${job.maxCalls}`,
        ...(control && job.state === "running"
          ? [
              control.action === "pause"
                ? "等待暂停：当前调用保存后生效"
                : "等待停止：当前调用保存后生效",
            ]
          : []),
        ...(job.error ? [`原因：${job.error}`] : []),
        ...jobViewSummary(view),
      ].join("\n"),
      jobTitle(store.competition(job.competitionId).title),
    );
    const action = await p.select({
      message: "任务记录",
      maxItems: menuPageSize(),
      options: [
        {
          value: "deliveries",
          label: "作品与验收",
          hint: `${view.deliverables.length} 项，含轮次和缺口`,
        },
        { value: "browser", label: "浏览器验收与截图" },
        {
          value: "rounds",
          label: "每轮产物与返工意见",
          hint: `${view.rounds.length} 份已保存记录`,
        },
        {
          value: "requirements",
          label: "规则与实际测量",
          hint: `${view.requirements.length} 项交付要求`,
        },
        {
          value: "evidence",
          label: "选题证据",
          hint: `${view.candidates.length} 个候选`,
        },
        { value: "reuse", label: "文本复用风险与重复片段", hint: `${view.reuse.length} 份检查记录` },
        { value: "resume", label: "恢复记录" },
        { value: "paths", label: "文件与报告路径" },
        { value: "refresh", label: "刷新进度" },
        ...(!["completed", "stopped"].includes(job.state)
          ? [
              { value: "budget", label: "调整任务预算" },
              ...(!control ? [{ value: "pause-job", label: "暂停任务" }] : []),
              { value: "stop-job", label: "停止任务，保留文件" },
              ...(["paused", "failed", "pending"].includes(job.state)
                ? [{ value: "continue-job", label: "继续任务" }]
                : []),
            ]
          : []),
        { value: "back", label: "返回" },
      ],
    });
    if (cancelled(action) || action === "back") return;
    if (action === "refresh") continue;
    if (action === "budget") {
      const value = await p.text({
        message: "任务总预算单位（不能低于已消耗量）",
        initialValue: String(job.maxCalls),
        validate: (v) =>
          /^\d+$/.test(v || "") &&
          Number.isSafeInteger(Number(v)) &&
          Number(v) >= Math.max(1, job.calls)
            ? undefined
            : "请输入不低于已消耗量的正整数",
      });
      if (!cancelled(value)) {
        store.setBudget(jobId, Number(value));
        p.log.success("总预算已更新，已消耗量保留。");
      }
      continue;
    }
    if (action === "pause-job" || action === "stop-job") {
      const result = store.requestJobControl(
        jobId,
        action === "pause-job" ? "pause" : "stop",
      );
      p.log.info(
        result.pending
          ? "请求已保存，当前调用及产物保存后生效。"
          : "已更新任务状态，文件保留。",
      );
      continue;
    }
    if (action === "continue-job") {
      const next = store.resumeJob(jobId);
      if (next.queued) p.log.success("已重新排队，从“处理队列”继续。");
      else {
        const restore = taskKeys(store, () => jobId);
        try {
          const gateway = new OfficialGateway(
            cfg,
            store,
            jobId,
            {},
            progressLog,
          );
          if (job.kind === "automatic")
            await runAutomatic(cfg, store, gateway, jobId, next.resume);
          else await runJob(cfg, store, gateway, jobId, next.resume);
        } catch (e) {
          p.log.warn(e instanceof Error ? e.message : String(e));
        } finally {
          restore();
        }
      }
      continue;
    }
    if (action === "browser")
      await showReportLines(
        "浏览器验收与截图",
        view.rounds.flatMap((r) =>
          r.browser
            ? [
                `${r.taskId} 第 ${r.round} 轮：${checkLabels[r.browser.status]}`,
                ...r.browser.checks.map(
                  (c) =>
                    `  ${c.id}：${checkLabels[c.status]} ${c.details.join("；")}`,
                ),
                ...r.browser.cases.map(
                  (c) =>
                    `  操作：${c.name} · ${checkLabels[c.status]} ${c.details.join("；")}`,
                ),
                ...r.browser.issues.map((x) => `  待处理：${x}`),
                `报告：${r.browser.reportPath}`,
                ...r.browser.screenshots.map((x) => `截图：${x}`),
              ]
            : [],
        ),
      );
    else if (action === "deliveries")
      await showReportLines(
        "作品与验收",
        view.deliverables.flatMap((d) => [
          `${d.title || d.type}：${deliveryLabels[d.status] || d.status}${d.rounds !== undefined ? ` | 已制作 ${d.rounds} 轮` : ""}`,
          ...d.checks.map(
            (c) =>
              `  ${checkLabels[c.status]} · ${c.id}${c.details.length ? `：${c.details.join("；")}` : ""}`,
          ),
          ...d.gaps.map((g) => `  待处理：${g}`),
          ...d.artifactPaths.map((path) => `  文件：${path}`),
        ]),
      );
    else if (action === "rounds")
      await showReportLines(
        "每轮产物与返工意见",
        view.rounds.flatMap((r) => [
          `${r.taskId} · 第 ${r.round} 轮 · ${r.review === "passed" ? "内容评审通过" : r.review === "failed" ? "需要返工" : "等待内容评审"}`,
          ...r.issues.map((x) => `  ${x}`),
          ...(r.layout ? [
            `  版面：${r.layout.complete ? "已检查全部页面" : "检查未完成"} | 总页数 ${r.layout.totalPages ?? "未知"} | 已检 ${r.layout.checkedPages.join("、") || "无"} | 失败 ${r.layout.failedPages.join("、") || "无"}`,
            `  文本覆盖：${r.layout.textCoverageDetails}`,
            ...(r.layout.criteria || []).map((c) => `  视觉标准 ${c.criterion + 1}：${checkLabels[c.status]} · ${c.evidence}`),
            `  版面报告：${r.layoutPath}`,
          ] : []),
          ...r.artifactPaths.map((x) => `  文件：${x}`),
        ]),
      );
    else if (action === "requirements")
      await showReportLines(
        "规则与实际测量",
        view.requirements.flatMap((r) => [
          `${r.deliverable + 1}. ${r.type}`,
          ...r.checks.map(
            (c) =>
              `  ${checkLabels[c.status]} · ${c.requirement || c.id}${c.actual !== undefined ? ` | 实测 ${c.actual} ${c.unit || ""}` : ""}：${c.details.join("；")}`,
          ),
          ...r.sources.flatMap((s) => [
            `  规则来源：${s.url}`,
            `  原文：${s.quote}`,
          ]),
        ]),
      );
    else if (action === "reuse")
      await showReportLines(
        "文本复用风险（不是原创率或AI检测）",
        view.reuse.flatMap((entry) => [
          `${entry.taskId} 第 ${entry.round} 轮：${entry.report.reason}`,
          `范围：${entry.report.referenceCount} 份参考；${entry.report.complete ? "本次比较完成" : "存在未覆盖内容"}；非排除文本匹配 ${entry.report.matchedCharacters}/${entry.report.comparedCharacters} 字符（${Math.round(entry.report.coverage * 100)}%）`,
          ...entry.report.matches.flatMap((m) => [
            `来源：${m.title} · ${m.referenceId}`,
            `作品位置 ${m.outputStart}–${m.outputEnd}：${m.quote}`,
            `来源原文：${m.sourceQuote}`,
          ]),
          ...entry.report.limitations.map((line) => `检查边界：${line}`),
        ]),
      );
    else if (action === "evidence")
      await showReportLines(
        "选题证据",
        view.candidates.flatMap((c) => [
          `${c.candidate}. ${c.title} | 检索 ${c.searchStatus}`,
          `  查询：${c.query}`,
          ...c.sources.flatMap((s) => [
            `  ${s.title}：${s.url}`,
            `  正文片段：${s.excerpt.slice(0, 240)}${s.excerpt.length > 240 ? "…" : ""}`,
          ]),
          ...c.failures.map((f) => `  读取失败：${f.url} · ${f.error}`),
          ...c.gaps.map((g) => `  待核实：${g}`),
        ]),
      );
    else if (action === "resume")
      await showReportLines(
        "恢复记录",
        view.resume.map(
          (r) =>
            `${r.id}：${r.reused ? "输入与产物核对通过，已复用" : "重新执行"}${r.reason ? ` · ${r.reason}` : ""}`,
        ),
      );
    else if (action === "paths")
      await showReportLines("文件与报告路径", [
        `任务目录：${view.folder}`,
        ...view.reports.map(
          (r) => `${r.available ? "已有" : "未生成"} ${r.name}\n${r.path}`,
        ),
        ...view.deliverables.flatMap((d) => d.artifactPaths),
      ]);
  }
}

async function executionMenu(
  cfg: AppConfig,
  configPath?: string,
): Promise<AppConfig> {
  const settings = executionSettings(cfg);
  p.note(
    [
      `单项制作与验收：最多 ${settings.productionRounds} 轮`,
      `规划修正：最多 ${settings.plannerRounds} 轮`,
      `研究追查：最多 ${settings.researchRounds} 轮`,
      `普通模型请求超时：${settings.requestTimeoutSeconds} 秒`,
      `每次调用最多尝试 ${settings.requestAttempts} 次（总时长上限 ${settings.requestTimeoutSeconds * settings.requestAttempts} 秒）`,
      `新任务默认预算：${cfg.maxCalls} 单位`,
      "制作通过即结束；提高上限不会强制用满轮数。研究/软件运行时的轮数与超时在各 Agent 配置中设置。",
    ].join("\n"),
    "长任务设置",
  );
  const productionRounds = await p.text({
    message: "单项制作与验收最多轮数（1-8）",
    initialValue: String(settings.productionRounds),
    validate: intIn(1, 8),
  });
  if (cancelled(productionRounds)) return cfg;
  const plannerRounds = await p.text({
    message: "规划修正最多轮数（1-5）",
    initialValue: String(settings.plannerRounds),
    validate: intIn(1, 5),
  });
  if (cancelled(plannerRounds)) return cfg;
  const researchRounds = await p.text({
    message: "研究追查最多轮数（1-6）",
    initialValue: String(settings.researchRounds),
    validate: intIn(1, 6),
  });
  if (cancelled(researchRounds)) return cfg;
  const timeout = await p.text({
    message: "普通模型请求单次超时秒数（30-1800）",
    initialValue: String(settings.requestTimeoutSeconds),
    validate: intIn(30, 1800),
  });
  if (cancelled(timeout)) return cfg;
  const attempts = await p.text({
    message: `每次调用最多尝试次数（1-5，当前总时长上限 ${Number(timeout) * settings.requestAttempts} 秒）`,
    initialValue: String(settings.requestAttempts),
    validate: intIn(1, 5),
  });
  if (cancelled(attempts)) return cfg;
  const budget = await p.text({
    message: "新任务默认模型预算单位",
    initialValue: String(cfg.maxCalls),
    validate: (v) =>
      /^\d+$/.test(v || "") && Number.isSafeInteger(Number(v)) && Number(v) > 0
        ? undefined
        : "请输入正整数",
  });
  if (cancelled(budget)) return cfg;
  saveExecutionConfig(
    configPath,
    {
      productionRounds: Number(productionRounds),
      plannerRounds: Number(plannerRounds),
      researchRounds: Number(researchRounds),
      requestTimeoutSeconds: Number(timeout),
      requestAttempts: Number(attempts),
    },
    Number(budget),
  );
  p.log.success(
    "长任务设置已保存。设置本身不改写已有任务；恢复队列时若使用更大的预算，会提高任务总上限。",
  );
  return loadConfig(configPath);
}

async function profileMenu(
  cfg: AppConfig,
  path: string | undefined,
): Promise<AppConfig> {
  p.intro("用户资料");
  const current = cfg.profile || {};
  p.note(
    `学校：${current.school || "未设置"}
学院：${current.college || "未设置"}
专业：${current.major || "未设置"}
身份：${current.identity || "未设置"}
姓名：${current.name || "未设置"}
学号：${current.studentId || "未设置"}
电话：${current.phone || "未设置"}
邮箱：${current.email || "未设置"}
指导教师：${current.advisor || "未设置"}
团队名称：${current.teamName || "未设置"}`,
    "当前设置",
  );
  const action = await p.select({
    message: "操作",
    options: [
      { value: "edit", label: "编辑资料" },
      { value: "clear", label: "清空资料" },
      { value: "back", label: "返回" },
    ],
  });
  if (cancelled(action) || action === "back") return cfg;
  if (action === "clear") {
    const file = configPath(path);
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(
      file,
      JSON.stringify({ ...raw, profile: {} }, null, 2) + "\n",
      "utf8",
    );
    p.log.success("用户资料已清空");
    return loadConfig(path);
  }
  const school = await p.text({
    message: "学校",
    placeholder: "如：安徽理工大学",
    defaultValue: current.school,
  });
  if (cancelled(school)) return cfg;
  const college = await p.text({
    message: "学院",
    placeholder: "如：计算机科学与工程学院",
    defaultValue: current.college,
  });
  if (cancelled(college)) return cfg;
  const major = await p.text({
    message: "专业",
    placeholder: "如：软件工程",
    defaultValue: current.major,
  });
  if (cancelled(major)) return cfg;
  const identity = await p.text({
    message: "身份",
    placeholder: "如：本科生、研究生",
    defaultValue: current.identity,
  });
  if (cancelled(identity)) return cfg;
  const name = await p.text({
    message: "姓名",
    placeholder: "如：张三",
    defaultValue: current.name,
  });
  if (cancelled(name)) return cfg;
  const studentId = await p.text({
    message: "学号",
    placeholder: "如：2021001234",
    defaultValue: current.studentId,
  });
  if (cancelled(studentId)) return cfg;
  const phone = await p.text({
    message: "电话",
    placeholder: "如：13800138000",
    defaultValue: current.phone,
  });
  if (cancelled(phone)) return cfg;
  const email = await p.text({
    message: "邮箱",
    placeholder: "如：zhangsan@example.com",
    defaultValue: current.email,
  });
  if (cancelled(email)) return cfg;
  const advisor = await p.text({
    message: "指导教师",
    placeholder: "如：李老师",
    defaultValue: current.advisor,
  });
  if (cancelled(advisor)) return cfg;
  const teamName = await p.text({
    message: "团队名称",
    placeholder: "如：创新实验室",
    defaultValue: current.teamName,
  });
  if (cancelled(teamName)) return cfg;
  const profile = {
    school: school.trim() || undefined,
    college: college.trim() || undefined,
    major: major.trim() || undefined,
    identity: identity.trim() || undefined,
    name: name.trim() || undefined,
    studentId: studentId.trim() || undefined,
    phone: phone.trim() || undefined,
    email: email.trim() || undefined,
    advisor: advisor.trim() || undefined,
    teamName: teamName.trim() || undefined,
  };
  const file = configPath(path);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(
    file,
    JSON.stringify({ ...raw, profile }, null, 2) + "\n",
    "utf8",
  );
  p.log.success("用户资料已保存，下次制作作品时将自动使用这些信息");
  return loadConfig(path);
}

function overview(cfg: AppConfig, store: Store) {
  const count = store.queueStats(),
    auth = credentials(cfg);
  p.note(
    [
      `待审核 ${count.candidate}  |  等待处理 ${count.queued}  |  处理中 ${count.processing}  |  完成 ${count.completed}  |  中断 ${count.failed}  |  暂停 ${count.paused}  |  停止 ${count.stopped}`,
      `审核：未审核 ${count.unreviewed}  |  通过 ${count.valid}  |  待确认 ${count.needs_review}  |  无效 ${count.invalid}`,
      `写作 ${modelLabel(cfg, "writer")}：${yesno(auth.writer)}  |  评审 ${modelLabel(cfg, "reviewer")}：${yesno(auth.reviewer)}  |  ${cfg.search.provider === "sources" ? "高校来源列表" : "搜索"}：${yesno(auth.search)}`,
      cfg.search.provider === "sources"
        ? "当前仅扫描配置的高校来源列表，不支持全网关键词搜索。"
        : "凭据状态仅表示已配置，不能证明可用。",
    ].join("\n"),
    "赛事队列",
  );
}
/** 查看队列时直接进入赛事操作，避免用户先返回主菜单再找修改和移除。 */
async function showQueue(cfg: AppConfig, store: Store) {
  while (true) {
    const item = await selectEntry(store, "选择赛事");
    if (!item) return;
    const choice = await p.select({
      message: `赛事操作：${item.title}`,
      options: [
        { value: "details", label: "查看赛事详情" },
        { value: "edit", label: "修改赛事" },
        { value: "delete", label: "移除赛事" },
        { value: "back", label: "返回队列" },
      ],
    });
    if (cancelled(choice)) return;
    if (choice === "back") continue;
    // 查看详情后直接回到主菜单，避免详情页结束后又被重新带回赛事选择器。
    if (choice === "details") {
      await details(cfg, store, item);
      return;
    } else if (choice === "edit") await edit(store, item);
    else if (choice === "delete") await remove(store, item);
  }
}
function printQueuePage(
  page: Entry[],
  pageSize: number,
  offset: number,
  count: number,
  search: string,
) {
  const width = process.stdout.columns || 100;
  if (width < 80) {
    for (const item of page)
      p.log.info(
        `${stateLabels[item.state] || item.state} / ${reviewLabels[item.reviewStatus] || item.reviewStatus}  ${item.title}\n    任务：${item.jobId || "-"}`,
      );
  } else {
    const table = new Table({
      head: ["状态", "审核", "赛事", "任务 ID"],
      colWidths: [10, 10, Math.min(width, 120) - 59, 35],
      wordWrap: true,
    });
    for (const item of page)
      table.push([
        stateLabels[item.state] || item.state,
        reviewLabels[item.reviewStatus] || item.reviewStatus,
        item.title,
        item.jobId || "-",
      ]);
    console.log(table.toString());
  }
  const pages = Math.max(1, Math.ceil(count / pageSize)),
    current = Math.floor(offset / pageSize) + 1;
  p.log.info(
    `第 ${current}/${pages} 页${search ? `，筛选：${search}` : ""}（${count} 条）`,
  );
}
async function selectEntry(store: Store, message: string) {
  const pageSize = queuePageSize(),
    total = store.queueCount();
  if (!total) {
    p.log.info("队列为空。");
    return null;
  }
  let search = "",
    offset = 0;
  while (true) {
    const count = store.queueCount(search),
      page = store.queuePage(pageSize, offset, search) as Entry[];
    if (!page.length) {
      offset = Math.max(0, offset - pageSize);
      continue;
    }
    printQueuePage(page, pageSize, offset, count, search);
    const controls = [
      { value: "i", label: "选择当前页赛事" },
      ...(offset + pageSize < count ? [{ value: "n", label: "下一页" }] : []),
      ...(offset > 0 ? [{ value: "p", label: "上一页" }] : []),
      ...(count > pageSize ? [{ value: "j", label: "跳转到页码" }] : []),
      { value: "s", label: search ? "修改筛选关键词" : "按关键词筛选" },
      ...(search ? [{ value: "a", label: "显示全部赛事" }] : []),
      { value: "q", label: "返回主菜单" },
    ];
    // selectKey 只监听按键，不显示可聚焦选项；用户按 Enter/方向键时会像卡住。
    // 使用普通 select 后，所有操作都能通过方向键和 Enter 明确选择。
    const choice = await p.select({ message, options: controls });
    if (cancelled(choice) || choice === "q") return null;
    if (choice === "i") {
      const selected = await p.select({
        message: "选择当前页赛事",
        options: page.map((x) => ({
          value: x.competitionId,
          label: x.title,
          hint: `${stateLabels[x.state] || x.state} | ${reviewLabels[x.reviewStatus] || x.reviewStatus}`,
        })),
      });
      if (cancelled(selected)) return null;
      return page.find((x) => x.competitionId === selected) || null;
    }
    if (choice === "n") {
      offset += pageSize;
      continue;
    }
    if (choice === "p") {
      offset = Math.max(0, offset - pageSize);
      continue;
    }
    if (choice === "j") {
      const pages = Math.ceil(count / pageSize),
        raw = await p.text({
          message: `跳转到第几页？（1-${pages}）`,
          defaultValue: String(Math.floor(offset / pageSize) + 1),
          validate: (value) =>
            /^\d+$/.test(value || "") &&
            Number(value) >= 1 &&
            Number(value) <= pages
              ? undefined
              : `请输入 1-${pages} 的整数`,
        });
      if (cancelled(raw)) return null;
      offset = (Number(raw) - 1) * pageSize;
      continue;
    }
    if (choice === "s") {
      const query = await p.text({
        message: "输入赛事名称或网址关键词（留空显示全部）",
        defaultValue: search,
      });
      if (cancelled(query)) return null;
      const text = query.trim();
      if (text && store.queueCount(text) === 0) {
        p.log.warn("没有匹配的赛事。");
        continue;
      }
      search = text;
      offset = 0;
      continue;
    }
    if (choice === "a") {
      search = "";
      offset = 0;
      continue;
    }
  }
}
async function details(cfg: AppConfig, store: Store, item?: Entry | null) {
  item = item || (await selectEntry(store, "选择一场赛事查看详情"));
  if (!item) return;
  const short = (value: string, max = 180) =>
    value.length > max ? `${value.slice(0, max)}…` : value;
  const lines = [
    `状态：${stateLabels[item.state] || item.state}`,
    `审核：${reviewLabels[item.reviewStatus] || item.reviewStatus}`,
    `理由：${short(item.reviewReason || "尚未审核")}`,
    `截止：${item.reviewDeadline || "未确认"}`,
    `审核来源：${item.reviewUrl || "无"}`,
    `原文依据：${short(item.reviewQuote || "无", 120)}`,
    `审核人：${item.reviewedBy || "无"}`,
    `公告：${short(item.url, 150)}`,
    `赛事 ID：${item.competitionId}`,
  ];
  if (item.jobId) {
    const job = store.job(item.jobId);
    lines.push(`任务 ID：${item.jobId}`, `预算：${job.calls}/${job.maxCalls}`);
    if (job.error) lines.push(`错误：${short(job.error)}`);
    const result = job.result as { outputs?: string[]; gaps?: string[] } | null;
    if (result?.outputs?.length)
      lines.push(
        "产物：",
        ...result.outputs.slice(0, 2).map((x) => `  ${short(x, 180)}`),
        ...(result.outputs.length > 2
          ? [`  另有 ${result.outputs.length - 2} 个产物`]
          : []),
      );
    if (result?.gaps?.length)
      lines.push(
        `待核实（${result.gaps.length} 项）：`,
        ...result.gaps.slice(0, 3).map((x) => `  ${short(x, 140)}`),
        ...(result.gaps.length > 3
          ? [`  另有 ${result.gaps.length - 3} 项；完整列表见 result.json`]
          : []),
      );
  }
  if (item.error && !item.jobId) lines.push(`错误：${short(item.error)}`);
  const history = store.queueReviewHistory(item.competitionId) as {
    decision: string;
    reason: string;
    reviewer: string;
    reviewedAt: string;
  }[];
  if (history.length) {
    const latest = history.at(-1)!;
    lines.push(
      `最近审核记录：${latest.reviewedAt} ${reviewLabels[latest.decision] || latest.decision} | ${latest.reviewer}`,
      short(latest.reason),
    );
  }
  p.note(lines.join("\n"), item.title);
  const action = await p.select({
    message: "详情已显示",
    options: [
      ...(item.jobId
        ? [{ value: "job", label: "查看任务进度与交付验收" }]
        : []),
      { value: "back", label: "返回主菜单" },
    ],
  });
  if (action === "job" && item.jobId) await inspectJob(cfg, store, item.jobId);
}
async function edit(store: Store, item?: Entry | null) {
  item = item || (await selectEntry(store, "选择要修改的赛事"));
  if (!item) return;
  const title = await p.text({
    message: "赛事名称",
    initialValue: item.title,
    validate: (v) => (v?.trim() ? undefined : "名称不能为空"),
  });
  if (cancelled(title)) return;
  const url = await p.text({
    message: "公告地址",
    initialValue: item.url,
    validate(v) {
      try {
        const u = new URL(v || "");
        if (!["http:", "https:"].includes(u.protocol))
          return "请输入 HTTP 或 HTTPS 地址";
      } catch {
        return "请输入有效地址";
      }
    },
  });
  if (cancelled(url)) return;
  store.updateQueue(item.competitionId, title, url);
  p.log.success("已修改；需重新审核。");
}
async function remove(store: Store, item?: Entry | null) {
  item = item || (await selectEntry(store, "选择要从队列移除的赛事"));
  if (!item) return;
  const confirmed = await p.confirm({
    message: `移除“${item.title}”？赛事档案和已有作品会保留。`,
    initialValue: false,
  });
  if (cancelled(confirmed) || !confirmed) return;
  store.deleteQueue(item.competitionId);
  p.log.success("已从队列移除。");
}
async function manual(store: Store) {
  const item = await selectEntry(store, "选择要人工确认的赛事");
  if (!item) return;
  const decision = await p.select({
    message: "设置审核结果",
    options: [
      { value: "valid", label: "通过", hint: "允许进入制作" },
      { value: "invalid", label: "无效", hint: "保留在队列，不处理" },
      { value: "needs_review", label: "待确认" },
    ],
  });
  if (cancelled(decision)) return;
  const reason = await p.text({
    message: "填写判断理由",
    validate: (v) => (v?.trim() ? undefined : "请填写理由"),
  });
  if (cancelled(reason)) return;
  store.setQueueReview(item.competitionId, {
    decision: decision as "valid" | "invalid" | "needs_review",
    reason: reason.trim(),
    reviewer: "manual",
  });
  p.log.success("人工审核结果已保存。");
}
const progressLog = (event: GatewayProgress) => {
  const detail = [
    event.taskId,
    event.round !== undefined
      ? `第 ${event.round}/${event.maxRounds ?? "?"} 轮`
      : null,
    event.elapsedSeconds !== undefined
      ? `已用 ${event.elapsedSeconds} 秒`
      : null,
    event.budget ? `预算 ${event.budget.used}/${event.budget.limit}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  p.log.step(
    `${agentLabels[event.agent]} / ${event.model}：${event.action}${detail ? " | " + detail : ""}`,
  );
  if (showRawResponses && event.raw !== undefined)
    p.note(
      event.raw.length > 12000
        ? event.raw.slice(0, 12000) + "\n…（已截断）"
        : event.raw,
      `${agentLabels[event.agent]} 原始返回`,
    );
};
async function review(cfg: AppConfig, store: Store) {
  const pending = store.queueStats().unreviewed;
  if (!pending) {
    p.log.info("没有未审核的等待赛事；可在详情查看结果或通过命令重新审核。");
    return;
  }
  if (!credentials(cfg).reviewer) {
    p.log.warn("缺少评审模型凭据。");
    return;
  }
  const count = await p.text({
    message: `审核多少场？当前待审核 ${pending} 场，每场最多一次模型调用`,
    defaultValue: String(Math.min(10, pending)),
    validate: (v) =>
      /^\d+$/.test(v || "") && Number(v) > 0 ? undefined : "请输入正整数",
  });
  if (cancelled(count)) return;
  const result = await screenQueue(
    cfg,
    store,
    new OfficialGateway(cfg, store, undefined, {}, progressLog),
    {
      limit: Number(count),
      onStart: (item) => p.log.step(`审核：${item.title}`),
      onError: (item, error) =>
        p.log.error(`审核失败：${item.title}\n${error}`),
      onResult: (_item, decision) =>
        p.log.info(`结果：${reviewLabels[decision] || decision}`),
    },
  );
  p.log.success(
    `已审核 ${result.length} 场；通过项已进入处理队列，无效项已移除。`,
  );
}
async function scan(cfg: AppConfig, store: Store) {
  const choice = await p.select({
    message: "选择发现方式",
    options: [
      { value: "search", label: "搜索赛事", hint: "搜索并加入待审核候选" },
      { value: "url", label: "导入公告", hint: "输入网页地址" },
    ],
  });
  if (cancelled(choice)) return;
  if (choice === "url") {
    const url = await p.text({
      message: "输入赛事公告地址",
      placeholder: "https://...",
      validate(value) {
        try {
          const u = new URL(value || "");
          if (!["http:", "https:"].includes(u.protocol))
            return "请输入 HTTP 或 HTTPS 地址";
        } catch {
          return "请输入有效的网址";
        }
      },
    });
    if (cancelled(url)) return;
    const spin = p.spinner();
    spin.start("读取公告");
    try {
      const doc = await fetchDocument(url);
      const id = store.addCompetition(normalizeUrl(url), doc.title);
      const added = store.addCandidate(id);
      spin.stop(added ? "已加入待审核候选" : "赛事已在队列中");
      p.note(
        `${doc.title}\n赛事 ID：${id}\n状态：待审核；审核通过后才会进入处理队列。`,
        "公告",
      );
    } catch (e) {
      spin.stop("读取失败");
      throw e;
    }
    return;
  }
  const term =
    cfg.search.provider === "sources"
      ? ""
      : await p.text({
          message: "搜索方向（留空则搜索多类赛事）",
          placeholder: "例如：大学生 设计大赛",
          defaultValue: "",
        });
  if (cancelled(term)) return;
  if (cfg.search.provider === "sources")
    p.log.info("当前仅扫描配置的高校来源列表，不支持全网关键词搜索。");
  const spin = p.spinner();
  spin.start("正在搜索赛事");
  try {
    const ids = await discoverCompetitions(
      store,
      new OfficialGateway(cfg, store),
      term.trim() || undefined,
      cfg.sources,
      cfg.search,
    );
    let added = 0;
    for (const id of ids) if (store.addCandidate(id)) added++;
    const sites = new Set(ids.map((id) => siteOf(store.competition(id).url)))
      .size;
    spin.stop(
      `发现 ${ids.length} 场（来自 ${sites} 个网站），新增 ${added} 个待审核候选`,
    );
    if (!ids.length)
      p.log.warn("没有找到赛事，请检查搜索配置或使用公告地址导入。");
  } catch (e) {
    spin.stop("搜索失败");
    throw e;
  }
}
async function recheck(cfg: AppConfig, store: Store) {
  const item = await selectEntry(store, "选择要重新审核的赛事");
  if (!item) return;
  if (!credentials(cfg).reviewer) {
    p.log.warn("缺少评审模型凭据。");
    return;
  }
  if (item.state !== "queued" && item.state !== "candidate") {
    p.log.warn("只能重新审核等待处理或待审核的赛事。");
    return;
  }
  const result = await screenQueue(
    cfg,
    store,
    new OfficialGateway(cfg, store, undefined, {}, progressLog),
    {
      id: item.competitionId,
      limit: 1,
      force: true,
      onStart: (x) => p.log.step(`审核：${x.title}`),
      onError: (_item, error) => p.log.error(`审核失败：${error}`),
    },
  );
  for (const r of result)
    p.note(
      `${reviewLabels[r.decision] || r.decision}：${r.reason}`,
      "审核结果",
    );
}
async function work(cfg: AppConfig, store: Store) {
  const count = store.queueStats();
  if (
    !count.queued &&
    !count.processing &&
    !count.candidate &&
    !count.unreviewed
  ) {
    p.log.info("没有等待处理的赛事。");
    return;
  }
  const auth = credentials(cfg);
  if (!auth.reviewer) {
    p.log.warn("缺少评审模型凭据。");
    return;
  }
  const limit = await p.text({
    message: "本次最多审核并处理多少场？",
    defaultValue: "3",
    validate(v) {
      if (!/^\d+$/.test(v || "") || Number(v) < 1) return "请输入正整数";
    },
  });
  if (cancelled(limit)) return;
  const budget = await p.text({
    message: "每场模型调用预算单位",
    defaultValue: String(cfg.maxCalls),
    validate(v) {
      if (!/^\d+$/.test(v || "") || Number(v) < 1) return "请输入正整数";
    },
  });
  if (cancelled(budget)) return;
  let reviewing: ReturnType<typeof p.spinner> | undefined;
  const reviewed = await screenQueue(
    cfg,
    store,
    new OfficialGateway(cfg, store, undefined, {}, progressLog),
    {
      limit: Number(limit),
      onStart: (item) => {
        reviewing = p.spinner();
        reviewing.start(`审核中：${item.title}（读取公告并核对截止时间）`);
      },
      onError: (item, error) =>
        p.log.error(`审核失败：${item.title}\n${error}`),
      onResult: (_item, decision) => {
        reviewing?.stop(`审核结果：${reviewLabels[decision] || decision}`);
        reviewing = undefined;
      },
    },
  );
  if (reviewing) {
    reviewing.stop("审核阶段结束");
    reviewing = undefined;
  }
  if (reviewed.length) p.log.info("仅审核通过的赛事进入制作。");
  if (!store.countQueueForReview()) {
    p.log.info("没有审核通过的待处理赛事；可继续审核或人工确认。");
    return;
  }
  if (!auth.writer) {
    p.log.warn("缺少写作模型凭据；审核结果已保存。");
    return;
  }
  p.log.info(
    "开始逐场处理；下面会显示当前 Agent、模型和动作，输出和检查点会保存到数据目录。",
  );
  let activeJob: string | undefined;
  const restore = taskKeys(store, () => activeJob);
  p.log.info("运行中按 P 暂停，S 停止；当前调用保存后生效。");
  let result;
  try {
    result = await processQueue(store, {
      limit: Number(limit),
      budget: Number(budget),
      onStart: (t) => {
        activeJob = t.jobId;
        p.log.step(
          `${t.resume ? "恢复" : "开始"}：${store.competition(t.competitionId).title}（${t.jobId}）`,
        );
      },
      onError: (_t, error) => p.log.error(error),
      run: (t) =>
        runAutomatic(
          cfg,
          store,
          new OfficialGateway(cfg, store, t.jobId, {}, progressLog),
          t.jobId,
          t.resume,
        ),
    });
  } finally {
    restore();
  }
  if (!result.length) {
    p.log.info("没有可领取的赛事。");
    return;
  }
  for (const item of result) {
    if (item.error) continue;
    const details = item.result as {
      gaps?: string[];
      outputs?: string[];
    } | null;
    p.log.success(
      `${store.competition(item.competitionId).title}：流程结束${details?.gaps?.length ? `，${details.gaps.length} 项待核实` : ""}`,
    );
    if (details?.outputs?.length)
      p.note(
        details.outputs.map((path) => `输出：${path}`).join("\n"),
        "输出路径",
      );
  }
  p.log.info("选择“查看赛事详情”可以查看产物和待核实项。");
}
async function retry(store: Store) {
  const failed = (store.queue() as Entry[]).filter((x) => x.state === "failed");
  if (!failed.length) {
    p.log.info("没有失败的赛事。");
    return;
  }
  const choice = await p.select({
    message: "选择要重试的赛事",
    options: [
      { value: "all", label: "全部失败赛事" },
      ...failed.map((x) => ({ value: x.competitionId, label: x.title })),
    ],
  });
  if (cancelled(choice)) return;
  const n = store.retryQueue(choice === "all" ? undefined : choice);
  p.log.success(`已重新排队 ${n} 场。`);
}
function doctor(cfg: AppConfig) {
  const a = credentials(cfg);
  agentTable(cfg);
  const browser = browserAvailability();
  p.log.info(
    browser.available ? "浏览器验收：可用" : "浏览器验收：" + browser.reason,
  );
  p.log.info(
    [
      `${cfg.search.provider === "sources" ? "高校来源列表（不支持全网搜索）" : `搜索（${cfg.search.provider}）`}：${yesno(a.search)}`,
      `数据目录：${cfg.dataDir}`,
      pc.dim("仅检查配置是否存在，真实可用性以调用结果为准。"),
    ].join("\n"),
  );
}

const runtimeState = (name: RuntimeName) => {
  const text = runtimeStateText(name);
  return runtimeReady(name) ? pc.green(text) : pc.yellow(text);
};
/** 用表格展示各 Agent；clack 的 note 边框按字符宽度计算，中文和“·”等符号在部分终端会错位。 */
function agentTable(cfg: AppConfig) {
  const rows = agentRows(cfg),
    width = process.stdout.columns || 100;
  if (width < 90) {
    for (const r of rows)
      console.log(
        "error" in r
          ? pc.red(`${r.label}：${r.error}`)
          : `${pc.bold(r.label)}  ${r.provider}/${r.model}${r.inherited ? pc.dim(" (沿用评审)") : ""}\n    ${r.runtime ? `${runtimes[r.runtime].label} ${runtimeState(r.runtime)} | ` : ""}密钥${yesno(!!r.keyConfigured)}${r.enabled ? "" : pc.dim(" | 已关闭")}`,
      );
  } else {
    const table = new Table({
      head: ["Agent", "供应商 / 模型", "运行时", "密钥", "状态"],
      style: { head: ["cyan"] },
      wordWrap: true,
    });
    for (const r of rows) {
      if ("error" in r) {
        table.push([r.label, { colSpan: 4, content: pc.red(r.error) }]);
        continue;
      }
      table.push([
        r.label,
        `${r.provider}/${r.model}${r.inherited ? pc.dim("\n沿用评审") : ""}`,
        r.runtime
          ? `${runtimes[r.runtime].label}\n${runtimeState(r.runtime)}`
          : pc.dim("不需要"),
        yesno(!!r.keyConfigured),
        r.enabled ? pc.green("启用") : pc.dim("已关闭"),
      ]);
    }
    console.log(table.toString());
  }
  for (const r of rows)
    if (!("error" in r) && r.runtime)
      p.log.info(
        `${r.label}：${r.timeoutSeconds} 秒；${r.runtime === "codex" ? "内部轮数由运行时管理" : `${r.maxTurns} ${r.runtime === "opencode" ? "步骤" : "轮"}`}${r.runtime === "claude-code" ? `；${r.maxBudgetUsd} 美元上限` : ""}`,
      );
  for (const x of modelProblems(cfg)) p.log.warn(x);
}
const providerHint = (x: Provider) =>
  `${protocolLabels[x.protocol]} | ${x.apiKeyEnv ? `${x.apiKeyEnv} ${hasKey(x) ? "已配置" : "未配置"}` : "无需密钥"}`;
const nonEmpty = (v: string | undefined) =>
  v?.trim() ? undefined : "不能为空";
async function askKey(provider: Provider) {
  if (!provider.apiKeyEnv) return;
  const key = await p.password({
    message: `输入 ${provider.apiKeyEnv}（保存到项目 .env，不写入配置文件）`,
    validate: nonEmpty,
  });
  if (cancelled(key)) return;
  saveEnvKey(provider.apiKeyEnv, key.trim());
  p.log.success(`${provider.apiKeyEnv} 已保存到 .env`);
}
async function installWithSpinner(name: RuntimeName, sdkOnly = false) {
  const r = runtimes[name];
  const spin = p.spinner();
  spin.start(
    `正在下载 ${r.label}${sdkOnly ? ` SDK（${r.sdkSize}）` : `（${r.size}）`}`,
  );
  try {
    await installRuntime(
      name,
      (line) => spin.message(`下载 ${r.label}：${line.slice(0, 60)}`),
      { sdkOnly },
    );
    spin.stop(`${r.label}：${runtimeStateText(name)}`);
  } catch (e) {
    spin.stop(`${r.label} 下载失败`);
    throw e;
  }
}
/** 本机已装 CLI 时只下载 SDK；否则下载完整版。 */
async function offerInstall(name: RuntimeName) {
  const s = runtimeStatus(name),
    r = runtimes[name];
  if (s.ready) return;
  const sdkOnly = s.mode === "needs-sdk";
  const ok = await p.confirm({
    message: sdkOnly
      ? `已找到本机 ${r.label} ${s.version ?? ""}，还需下载 SDK（${r.sdkSize}），现在下载？`
      : `${r.label} 未下载（${r.size}），现在下载？`,
    initialValue: true,
  });
  if (!cancelled(ok) && ok) await installWithSpinner(name, sdkOnly);
}

/** 配置单个 Agent：供应商、模型，以及研究和编码 Agent 的运行时。只列出与供应商协议兼容的运行时。 */
async function configureAgent(
  cfg: AppConfig,
  configPath?: string,
  requested?: AgentName,
): Promise<AppConfig> {
  const name =
    requested ||
    (await p.select({
      message: "选择要配置的 Agent",
      options: agentRows(cfg).map((r) => ({
        value: r.agent,
        label: r.label,
        hint:
          "error" in r
            ? r.error
            : `${r.provider}/${r.model}${r.runtime ? ` | ${runtimes[r.runtime].label}` : ""}`,
      })),
    }));
  if (cancelled(name)) return cfg;
  const current = resolveAgent(cfg, name),
    set = explicitAgents(cfg),
    own = { ...set[name] };
  const inheritable = inheritsReviewer(name);
  let providerId = await p.select({
    message: "选择供应商",
    initialValue:
      inheritable && current.inherited ? "__inherit" : current.provider.id,
    options: [
      ...(inheritable
        ? [
            {
              value: "__inherit",
              label: "沿用评审 Agent",
              hint: modelLabel(cfg, "reviewer"),
            },
          ]
        : []),
      ...providers(cfg)
        .filter((x) => name !== "image" || x.protocol !== "anthropic")
        .map((x) => ({ value: x.id, label: x.label, hint: providerHint(x) })),
      {
        value: "__custom",
        label: "新增自定义供应商",
        hint: "填写协议、Base URL、密钥变量名",
      },
    ],
  });
  if (cancelled(providerId)) return cfg;
  let providerList = cfg.providers;
  let selectedProvider: Provider | undefined;
  if (providerId === "__custom") {
    const custom = await providerForm(
      undefined,
      providers(cfg),
      name === "image" ? (["gemini", "openai"] as const) : protocols,
    );
    if (!custom) return cfg;
    selectedProvider = custom;
    providerId = custom.id;
    providerList = [...cfg.providers.filter((x) => x.id !== custom.id), custom];
  }
  if (providerId === "__inherit") {
    delete own.provider;
    delete own.model;
  } else {
    const model = await p.text({
      message: "模型名称",
      initialValue: current.provider.id === providerId ? current.model : "",
      placeholder: "例如 deepseek-chat、claude-sonnet-4-5、gemini-2.5-pro",
      validate: nonEmpty,
    });
    if (cancelled(model)) return cfg;
    own.provider = providerId;
    own.model = model.trim();
  }
  const provider =
    providerId === "__inherit"
      ? resolveAgent(cfg, "reviewer").provider
      : selectedProvider ||
        findProvider({ ...cfg, providers: providerList }, providerId)!;
  const options = agentRuntimes[name];
  if (options) {
    const usable = options.filter((r) =>
      runtimeProtocols[r].includes(provider.protocol),
    );
    if (!usable.length) {
      p.log.warn(
        `没有运行时支持 ${protocolLabels[provider.protocol]}；可选：${options.map((r) => `${runtimes[r].label}（${runtimeProtocols[r].join("/")}）`).join("、")}`,
      );
      return cfg;
    }
    const runtime = await p.select({
      message: "选择运行时",
      initialValue: usable.includes(current.runtime!)
        ? current.runtime
        : usable[0],
      options: usable.map((r) => ({
        value: r,
        label: `${runtimes[r].label}  ${runtimeState(r)}`,
        hint: `${runtimes[r].size} | ${runtimes[r].note}`,
      })),
    });
    if (cancelled(runtime)) return cfg;
    own.runtime = runtime;
    if (name === "research") {
      const enabled = await p.confirm({
        message: "启用研究 Agent？",
        initialValue: current.enabled,
      });
      if (cancelled(enabled)) return cfg;
      own.enabled = enabled;
    }
    if (runtime !== "codex") {
      const turns = await p.text({
        message:
          runtime === "opencode"
            ? "最多执行步骤（1-100）"
            : "最多运行轮数（1-100）",
        initialValue: String(current.maxTurns),
        validate: intIn(1, 100),
      });
      if (cancelled(turns)) return cfg;
      own.maxTurns = Number(turns);
    } else
      p.log.info(
        "Codex 内部轮数由运行时管理；本项目通过超时和预算控制每次执行，不提供虚假的轮数限制。",
      );
    const timeout = await p.text({
      message: "单次运行时执行最多秒数（30-3600）",
      initialValue: String(current.timeoutSeconds),
      validate: intIn(30, 3600),
    });
    if (cancelled(timeout)) return cfg;
    own.timeoutSeconds = Number(timeout);
    if (runtime === "claude-code") {
      const usd = await p.text({
        message: "Claude Code 单次执行美元预算上限",
        initialValue: String(current.maxBudgetUsd),
        validate: (v) =>
          Number.isFinite(Number(v)) && Number(v) > 0
            ? undefined
            : "请输入正数",
      });
      if (cancelled(usd)) return cfg;
      own.maxBudgetUsd = Number(usd);
    }
  }
  saveModels(configPath, providerList, { ...set, [name]: own });
  cfg = loadConfig(configPath);
  const saved = resolveAgent(cfg, name);
  p.log.success(
    `${agentLabels[name]} 已设为 ${saved.provider.label} / ${saved.model}${saved.runtime ? ` | ${runtimes[saved.runtime].label}` : ""}`,
  );
  if (saved.runtime && saved.enabled) await offerInstall(saved.runtime);
  if (!hasKey(saved.provider)) {
    const ok = await p.confirm({
      message: `${saved.provider.apiKeyEnv} 未配置，现在输入？`,
      initialValue: true,
    });
    if (!cancelled(ok) && ok) await askKey(saved.provider);
  }
  return cfg;
}

/** 管理供应商：内置供应商可修改地址和密钥变量，自定义供应商可增删。 */
async function providerMenu(
  cfg: AppConfig,
  configPath?: string,
): Promise<AppConfig> {
  while (true) {
    const list = providers(cfg);
    const choice = await p.select({
      message: "供应商",
      options: [
        ...list.map((x) => ({
          value: x.id,
          label: `${x.label} (${x.id})`,
          hint: `${x.baseURL || "官方地址"} | ${providerHint(x)}`,
        })),
        { value: "__add", label: "添加供应商" },
        { value: "__back", label: "返回" },
      ],
    });
    if (cancelled(choice) || choice === "__back") return cfg;
    try {
      const existing = list.find((x) => x.id === choice);
      const builtin = builtinProviders.some((x) => x.id === choice);
      if (existing) {
        const action = await p.select({
          message: existing.label,
          options: [
            { value: "key", label: "设置密钥" },
            { value: "edit", label: "修改协议和地址" },
            ...(builtin
              ? [{ value: "reset", label: "恢复内置设置" }]
              : [{ value: "delete", label: "删除" }]),
            { value: "back", label: "返回" },
          ],
        });
        if (cancelled(action) || action === "back") continue;
        if (action === "key") {
          await askKey(existing);
          continue;
        }
        const used = agents.filter((a) => {
          try {
            return resolveAgent(cfg, a).provider.id === existing.id;
          } catch {
            return false;
          }
        });
        if (action === "delete" || action === "reset") {
          if (action === "delete" && used.length) {
            p.log.warn(
              `仍有 Agent 在使用：${used.map((a) => agentLabels[a]).join("、")}`,
            );
            continue;
          }
          const ok = await p.confirm({
            message:
              action === "delete"
                ? `删除供应商 ${existing.label}？`
                : `恢复 ${existing.label} 的内置设置？`,
            initialValue: false,
          });
          if (cancelled(ok) || !ok) continue;
          saveModels(
            configPath,
            cfg.providers.filter((x) => x.id !== existing.id),
            explicitAgents(cfg),
          );
          cfg = loadConfig(configPath);
          p.log.success("已保存");
          continue;
        }
      }
      const next = await providerForm(existing, list);
      if (!next) continue;
      saveModels(
        configPath,
        [...cfg.providers.filter((x) => x.id !== next.id), next],
        explicitAgents(cfg),
      );
      cfg = loadConfig(configPath);
      p.log.success(`${next.label} 已保存`);
      if (!hasKey(next)) {
        const ok = await p.confirm({
          message: `现在输入 ${next.apiKeyEnv}？`,
          initialValue: true,
        });
        if (!cancelled(ok) && ok) await askKey(next);
      }
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
}
async function providerForm(
  existing: Provider | undefined,
  list: Provider[],
  allowedProtocols: readonly Protocol[] = protocols,
): Promise<Provider | null> {
  const id = existing
    ? existing.id
    : await p.text({
        message: "供应商 ID（小写字母、数字、- 和 _）",
        placeholder: "例如 siliconflow",
        validate: (v) =>
          !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(v || "")
            ? "格式不正确"
            : list.some((x) => x.id === v)
              ? "ID 已存在"
              : undefined,
      });
  if (cancelled(id)) return null;
  const label = await p.text({
    message: "显示名称",
    initialValue: existing?.label || "",
    validate: nonEmpty,
  });
  if (cancelled(label)) return null;
  const protocol = await p.select({
    message: "接口协议",
    initialValue: allowedProtocols.includes(
      existing?.protocol || ("openai" as Protocol),
    )
      ? existing?.protocol || allowedProtocols[0]!
      : allowedProtocols[0]!,
    options: allowedProtocols.map((x) => ({
      value: x,
      label: protocolLabels[x],
    })),
  });
  if (cancelled(protocol)) return null;
  const baseURL = await p.text({
    message: "Base URL（留空使用该协议官方地址）",
    initialValue: existing?.baseURL || "",
    defaultValue: "",
    placeholder:
      protocol === "openai"
        ? "https://api.example.com/v1"
        : protocol === "anthropic"
          ? "https://api.example.com/anthropic"
          : "",
    validate: (v) => (!v ? undefined : httpUrl(v)),
  });
  if (cancelled(baseURL)) return null;
  const apiKeyEnv = await p.text({
    message: "密钥环境变量名（留空表示无需密钥）",
    initialValue:
      existing?.apiKeyEnv ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    defaultValue: "",
    validate: (v) =>
      !v || /^[A-Z][A-Z0-9_]*$/.test(v)
        ? undefined
        : "只能用大写字母、数字和 _",
  });
  if (cancelled(apiKeyEnv)) return null;
  return {
    id,
    label: label.trim(),
    protocol,
    ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
    ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
  };
}

/** 运行时按需下载；列表中标注下载状态和使用它的 Agent。 */
async function runtimeMenu(cfg: AppConfig) {
  while (true) {
    const used = (r: RuntimeName) =>
      agents
        .filter((a) => {
          try {
            const x = resolveAgent(cfg, a);
            return x.runtime === r && x.enabled;
          } catch {
            return false;
          }
        })
        .map((a) => agentLabels[a]);
    const choice = await p.select({
      message: "Agent 运行时",
      options: [
        ...runtimeNames.map((r) => ({
          value: r,
          label: `${runtimes[r].label}  ${runtimeState(r)}`,
          hint: used(r).length ? `使用者：${used(r).join("、")}` : "未被使用",
        })),
        { value: "back", label: "返回" },
      ],
    });
    if (cancelled(choice) || choice === "back") return;
    try {
      const s = runtimeStatus(choice),
        r = runtimes[choice];
      const local = s.path ? `本机 ${s.version ?? ""}：${s.path}` : "";
      const actions = [
        ...(s.mode === "needs-sdk"
          ? [
              {
                value: "sdk",
                label: `下载 SDK，使用本机版本`,
                hint: r.sdkSize!,
              },
            ]
          : []),
        ...(s.mode !== "bundled"
          ? [
              {
                value: "full",
                label: "下载完整版",
                hint: `${r.size}，不依赖本机安装`,
              },
            ]
          : []),
        ...(isInstalled(choice)
          ? [
              {
                value: "remove",
                label:
                  s.mode === "bundled"
                    ? "删除已下载的完整版"
                    : "删除已下载的 SDK",
              },
            ]
          : []),
        { value: "back", label: "返回" },
      ];
      if (local) p.log.info(local);
      const action = await p.select({
        message: `${r.label}：${runtimeStateText(choice)}`,
        options: actions,
      });
      if (cancelled(action) || action === "back") continue;
      if (action === "sdk" || action === "full") {
        await installWithSpinner(choice, action === "sdk");
        continue;
      }
      const users = used(choice);
      const ok = await p.confirm({
        message: `删除 ${r.label} 的下载内容？${users.length ? `${users.join("、")}可能无法运行，` : ""}可以重新下载。`,
        initialValue: false,
      });
      if (!cancelled(ok) && ok) {
        removeRuntime(choice);
        p.log.success(`${r.label}：${runtimeStateText(choice)}`);
      }
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
}

/** 固定的六个角色都支持配置记录的新增、修改和删除；删除后恢复默认或沿用评审 Agent。 */
async function addAgent(
  cfg: AppConfig,
  configPath?: string,
): Promise<AppConfig> {
  const set = explicitAgents(cfg);
  const available = agents.filter(
    (name) => !Object.prototype.hasOwnProperty.call(set, name),
  );
  if (!available.length) {
    p.log.info("所有内置 Agent 都已有配置；可在“修改 Agent 配置”中调整。");
    return cfg;
  }
  const name = await p.select({
    message: "选择要新增配置的 Agent",
    options: available.map((name) => ({
      value: name,
      label: agentLabels[name],
      hint: "创建供应商、模型和运行时配置",
    })),
  });
  if (cancelled(name)) return cfg;
  return configureAgent(cfg, configPath, name);
}

async function deleteAgent(
  cfg: AppConfig,
  configPath?: string,
): Promise<AppConfig> {
  const set = explicitAgents(cfg);
  const configured = agents.filter((name) =>
    Object.prototype.hasOwnProperty.call(set, name),
  );
  if (!configured.length) {
    p.log.info("没有可删除的 Agent 配置。");
    return cfg;
  }
  const name = await p.select({
    message: "选择要删除配置的 Agent",
    options: configured.map((name) => ({
      value: name,
      label: agentLabels[name],
      hint: inheritsReviewer(name)
        ? "删除后沿用评审 Agent"
        : "删除后恢复内置默认",
    })),
  });
  if (cancelled(name)) return cfg;
  const ok = await p.confirm({
    message: `删除${agentLabels[name]}的自定义配置？${inheritsReviewer(name) ? "删除后将沿用评审 Agent。" : "删除后将恢复内置默认。"}`,
    initialValue: false,
  });
  if (cancelled(ok) || !ok) return cfg;
  delete set[name];
  saveModels(configPath, cfg.providers, set);
  cfg = loadConfig(configPath);
  p.log.success(`${agentLabels[name]}的自定义配置已删除。`);
  return cfg;
}

async function agentMenu(
  cfg: AppConfig,
  configPath?: string,
): Promise<AppConfig> {
  while (true) {
    agentTable(cfg);
    const choice = await p.select({
      message: "Agent 设置",
      options: [
        { value: "add", label: "新增 Agent 配置", hint: "为内置角色创建配置" },
        {
          value: "edit",
          label: "修改 Agent 配置",
          hint: "供应商、模型、运行时",
        },
        {
          value: "test",
          label: "测试 Agent 可用性",
          hint: "验证密钥、模型接口和运行时",
        },
        {
          value: "delete",
          label: "删除 Agent 配置",
          hint: "恢复默认或沿用评审 Agent",
        },
        { value: "providers", label: "供应商", hint: "供应商增删改、密钥" },
        {
          value: "runtimes",
          label: "运行时下载",
          hint: runtimeNames
            .map(
              (r) =>
                `${runtimes[r].label} ${runtimeReady(r) ? "可用" : "未下载"}`,
            )
            .join(" | "),
        },
        {
          value: "prompts",
          label: "系统提示词",
          hint: "查看和修改 Agent 提示词",
        },
        { value: "back", label: "返回" },
      ],
    });
    if (cancelled(choice) || choice === "back") return cfg;
    try {
      if (choice === "add") cfg = await addAgent(cfg, configPath);
      else if (choice === "edit") cfg = await configureAgent(cfg, configPath);
      else if (choice === "test") await testAgents(cfg);
      else if (choice === "delete") cfg = await deleteAgent(cfg, configPath);
      else if (choice === "providers")
        cfg = await providerMenu(cfg, configPath);
      else if (choice === "runtimes") await runtimeMenu(cfg);
      else cfg = await promptMenu(cfg, configPath);
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
}

async function testAgents(cfg: AppConfig) {
  const selected = await p.multiselect({
    message: "选择要测试的 Agent（空格选择）",
    options: agents.map((name) => {
      try {
        const a = resolveAgent(cfg, name);
        return {
          value: name,
          label: agentLabels[name],
          hint: `${a.provider.label} / ${a.model}${a.runtime ? ` / ${runtimes[a.runtime].label}` : ""}`,
        };
      } catch (e) {
        return { value: name, label: agentLabels[name], hint: "配置错误" };
      }
    }),
    required: true,
  });
  if (cancelled(selected)) return;
  const gateway = new OfficialGateway(cfg);
  for (const name of selected) {
    const spin = p.spinner();
    spin.start(`测试 ${agentLabels[name]}：${modelLabel(cfg, name)}`);
    try {
      const result = await gateway.testAgent(name);
      spin.stop(`${agentLabels[name]} 可用：${result.detail}`);
    } catch (e) {
      spin.stop(
        `${agentLabels[name]} 不可用：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** 只展示短预览；完整提示词只在编辑器文件中读写，避免终端一次重绘大文本。 */
function promptPreview(text: string) {
  const max = 800;
  const preview =
    text.length > max
      ? `${text.slice(0, max)}\n…（已省略 ${text.length - max} 个字符）`
      : text;
  return `${preview}\n\n提示词长度：${text.length} 个字符`;
}
/** 用系统编辑器编辑多行文本；关闭编辑器后读取结果，临时文件随即删除。 */
async function editInEditor(initial: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "compete-prompt-")),
    file = join(dir, "prompt.txt");
  try {
    writeFileSync(file, initial, "utf8");
    const editor =
      process.env.VISUAL ||
      process.env.EDITOR ||
      (process.platform === "win32" ? "notepad" : "vi");
    p.log.info(`已打开 ${editor}，关闭编辑器后继续。`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [file], {
        stdio: "inherit",
        shell:
          process.platform === "win32" &&
          !!(process.env.VISUAL || process.env.EDITOR),
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`编辑器 ${editor} 退出码 ${code}`)),
      );
    });
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function promptMenu(
  cfg: AppConfig,
  configPath?: string,
): Promise<AppConfig> {
  while (true) {
    const agent = await p.select({
      message: "选择要修改系统提示词的 Agent",
      options: [
        ...agents.map((a) => ({
          value: a,
          label: agentLabels[a],
          hint: isCustomPrompt(cfg, a) ? "自定义" : "默认",
        })),
        { value: "back", label: "返回" },
      ],
    });
    if (cancelled(agent) || agent === "back") return cfg;
    const current = promptOf(cfg, agent);
    p.note(
      promptPreview(current),
      `${agentLabels[agent]}（${isCustomPrompt(cfg, agent) ? "自定义" : "默认"}）`,
    );
    const action = await p.select({
      message: "操作",
      options: [
        {
          value: "editor",
          label: "在编辑器中修改",
          hint: "完整内容写入临时文件",
        },
        {
          value: "line",
          label: "直接输入",
          hint:
            current.length > 2000 ? "提示词过长，请使用编辑器" : "适合短提示词",
          disabled: current.length > 2000,
        },
        ...(isCustomPrompt(cfg, agent)
          ? [{ value: "reset", label: "恢复默认" }]
          : []),
        { value: "back", label: "返回" },
      ],
    });
    if (cancelled(action) || action === "back") continue;
    try {
      let text: string;
      if (action === "reset") {
        const ok = await p.confirm({
          message: "恢复为内置默认提示词？",
          initialValue: false,
        });
        if (cancelled(ok) || !ok) continue;
        text = "";
      } else if (action === "editor") {
        text = await editInEditor(current);
        if (!text.trim()) {
          p.log.warn("内容为空，未保存；如需恢复默认请选择“恢复默认”。");
          continue;
        }
      } else {
        const v = await p.text({
          message: "输入新的系统提示词",
          initialValue: current.length <= 2000 ? current : "",
          validate: (x) => (x?.trim() ? undefined : "不能为空"),
        });
        if (cancelled(v)) continue;
        text = v;
      }
      if (text.trim() === defaultPrompts[agent]) text = "";
      savePrompt(configPath, agent, text);
      cfg = loadConfig(configPath);
      p.log.success(
        text ? "已保存，下次调用该 Agent 时生效。" : "已恢复默认。",
      );
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
}

const providerLabels: Record<string, string> = {
  brave: "Brave Search API",
  searxng: "SearXNG",
  sources: "仅高校来源列表",
};
const rangeLabels: Record<string, string> = {
  any: "不限",
  day: "一天内",
  week: "一周内",
  month: "一个月内",
  year: "一年内",
};
const intIn = (min: number, max: number) => (v: string | undefined) =>
  /^\d+$/.test(v || "") && Number(v) >= min && Number(v) <= max
    ? undefined
    : `请输入 ${min}-${max} 的整数`;
const httpUrl = (v: string | undefined) => {
  try {
    const u = new URL(v || "");
    if (!["http:", "https:"].includes(u.protocol))
      return "请输入 HTTP 或 HTTPS 地址";
  } catch {
    return "请输入有效地址";
  }
};
export function searchSummary(cfg: AppConfig, store: Store) {
  const s = cfg.search,
    lines = [
      `搜索服务：${providerLabels[s.provider]}${s.url ? `（${s.url}）` : ""}`,
    ];
  if (s.provider !== "sources")
    lines.push(
      `每个搜索词翻 ${s.pages} 页 | 时间范围 ${rangeLabels[s.timeRange]} | 语言 ${s.language || "不限"}`,
      `每次发现 ${s.queriesPerRun} 个搜索词 | 每个网站每次最多新增 ${s.perHost} 场`,
      `搜索结果评估：${s.screen ? "开启（入队前由评审模型按批初筛标题和摘要）" : "关闭"}`,
      `自定义搜索词 ${s.queries.length} 个：${s.queries.join("；") || "无"}`,
      "下次将搜索：",
      ...plannedQueries(store, s).map((q) => `  ${q}`),
    );
  lines.push(
    `高校来源列表 ${cfg.sources.length} 个：`,
    ...cfg.sources.map((x) => `  ${x}`),
  );
  return lines.join("\n");
}
async function editList(
  message: string,
  items: string[],
  validate: (v: string | undefined) => string | undefined,
  placeholder: string,
) {
  const action = await p.select({
    message,
    options: [
      { value: "add", label: "添加" },
      ...(items.length ? [{ value: "remove", label: "删除" }] : []),
      { value: "back", label: "返回" },
    ],
  });
  if (cancelled(action) || action === "back") return null;
  if (action === "add") {
    const v = await p.text({ message: "输入内容", placeholder, validate });
    if (cancelled(v)) return null;
    return items.includes(v.trim()) ? items : [...items, v.trim()];
  }
  const picked = await p.multiselect({
    message: "选择要删除的项（空格选择）",
    options: items.map((x) => ({ value: x, label: x })),
    required: false,
  });
  if (cancelled(picked)) return null;
  return items.filter((x) => !picked.includes(x));
}
function siteStats(store: Store) {
  const counts = new Map<string, number>();
  for (const c of store.list() as { url: string }[]) {
    const site = siteOf(c.url);
    counts.set(site, (counts.get(site) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}
const screenCount = (raw: string) => {
  const x = JSON.parse(raw) as { checked: number; dropped: unknown[] };
  return `剔除 ${x.dropped.length}/${x.checked}`;
};
function history(store: Store) {
  const rows = (
    store.searches(null) as {
      query: string;
      results: string;
      searched_at: string;
      error: string | null;
    }[]
  )
    .slice(-20)
    .reverse();
  if (!rows.length) p.log.info("还没有发现记录。");
  else {
    const width = Math.min(process.stdout.columns || 100, 120);
    const table = new Table({
      head: ["时间", "搜索词 / 来源", "结果"],
      colWidths: [18, width - 42, 18],
      wordWrap: true,
    });
    for (const r of rows)
      table.push([
        r.searched_at.slice(5, 16).replace("T", " "),
        r.query,
        r.error
          ? pc.yellow(r.error.slice(0, 40))
          : r.query === SCREEN_RECORD
            ? screenCount(r.results)
            : String(JSON.parse(r.results).length),
      ]);
    console.log(table.toString());
    const last = rows.find((r) => r.query === SCREEN_RECORD && !r.error);
    const dropped: { title: string; reason: string }[] = last
      ? JSON.parse(last.results).dropped
      : [];
    if (dropped.length)
      p.note(
        dropped
          .slice(0, 15)
          .map((x) => `${x.title.slice(0, 40)}\n    ${pc.dim(x.reason)}`)
          .join("\n"),
        `最近一次评估剔除 ${dropped.length} 条`,
      );
  }
  const stats = siteStats(store);
  if (stats.length)
    p.note(
      stats
        .slice(0, 15)
        .map(([site, n]) => `${String(n).padStart(4)}  ${site}`)
        .join("\n"),
      `已收录赛事来自 ${stats.length} 个网站`,
    );
}
async function testSearch(cfg: AppConfig) {
  if (cfg.search.provider === "sources") {
    p.log.warn("当前为来源列表模式，没有全网搜索可测试。");
    return;
  }
  const q = await p.text({
    message: "测试搜索词",
    defaultValue: `${new Date().getFullYear()} 大学生 设计大赛 征集`,
    placeholder: `${new Date().getFullYear()} 大学生 设计大赛 征集`,
  });
  if (cancelled(q)) return;
  const spin = p.spinner();
  spin.start("正在搜索");
  try {
    const rs = await new OfficialGateway(cfg).search(q, {
      pages: cfg.search.pages,
      timeRange: cfg.search.timeRange,
    });
    const hits = rs.filter((r) => isCompetitionCandidate(r.title));
    spin.stop(
      `返回 ${rs.length} 条，${hits.length} 条像赛事公告，来自 ${new Set(rs.map((r) => siteOf(r.url))).size} 个网站`,
    );
    if (rs.length)
      p.note(
        rs
          .slice(0, 20)
          .map(
            (r) =>
              `${isCompetitionCandidate(r.title) ? pc.green("+") : pc.dim("-")} ${r.title}\n    ${pc.dim(siteOf(r.url))}`,
          )
          .join("\n"),
        "搜索结果（+ 会被收录）",
      );
  } catch (e) {
    spin.stop("搜索失败");
    throw e;
  }
}
async function searchMenu(
  cfg: AppConfig,
  store: Store,
  configPath?: string,
): Promise<AppConfig> {
  p.note(searchSummary(cfg, store), "搜索设置");
  while (true) {
    const choice = await p.select({
      message: "搜索设置",
      options: [
        {
          value: "provider",
          label: "切换搜索服务",
          hint: providerLabels[cfg.search.provider],
        },
        ...(cfg.search.provider === "sources"
          ? []
          : [
              {
                value: "params",
                label: "调整搜索参数",
                hint: "页数、时间范围、每站上限",
              },
              {
                value: "queries",
                label: "自定义搜索词",
                hint: `${cfg.search.queries.length} 个`,
              },
              { value: "test", label: "测试搜索" },
            ]),
        {
          value: "sources",
          label: "高校来源列表",
          hint: `${cfg.sources.length} 个`,
        },
        { value: "history", label: "最近发现记录" },
        { value: "view", label: "查看当前设置" },
        { value: "back", label: "返回" },
      ],
    });
    if (cancelled(choice) || choice === "back") return cfg;
    try {
      let search = { ...cfg.search },
        sources = [...cfg.sources];
      if (choice === "view") {
        p.note(searchSummary(cfg, store), "搜索设置");
        continue;
      }
      if (choice === "history") {
        history(store);
        continue;
      }
      if (choice === "test") {
        await testSearch(cfg);
        continue;
      }
      if (choice === "provider") {
        const provider = await p.select({
          message: "选择搜索服务",
          initialValue: search.provider,
          options: [
            {
              value: "searxng",
              label: "SearXNG",
              hint: "自建实例，需开启 JSON 输出",
            },
            {
              value: "brave",
              label: "Brave Search API",
              hint: "需要 BRAVE_SEARCH_API_KEY",
            },
            { value: "sources", label: "仅高校来源列表", hint: "不做全网搜索" },
          ],
        });
        if (cancelled(provider)) continue;
        search.provider = provider;
        if (provider === "searxng") {
          const url = await p.text({
            message: "SearXNG 地址",
            initialValue: search.url || "http://127.0.0.1:8080",
            validate: httpUrl,
          });
          if (cancelled(url)) continue;
          search.url = url.trim();
        } else if (provider === "brave") delete search.url;
      }
      if (choice === "params") {
        const pages = await p.text({
          message: "每个搜索词翻几页（1-5）",
          initialValue: String(search.pages),
          validate: intIn(1, 5),
        });
        if (cancelled(pages)) continue;
        const timeRange = await p.select({
          message: "赛事发现的时间范围",
          initialValue: search.timeRange,
          options: timeRanges.map((x) => ({
            value: x,
            label: rangeLabels[x]!,
          })),
        });
        if (cancelled(timeRange)) continue;
        const language = await p.text({
          message: "搜索语言（留空不限，SearXNG 有效）",
          initialValue: search.language,
          defaultValue: "",
        });
        if (cancelled(language)) continue;
        const perHost = await p.text({
          message: "每个网站每次最多新增几场（1-50）",
          initialValue: String(search.perHost),
          validate: intIn(1, 50),
        });
        if (cancelled(perHost)) continue;
        const perRun = await p.text({
          message: "每次发现使用几个搜索词（1-30）",
          initialValue: String(search.queriesPerRun),
          validate: intIn(1, 30),
        });
        if (cancelled(perRun)) continue;
        const screen = await p.confirm({
          message: "入队前用模型评估搜索结果？（约每 20 条一次调用）",
          initialValue: search.screen,
        });
        if (cancelled(screen)) continue;
        search = {
          ...search,
          screen,
          pages: Number(pages),
          timeRange,
          language: language.trim(),
          perHost: Number(perHost),
          queriesPerRun: Number(perRun),
        };
      }
      if (choice === "queries") {
        const next = await editList(
          "自定义搜索词每次发现都会使用",
          search.queries,
          (v) => (v?.trim() ? undefined : "不能为空"),
          "例如：2026 大学生 摄影大赛 征稿",
        );
        if (!next) continue;
        search.queries = next;
      }
      if (choice === "sources") {
        const next = await editList(
          "高校来源列表（赛事通知列表页）",
          sources,
          httpUrl,
          "https://某高校/竞赛通知列表",
        );
        if (!next) continue;
        sources = next;
      }
      saveSearchConfig(configPath, search, sources);
      cfg = loadConfig(configPath);
      p.log.success(
        `已保存到 ${configPath || process.env.COMPETE_CONFIG || "config/config.json"}`,
      );
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
}

export async function startUI(configPath?: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error("交互界面需要终端；脚本请使用 scan、queue、work 等命令");
  let cfg = loadConfig(configPath);
  const store = new Store(cfg.dataDir);
  try {
    p.intro(pc.bgCyan(pc.black(" 高校竞赛助手 ")));
    overview(cfg, store);
    while (true) {
      const choice = await p.select({
        message: "请选择操作",
        maxItems: menuPageSize(),
        options: [
          { value: "scan", label: "新增赛事", hint: "搜索或导入公告" },
          { value: "queue", label: "查看队列", hint: "查看、修改或移除赛事" },
          { value: "details", label: "查看赛事详情" },
          {
            value: "jobs",
            label: "任务进度与验收",
            hint: "轮次、作品、证据、规则和恢复记录",
          },
          { value: "review", label: "自动审核队列" },
          { value: "recheck", label: "重新审核一场赛事" },
          { value: "manual", label: "人工确认审核结果" },
          { value: "work", label: "处理队列", hint: "审核后逐场研究并制作" },
          { value: "retry", label: "重试失败赛事" },
          {
            value: "search",
            label: "搜索设置",
            hint: "搜索服务、搜索词、来源、发现记录",
          },
          {
            value: "agents",
            label: "Agent 设置",
            hint: "Agent 增删改、供应商、运行时下载、提示词",
          },
          {
            value: "execution",
            label: "长任务设置",
            hint: "预算、多轮制作、研究和超时",
          },
          {
            value: "profile",
            label: "用户资料",
            hint: "学校、姓名、学号等个人信息，自动填入作品",
          },
          {
            value: "logs",
            label: "运行日志显示",
            hint: "简洁进度或原始模型返回",
          },
          { value: "doctor", label: "查看配置状态" },
          { value: "exit", label: "退出" },
        ],
      });
      if (cancelled(choice) || choice === "exit") break;
      try {
        if (choice === "scan") await scan(cfg, store);
        else if (choice === "queue") await showQueue(cfg, store);
        else if (choice === "details") await details(cfg, store);
        else if (choice === "jobs") await inspectJob(cfg, store);
        else if (choice === "review") await review(cfg, store);
        else if (choice === "recheck") await recheck(cfg, store);
        else if (choice === "manual") await manual(store);
        else if (choice === "work") await work(cfg, store);
        else if (choice === "retry") await retry(store);
        else if (choice === "search")
          cfg = await searchMenu(cfg, store, configPath);
        else if (choice === "agents") cfg = await agentMenu(cfg, configPath);
        else if (choice === "execution")
          cfg = await executionMenu(cfg, configPath);
        else if (choice === "profile")
          cfg = await profileMenu(cfg, configPath);
        else if (choice === "logs") await logMenu();
        else if (choice === "doctor") doctor(cfg);
      } catch (e) {
        p.log.error(e instanceof Error ? e.message : String(e));
      }
    }
    p.outro("已退出。队列和任务保存在本地。");
  } finally {
    store.close();
  }
}
