#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { loadConfig, savePrompt, executionSettings } from "./core/config.js";
import {
  agents,
  agentLabels,
  isCustomPrompt,
  promptOf,
  type AgentName,
} from "./agents/prompts.js";
import {
  agentReady,
  hasKey,
  modelProblems,
  modelWarnings,
  resolveAgent,
  runtimeNames,
  runtimeProtocols,
  type RuntimeName,
} from "./agents/models.js";
import {
  installRuntime,
  installedVersion,
  isInstalled,
  removeRuntime,
  runtimeReady,
  runtimeStatus,
  runtimes,
} from "./agents/runtimes.js";
import { agentRows } from "./agents/agents.js";
import { Store } from "./core/store.js";
import { OfficialGateway } from "./core/gateway.js";
import { fetchDocument, normalizeUrl } from "./competition/sources.js";
import { runJob } from "./workflows/workflow.js";
import { runAutomatic } from "./workflows/autonomous.js";
import {
  discoverCompetitions,
  plannedQueries,
  siteOf,
  SCREEN_RECORD,
} from "./competition/discovery.js";
import { processQueue } from "./competition/queue.js";
import { startUI } from "./ui.js";
import { screenQueue } from "./competition/screening.js";
import { loadJobView } from "./core/job-view.js";
import {
  BrowserSuite,
  browserAvailability,
  inspectSoftware,
} from "./artifacts/browser-checks.js";
import { flushTracing, finishProcess } from "./core/tracing.js";

const program = new Command();
program
  .name("compete")
  .description("高校竞赛发现、研究和作品制作 CLI")
  .version("0.1.0")
  .option("-c, --config <path>", "配置文件路径");
program.action(() =>
  process.stdin.isTTY && process.stdout.isTTY
    ? startUI(program.opts().config)
    : program.outputHelp(),
);
program
  .command("ui")
  .description("打开交互式终端界面")
  .action(() => startUI(program.opts().config));
program
  .command("browser-check")
  .description("在隔离浏览器中检查实际 HTML/ZIP，不调用模型")
  .argument("<artifact>")
  .requiredOption("-o, --output <folder>", "截图和报告目录")
  .option("--suite <json>", "声明式关键操作用例")
  .action(async (path, opts) => {
    const suite = opts.suite
      ? BrowserSuite.parse(JSON.parse(readFileSync(opts.suite, "utf8")))
      : undefined;
    const report = await inspectSoftware(path, opts.output, suite);
    print(report);
    if (report.status === "failed") process.exitCode = 1;
  });
program
  .command("browser-status")
  .description("查看浏览器验收环境")
  .action(() => print(browserAvailability()));
function context() {
  const cfg = loadConfig(program.opts().config);
  const store = new Store(cfg.dataDir);
  return { cfg, store, gateway: new OfficialGateway(cfg, store) };
}
function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}
program
  .command("doctor")
  .description("检查模型和搜索配置")
  .action(() => {
    const { cfg, store } = context();
    try {
      const report = {
        dataDir: cfg.dataDir,
        agents: agentRows(cfg),
        problems: modelProblems(cfg),
        warnings: modelWarnings(cfg),
        quality: cfg.quality,
        credentials: {
          writer: agentReady(cfg, "writer"),
          reviewer: agentReady(cfg, "reviewer"),
          search:
            cfg.search.provider === "sources"
              ? cfg.sources.length > 0
              : cfg.search.provider === "brave"
                ? !!process.env.BRAVE_SEARCH_API_KEY
                : !!cfg.search.url,
        },
        search: cfg.search,
        sources: cfg.sources,
        nextQueries:
          cfg.search.provider === "sources"
            ? []
            : plannedQueries(store, cfg.search),
        searchScope:
          cfg.search.provider === "sources"
            ? "仅监测已配置来源，不支持全网关键词搜索"
            : "关键词搜索",
        note: "仅检查配置存在，不验证密钥、模型权限、网络或配额；不会输出密钥",
      };
      print(report);
      if (
        !report.credentials.writer ||
        !report.credentials.reviewer ||
        !report.credentials.search
      )
        process.exitCode = 1;
    } finally {
      store.close();
    }
  });
program
  .command("scan")
  .description("发现或导入公开赛事公告")
  .option("-q, --query <query>", "搜索关键词")
  .option("-u, --url <url>", "导入赛事公告 URL")
  .action(async (opts) => {
    const { cfg, store, gateway } = context();
    try {
      if (opts.url) {
        const d = await fetchDocument(opts.url);
        const id = store.addCompetition(normalizeUrl(opts.url), d.title);
        const enqueued = store.enqueue(id);
        print({ id, title: d.title, url: normalizeUrl(opts.url), enqueued });
        return;
      }
      if (opts.query && cfg.search.provider === "sources")
        throw Error(
          "当前仅监测来源列表，不支持关键词搜索；请配置 Brave 或 SearXNG",
        );
      if (cfg.search.provider === "sources")
        console.error("当前仅扫描配置的高校来源列表，不支持全网关键词搜索。");
      const started = new Date().toISOString();
      const ids = await discoverCompetitions(
        store,
        gateway,
        opts.query,
        cfg.sources,
        cfg.search,
      );
      let enqueued = 0;
      const found = ids.map((id) => {
        const c = store.competition(id);
        if (store.enqueue(id)) enqueued++;
        return { id, title: c.title, url: c.url };
      });
      const screen = (
        store.searches(null) as {
          query: string;
          results: string;
          searched_at: string;
          error: string | null;
        }[]
      )
        .filter((x) => x.query === SCREEN_RECORD && x.searched_at >= started)
        .at(-1);
      print({
        found,
        enqueued,
        sites: new Set(found.map((x) => siteOf(x.url))).size,
        screening: screen
          ? { ...JSON.parse(screen.results), error: screen.error }
          : null,
      });
      if (!found.length) {
        console.error(
          "没有找到结果；检查搜索服务，或使用 scan --url 导入官方公告。",
        );
        process.exitCode = 1;
      }
    } finally {
      store.close();
    }
  });
const runtimeArg = (name: string) => {
  if (!(runtimeNames as readonly string[]).includes(name))
    throw Error(`运行时必须为 ${runtimeNames.join("、")}`);
  return name as RuntimeName;
};
program
  .command("agents")
  .description("查看各 Agent 使用的供应商、模型和运行时")
  .action(() => {
    const cfg = loadConfig(program.opts().config);
    print({
      agents: agentRows(cfg),
      problems: modelProblems(cfg),
      warnings: modelWarnings(cfg),
    });
  });
program
  .command("agents-test")
  .description("实际测试 Agent 配置、密钥和运行时")
  .argument("[agent]", `指定 Agent；不指定则测试全部：${agents.join("、")}`)
  .action(async (name) => {
    const cfg = loadConfig(program.opts().config);
    const gateway = new OfficialGateway(cfg);
    const names = name ? [agentArg(name)] : agents;
    const results = [];
    for (const agent of names) {
      try {
        results.push({ ok: true, ...(await gateway.testAgent(agent)) });
      } catch (e) {
        results.push({
          ok: false,
          agent,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    print(results);
    if (results.some((x) => !x.ok)) process.exitCode = 1;
  });
program
  .command("runtimes")
  .description("查看可选 Agent 运行时及下载状态")
  .action(() => {
    print(
      runtimeNames.map((name) => ({
        name,
        label: runtimes[name].label,
        package: `${runtimes[name].pkg}@${runtimes[name].version}`,
        size: runtimes[name].size,
        ...runtimeStatus(name),
        sdkDownloaded: isInstalled(name),
        protocols: runtimeProtocols[name],
      })),
    );
  });
// 下载运行时不读取配置，便于在 Docker 构建阶段执行。
program
  .command("runtime-install")
  .description("下载 Agent 运行时（Claude Code、Codex、OpenCode）")
  .argument("<name>", runtimeNames.join("、"))
  .option("--full", "下载完整版，即使本机已安装该 CLI")
  .action(async (name, opts) => {
    const r = runtimeArg(name);
    const status = runtimeStatus(r);
    const sdkOnly = !opts.full && status.mode === "needs-sdk";
    if (status.mode === "bundled" || (!opts.full && status.ready)) {
      print({ runtime: r, ...status, note: "无需下载" });
      return;
    }
    console.error(
      `正在下载 ${runtimes[r].label}${sdkOnly ? ` SDK（${runtimes[r].sdkSize}，使用本机 ${status.version ?? ""}）` : `（${runtimes[r].size}）`}…`,
    );
    await installRuntime(r, undefined, { sdkOnly });
    print({ runtime: r, ...runtimeStatus(r), sdkVersion: installedVersion(r) });
  });
program
  .command("runtime-remove")
  .description("删除已下载的 Agent 运行时")
  .argument("<name>", runtimeNames.join("、"))
  .action((name) => {
    const r = runtimeArg(name);
    removeRuntime(r);
    print({ runtime: r, installed: false });
  });
const agentArg = (name: string) => {
  if (!(agents as readonly string[]).includes(name))
    throw Error(`Agent 必须为 ${agents.join("、")}`);
  return name as AgentName;
};
program
  .command("prompts")
  .description("查看各 Agent 的系统提示词")
  .argument("[agent]", agents.join("、"))
  .action((name) => {
    const cfg = loadConfig(program.opts().config);
    print(
      (name ? [agentArg(name)] : agents).map((a) => ({
        agent: a,
        label: agentLabels[a],
        custom: isCustomPrompt(cfg, a),
        prompt: promptOf(cfg, a),
      })),
    );
  });
program
  .command("prompt-set")
  .description("修改 Agent 的系统提示词")
  .argument("<agent>", agents.join("、"))
  .option("--text <text>", "新的提示词")
  .option("--file <path>", "从文本文件读取提示词")
  .action((name, opts) => {
    const agent = agentArg(name);
    if (!!opts.text === !!opts.file)
      throw Error("请指定 --text 或 --file 其中之一");
    const text = opts.text ?? readFileSync(opts.file, "utf8");
    if (!text.trim()) throw Error("提示词不能为空；恢复默认请用 prompt-reset");
    savePrompt(program.opts().config, agent, text);
    print({ agent, custom: true });
  });
program
  .command("prompt-reset")
  .description("恢复 Agent 的默认系统提示词")
  .argument("<agent>", agents.join("、"))
  .action((name) => {
    const agent = agentArg(name);
    savePrompt(program.opts().config, agent, "");
    print({ agent, custom: false });
  });
program
  .command("list")
  .description("列出已发现赛事")
  .action(() => {
    const { store } = context();
    try {
      print(store.list());
    } finally {
      store.close();
    }
  });
program
  .command("show")
  .description("查看赛事、规则、证据及检索日志")
  .argument("<competition-id>")
  .action((id) => {
    const { store } = context();
    try {
      print({
        competition: store.competition(id),
        evidence: store
          .evidence(id)
          .map(({ text, ...x }) => ({ ...x, excerpt: text.slice(0, 500) })),
        searches: store.searches(id),
      });
    } finally {
      store.close();
    }
  });
program
  .command("research")
  .description("研究赛事规则与往届公开作品")
  .argument("<competition-id>")
  .option("--budget <calls>", "最多模型调用次数", Number)
  .action(async (id, opts) => {
    const { cfg, store } = context();
    try {
      store.competition(id);
      const job = store.createJob(
        id,
        "research",
        {},
        opts.budget ?? cfg.maxCalls,
      );
      console.log(`任务 ID: ${job}`);
      const result = await runJob(
        cfg,
        store,
        new OfficialGateway(cfg, store, job),
        job,
      );
      print({ jobId: job, outputPath: result.outputPath });
    } finally {
      store.close();
    }
  });
program
  .command("produce")
  .description("制作翻译或报告作品")
  .argument("<competition-id>")
  .option(
    "--type <type>",
    "作品类型：translation、report；唯一可识别时自动选择",
  )
  .requiredOption("--source <path>", "原文或材料文件路径")
  .option("--target <language>", "翻译目标语言")
  .option("--instructions <text>", "报告撰写要求")
  .requiredOption("--format <format>", "输出格式：txt、md、docx")
  .option("--budget <calls>", "最多模型调用次数", Number)
  .action(async (id, opts) => {
    const { cfg, store } = context();
    try {
      const c = store.competition(id);
      if (!c.brief) throw Error("请先执行 research，核对比赛交付要求");
      const types = new Set<string>();
      for (const d of c.brief.deliverables) {
        if (/translation|翻译|译文|译稿/i.test(d.type))
          types.add("translation");
        if (
          /report|document|proposal|报告|文档|文稿|方案书|申报书/i.test(d.type)
        )
          types.add("report");
      }
      const type = opts.type || (types.size === 1 ? [...types][0] : null);
      if (!type)
        throw Error(
          "无法唯一确定已支持的交付类型，请使用 --type 指定；不支持的类型请人工处理",
        );
      if (!["translation", "report"].includes(type))
        throw Error(`暂不支持作品类型：${type}；赛事档案已保留`);
      const job = store.createJob(
        id,
        type,
        {
          sourcePath: opts.source,
          targetLanguage: opts.target || "",
          instructions: opts.instructions || "",
          format: opts.format.toLowerCase(),
        },
        opts.budget ?? cfg.maxCalls,
      );
      console.log(`任务 ID: ${job}`);
      const result = await runJob(
        cfg,
        store,
        new OfficialGateway(cfg, store, job),
        job,
      );
      print({ jobId: job, outputPath: result.outputPath });
    } finally {
      store.close();
    }
  });
program
  .command("status")
  .description("查看任务、当前轮次、交付验收与证据记录")
  .argument("<job-id>")
  .action(async (id) => {
    const { cfg, store } = context();
    try {
      print({
        job: store.job(id),
        control: store.jobControl(id) || null,
        view: await loadJobView(cfg.dataDir, id),
        artifacts: store.artifacts(id),
      });
    } finally {
      store.close();
    }
  });
program
  .command("execution")
  .description("查看长任务默认预算、轮次与超时设置")
  .action(() => {
    const cfg = loadConfig(program.opts().config);
    const settings = executionSettings(cfg);
    print({
      maxCalls: cfg.maxCalls,
      execution: settings,
      requestBudgetSeconds:
        settings.requestTimeoutSeconds * settings.requestAttempts,
      runtimes: ["research", "coder"].map((name) => {
        const agent = resolveAgent(cfg, name as AgentName);
        return {
          agent: name,
          runtime: agent.runtime,
          maxTurns: agent.runtime === "codex" ? null : agent.maxTurns,
          timeoutSeconds: agent.timeoutSeconds,
          maxBudgetUsd:
            agent.runtime === "claude-code" ? agent.maxBudgetUsd : null,
        };
      }),
    });
  });
program
  .command("queue")
  .description("查看持久化赛事处理队列")
  .action(() => {
    const { store } = context();
    try {
      print(store.queue());
    } finally {
      store.close();
    }
  });
program
  .command("queue-history")
  .description("查看赛事的审核历史")
  .argument("<competition-id>")
  .action((id) => {
    const { store } = context();
    try {
      store.competition(id);
      print(store.queueReviewHistory(id));
    } finally {
      store.close();
    }
  });
program
  .command("materials")
  .description(
    "导入你提供的资料（照片说明、实测数据、调研、个人信息等），下次生成时替换作品中的【待补充】",
  )
  .argument("<competition-id>")
  .argument("<files...>", "txt、md、docx 或 pdf 文件")
  .action(async (id: string, files: string[]) => {
    const { store } = context();
    try {
      store.competition(id);
      const { readSource } = await import("./competition/sources.js");
      const { randomUUID } = await import("node:crypto");
      const { resolve, basename } = await import("node:path");
      const { pathToFileURL } = await import("node:url");
      const imported = [];
      for (const file of files) {
        const path = resolve(file);
        const text = (await readSource(path)).trim();
        if (!text) throw Error(`${file} 没有可读取的文字`);
        // 以文件地址作为来源 URL，同一文件重复导入时覆盖旧内容。
        store.putEvidence({
          id: randomUUID(),
          competitionId: id,
          url: pathToFileURL(path).href,
          title: `用户提供的资料：${basename(path)}`,
          text,
          fetchedAt: new Date().toISOString(),
          kind: "user",
        });
        imported.push({ file: path, chars: text.length });
      }
      print({
        imported,
        next: `资料已导入。运行 compete enqueue ${id} --redo 后 compete work，作品会用这些资料重新生成。`,
      });
    } finally {
      store.close();
    }
  });
program
  .command("queue-add")
  .description("手动添加公告到队列")
  .argument("<url>")
  .option("--title <title>", "手动指定名称；不指定时读取公告")
  .action(async (url, opts) => {
    const { store } = context();
    try {
      const link = normalizeUrl(url);
      const title = opts.title?.trim() || (await fetchDocument(link)).title;
      if (!title) throw Error("赛事名称不能为空");
      const id = store.addCompetition(link, title);
      print({ competitionId: id, enqueued: store.enqueue(id) });
    } finally {
      store.close();
    }
  });
program
  .command("queue-edit")
  .description("修改队列中的赛事名称或公告地址")
  .argument("<competition-id>")
  .option("--title <title>", "新名称")
  .option("--url <url>", "新公告地址")
  .action((id, opts) => {
    const { store } = context();
    try {
      if (opts.title === undefined && opts.url === undefined)
        throw Error("请指定 --title 或 --url");
      const c = store.competition(id);
      store.updateQueue(id, opts.title ?? c.title, opts.url ?? c.url);
      print({ competitionId: id, reviewStatus: "unreviewed" });
    } finally {
      store.close();
    }
  });
program
  .command("queue-delete")
  .description("从队列移除赛事，保留赛事档案和任务产物")
  .argument("<competition-id>")
  .action((id) => {
    const { store } = context();
    try {
      store.deleteQueue(id);
      print({ competitionId: id, removed: true });
    } finally {
      store.close();
    }
  });
program
  .command("queue-review")
  .description("用评审模型审核队列，保留原文依据")
  .argument("[competition-id]")
  .option("--limit <number>", "最多审核条数", Number, 10)
  .option("--force", "重新审核已有结果")
  .action(async (id, opts) => {
    const { cfg, store, gateway } = context();
    try {
      const results = await screenQueue(cfg, store, gateway, {
        id,
        limit: opts.limit,
        force: !!opts.force,
        onStart: (item) => console.error(`审核：${item.title}`),
        onError: (item, error) =>
          console.error(`审核失败：${item.title}\n${error}`),
      });
      print({ results });
    } finally {
      store.close();
    }
  });
program
  .command("queue-decision")
  .description("人工设置审核结果")
  .argument("<competition-id>")
  .argument("<decision>", "valid、invalid 或 needs_review")
  .requiredOption("--reason <reason>", "人工判断理由")
  .action((id, decision, opts) => {
    const { store } = context();
    try {
      if (!["valid", "invalid", "needs_review"].includes(decision))
        throw Error("审核结果必须为 valid、invalid 或 needs_review");
      if (!opts.reason.trim()) throw Error("请填写判断理由");
      store.setQueueReview(id, {
        decision,
        reason: opts.reason.trim(),
        reviewer: "manual",
      });
      print({ competitionId: id, decision });
    } finally {
      store.close();
    }
  });
program
  .command("enqueue")
  .description("将已有赛事加入队列")
  .argument("[competition-id]")
  .option("--all", "加入所有已发现赛事")
  .option("--redo", "重新加入已完成或失败的赛事")
  .action((id, opts) => {
    const { store } = context();
    try {
      if (!id && !opts.all) throw Error("请指定赛事 ID 或 --all");
      if (id && opts.all) throw Error("赛事 ID 和 --all 不能同时使用");
      const ids = id ? [id] : store.list().map((x) => x.id as string);
      let enqueued = 0;
      for (const item of ids) if (store.enqueue(item, !!opts.redo)) enqueued++;
      print({ enqueued });
    } finally {
      store.close();
    }
  });
program
  .command("retry")
  .description("将失败的队列项重新加入等待队列")
  .argument("[competition-id]", "不指定时重试所有失败项")
  .action((id) => {
    const { store } = context();
    try {
      print({ requeued: store.retryQueue(id) });
    } finally {
      store.close();
    }
  });
async function workQueue(
  cfg: ReturnType<typeof loadConfig>,
  store: Store,
  opts: { limit: number; budget: number },
) {
  if (
    !Number.isInteger(opts.limit) ||
    opts.limit < 1 ||
    !Number.isInteger(opts.budget) ||
    opts.budget < 1
  )
    throw Error("limit 和 budget 必须为正整数");
  if (
    !store
      .queue()
      .some((x: any) => x.state === "queued" || x.state === "processing")
  )
    return [];
  const reviewer = resolveAgent(cfg, "reviewer");
  if (!hasKey(reviewer.provider))
    throw Error(
      `赛事队列已保存，但模型不可用：请配置 ${reviewer.provider.apiKeyEnv}`,
    );
  const progress = (e: {
    agent: string;
    model: string;
    provider: string;
    action: string;
    raw?: string;
    round?: number;
    maxRounds?: number;
    elapsedSeconds?: number;
    budget?: { used: number; limit: number };
  }) => {
    console.error(
      `[工作中] ${e.agent} Agent / ${e.provider} / ${e.model}：${e.action}${e.round ? ` | 第 ${e.round}/${e.maxRounds} 轮` : ""}${e.elapsedSeconds !== undefined ? ` | 已用 ${e.elapsedSeconds} 秒` : ""}${e.budget ? ` | 预算 ${e.budget.used}/${e.budget.limit}` : ""}`,
    );
    if (process.env.COMPETE_VERBOSE === "1" && e.raw !== undefined)
      console.error(
        `[${e.agent} Agent 原始返回]\n${e.raw.length > 30000 ? `${e.raw.slice(0, 30000)}\n…（返回过长，已截断；完整长度 ${e.raw.length} 字符）` : e.raw}\n[原始返回结束]`,
      );
  };
  const reviewed = await screenQueue(
    cfg,
    store,
    new OfficialGateway(cfg, store, undefined, {}, progress),
    {
      limit: opts.limit,
      onStart: (item) => console.log(`审核：${item.title}`),
    },
  );
  if (reviewed.length)
    console.log(
      `本次审核 ${reviewed.length} 场，只有审核通过的赛事会进入制作；其他结果可在队列查看。`,
    );
  if (
    !store
      .queue()
      .some((x: any) => x.state === "queued" && x.reviewStatus === "valid")
  ) {
    console.log("没有审核通过的待处理赛事；可继续审核或人工确认。");
    return [];
  }
  const writer = resolveAgent(cfg, "writer");
  if (!hasKey(writer.provider))
    throw Error(
      `赛事队列已保存，但模型不可用：请配置 ${writer.provider.apiKeyEnv}`,
    );
  return processQueue(store, {
    limit: opts.limit,
    budget: opts.budget,
    onStart: (task) =>
      console.log(
        `${task.resume ? "恢复" : "开始"} ${store.competition(task.competitionId).title}；任务 ${task.jobId}`,
      ),
    onError: (task, error) =>
      console.error(`任务 ${task.jobId} 未完成：${error}`),
    run: (task) =>
      runAutomatic(
        cfg,
        store,
        new OfficialGateway(cfg, store, task.jobId, {}, progress),
        task.jobId,
        task.resume,
      ),
  });
}
program
  .command("work")
  .description("按顺序处理已持久化的赛事队列")
  .option("--limit <number>", "本次最多处理的赛事数", Number, 3)
  .option("--budget <calls>", "每场赛事预算单位（默认使用长任务设置）", Number)
  .option("--interactive-gates", "在选题确认与素材注入节点启用 30 秒人机协同确认")
  .action(async (opts) => {
    const { cfg, store } = context();
    try {
      if (opts.interactiveGates) cfg.quality.interactiveGates = true;
      opts.budget ??= cfg.maxCalls;
      const processed = await workQueue(cfg, store, opts);
      print({ processed });
      if (processed.some((x) => x.error)) process.exitCode = 1;
    } finally {
      store.close();
    }
  });
program
  .command("pause")
  .description("在当前调用保存后的安全边界暂停任务")
  .argument("<job-id>")
  .action((id) => {
    const { store } = context();
    try {
      print(store.requestJobControl(id, "pause"));
    } finally {
      store.close();
    }
  });
program
  .command("stop")
  .description("停止任务并保留已有产物；继续制作需创建新任务")
  .argument("<job-id>")
  .action((id) => {
    const { store } = context();
    try {
      print(store.requestJobControl(id, "stop"));
    } finally {
      store.close();
    }
  });
program
  .command("budget")
  .description("调整任务总预算，不清零已消耗量")
  .argument("<job-id>")
  .argument("<total>", "总预算单位", Number)
  .action((id, total) => {
    const { store } = context();
    try {
      store.setBudget(id, total);
      print(store.job(id));
    } finally {
      store.close();
    }
  });
program
  .command("resume")
  .description("继续暂停或失败任务；队列任务重新排队")
  .argument("<job-id>")
  .option("--budget <calls>", "调整预算总上限", Number)
  .option("--interactive-gates", "在选题确认与素材注入节点启用人机协同确认")
  .action(async (id, opts) => {
    const { cfg, store } = context();
    try {
      if (opts.interactiveGates) cfg.quality.interactiveGates = true;
      const job = store.job(id);
      if (opts.budget !== undefined) store.setBudget(id, opts.budget);
      const next = store.resumeJob(id);
      if (next.queued) {
        print({
          jobId: id,
          state: "queued",
          note: "已重新排队，运行 work 继续；仍需通过赛事审核",
        });
        return;
      }
      const gateway = new OfficialGateway(cfg, store, id);
      const result =
        job.kind === "automatic"
          ? await runAutomatic(cfg, store, gateway, id, next.resume)
          : await runJob(cfg, store, gateway, id, next.resume);
      print({ jobId: id, result });
    } finally {
      store.close();
    }
  });
program
  .command("auto")
  .description("自动发现赛事、追查往届作品、比较方案并制作可支持的交付物")
  .option("-q, --query <query>", "限定搜索方向；不指定时覆盖多种赛事")
  .option("-u, --url <url>", "直接处理指定公告；不指定时自动发现")
  .option("--limit <number>", "本次最多处理的赛事数", Number, 3)
  .option("--budget <calls>", "每场赛事预算单位（默认使用长任务设置）", Number)
  .option("--redo", "重新处理已完成的赛事")
  .option("--interactive-gates", "在选题确认与素材注入节点启用 30 秒人机协同确认")
  .action(async (opts) => {
    const { cfg, store } = context();
    try {
      if (opts.interactiveGates) cfg.quality.interactiveGates = true;
      opts.budget ??= cfg.maxCalls;
      if (opts.query && cfg.search.provider === "sources" && !opts.url)
        throw Error(
          "当前仅监测来源列表，不支持关键词搜索；请配置 Brave 或 SearXNG",
        );
      if (cfg.search.provider === "sources" && !opts.url)
        console.error("当前仅扫描配置的高校来源列表，不支持全网关键词搜索。");
      if (
        !Number.isInteger(opts.limit) ||
        opts.limit < 1 ||
        !Number.isInteger(opts.budget) ||
        opts.budget < 1
      )
        throw Error("limit 和 budget 必须为正整数");
      const discoveryGateway = new OfficialGateway(cfg, store);
      let ids: string[];
      if (opts.url) {
        const page = await fetchDocument(opts.url);
        ids = [store.addCompetition(normalizeUrl(opts.url), page.title)];
      } else
        ids = await discoverCompetitions(
          store,
          discoveryGateway,
          opts.query,
          cfg.sources,
          cfg.search,
        );
      let added = 0;
      for (const id of ids) if (store.enqueue(id, !!opts.redo)) added++;
      const queued = store
        .queue()
        .filter(
          (x: any) => x.state === "queued" || x.state === "processing",
        ).length;
      console.log(
        `发现 ${ids.length} 个赛事候选，新入队 ${added} 个；队列中 ${queued} 个等待或正在处理，本次最多处理 ${opts.limit} 个。候选并不保证仍可报名。`,
      );
      if (!queued) {
        print({
          discovered: ids.length,
          enqueued: added,
          processed: [],
          note: ids.length
            ? "已处理过所有候选；使用 --redo 可重新处理"
            : "未发现赛事；请检查搜索服务或稍后重试",
        });
        if (!ids.length) process.exitCode = 1;
        return;
      }
      const results = await workQueue(cfg, store, opts);
      print({ discovered: ids.length, enqueued: added, processed: results });
      if (results.some((x) => x.error)) process.exitCode = 1;
    } finally {
      store.close();
    }
  });
// 命令结束后主动收尾：追踪上报限量，随后按退出码结束进程。
// 只靠事件循环自然退出时，模型接口或上报的超时连接会继续占着 socket，看起来就是命令已经做完却卡住。
program
  .parseAsync()
  .catch((e) => {
    console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .then(() => finishProcess(Number(process.exitCode ?? 0)));
