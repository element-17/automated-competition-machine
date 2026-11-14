import { Guard, budgetError } from "./shared.js";
import {
  assertJobCanRun,
  beginJobRun,
  controlledGateway,
  isJobControlError,
} from "../core/job-control.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { join, extname, basename } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Document, Packer, Paragraph } from "docx";
import { Brief, type ModelGateway } from "../core/types.js";
import type { Store } from "../core/store.js";
import { executionSettings, type AppConfig } from "../core/config.js";
import { saveJobProgress } from "../core/job-progress.js";
import { parseJSON } from "../core/gateway.js";
import { modelLabel, resolveAgent } from "../agents/models.js";
import {
  fetchDocument,
  readSource,
  saveSource,
  saveSourceBestEffort,
  searchLogged,
} from "../competition/sources.js";

const State = Annotation.Root({
  jobId: Annotation<string>,
  competitionId: Annotation<string>,
  sourcePath: Annotation<string>,
  targetLanguage: Annotation<string>,
  instructions: Annotation<string>,
  format: Annotation<string>,
  draft: Annotation<string>,
  finalText: Annotation<string>,
  report: Annotation<string>,
  outputPath: Annotation<string>,
});
type S = typeof State.State;
function dir(cfg: AppConfig, id: string) {
  return join(cfg.dataDir, "jobs", id);
}
async function save(
  cfg: AppConfig,
  store: Store,
  id: string,
  name: string,
  content: string,
  kind: string,
  model: string | null,
) {
  await mkdir(dir(cfg, id), { recursive: true });
  const p = join(dir(cfg, id), name);
  await writeFile(p, content, "utf8");
  store.artifact(id, kind, p, model);
  return p;
}

export function researchGraph(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
) {
  const builder = new StateGraph(State)
    .addNode("collect", async (s: S) => {
      const c = store.competition(s.competitionId);
      try {
        await saveSource(store, s.competitionId, c.url, "entry");
      } catch (e) {
        store.sourceAttempt(
          s.competitionId,
          c.url,
          "entry",
          e instanceof Error ? e.message : String(e),
        );
      }
      const queries = [
        `${c.title} 比赛 通知 规程 参赛要求`,
        `${c.title} 往届 获奖名单 作品`,
        `${c.title} 获奖作品 展示 作者 学校`,
      ];
      const results = await Promise.all(
        queries.map((q) => searchLogged(store, gateway, s.competitionId, q)),
      );
      await Promise.all(
        results.flatMap((group) =>
          group
            .slice(0, 3)
            .map((r) =>
              saveSourceBestEffort(
                store,
                s.competitionId,
                r.url,
                "search",
                r.title,
              ),
            ),
        ),
      );
      // 查找赛事页面中真实存在的附件或历届链接，控制数量。
      try {
        const page = await fetchDocument(c.url);
        for (const link of page.links
          .filter((x) =>
            /附件|规程|往届|获奖|作品|提交|通知|原文|赛题|下载|模板/.test(
              x.title,
            ),
          )
          .slice(0, 8))
          await saveSourceBestEffort(
            store,
            s.competitionId,
            link.url,
            "linked",
            link.title,
          );
      } catch (e) {
        await save(
          cfg,
          store,
          s.jobId,
          "entry-fetch-error.json",
          JSON.stringify(
            {
              error: e instanceof Error ? e.message : String(e),
              continued: true,
            },
            null,
            2,
          ),
          "source_error",
          null,
        );
      }
      return {};
    })
    .addNode("followup", async (s: S) => {
      const c = store.competition(s.competitionId);
      const used = new Set(
        (store.searches(s.competitionId) as { query: string }[]).map(
          (x) => x.query,
        ),
      );
      // 搜索闲鱼等付费平台的往届获奖作品
      const marketplaceQueries = [
        `${c.title} 往届 获奖作品 闲鱼`,
        `${c.title} 参赛作品集 淘宝`,
        `${c.title} 竞赛资料包 闲鱼`,
      ];
      for (const q of marketplaceQueries)
        if (!used.has(q)) {
          used.add(q);
          await searchLogged(store, gateway, s.competitionId, q);
        }
      for (
        let round = 1;
        round <= executionSettings(cfg).researchRounds;
        round++
      ) {
        const progress = {
          stage: "research",
          action: "沿来源缺口继续检索",
          round,
          maxRounds: executionSettings(cfg).researchRounds,
        };
        if (gateway.reportProgress) await gateway.reportProgress(progress);
        else await saveJobProgress(cfg.dataDir, s.jobId, progress);
        const evidence = store
          .evidence(s.competitionId)
          .map((e) => ({
            url: e.url,
            title: e.title,
            text: e.text.slice(0, 8000),
          }));
        let raw: string;
        try {
          raw = await gateway.generate(
            "writer",
            `${Guard}\n根据以下证据提出最多三个具体的后续搜索词，用于寻找往届作品、获奖团队、作品展示或原始规则附件。当前第 ${round} 轮，已经搜索 ${JSON.stringify([...used])}，不要重复。沿获奖名单→作品名称/作者→学校报道→公开代码/演示追查，有确切名称或团队线索时必须追查其作品；找不到线索时搜索往届获奖名单。如果免费渠道找不到完整作品，可以搜索"闲鱼 [比赛名称] 获奖作品"或"淘宝 [比赛名称] 作品集"等关键词，识别付费资料来源。只输出 JSON 字符串数组，不要虚构名称；若已无必要的查询输出空数组。赛事：${c.title}\n证据：${JSON.stringify(evidence)}`,
            "research",
          );
        } catch (e) {
          if (isJobControlError(e) || budgetError(e)) throw e;
          await save(
            cfg,
            store,
            s.jobId,
            `followup-error-${round}.json`,
            JSON.stringify(
              {
                error: e instanceof Error ? e.message : String(e),
                continued: true,
              },
              null,
              2,
            ),
            "research_error",
            null,
          );
          break;
        }
        const parsed = parseJSON(raw);
        if (
          !Array.isArray(parsed) ||
          !parsed.every((x) => typeof x === "string")
        ) {
          await save(
            cfg,
            store,
            s.jobId,
            `followup-invalid-${round}.json`,
            JSON.stringify({ response: raw, continued: true }, null, 2),
            "research_error",
            null,
          );
          break;
        }
        const queries = parsed
          .filter((x) => x.trim() && !used.has(x))
          .slice(0, 3);
        if (!queries.length) break;
        queries.forEach((q) => used.add(q));
        const results = await Promise.all(
          queries.map((q) => searchLogged(store, gateway, s.competitionId, q)),
        );
        await Promise.all(
          results.flatMap((group) =>
            group
              .slice(0, 2)
              .map((r) =>
                saveSourceBestEffort(
                  store,
                  s.competitionId,
                  r.url,
                  "followup",
                  r.title,
                ),
              ),
          ),
        );
      }
      return {};
    })
    .addNode("agentResearch", async (s: S) => {
      if (!gateway.investigate || !resolveAgent(cfg, "research").enabled)
        return {};
      const c = store.competition(s.competitionId);
      const evidence = store
        .evidence(s.competitionId)
        .map((e) => ({
          url: e.url,
          title: e.title,
          text: e.text.slice(0, 5000),
        }));
      try {
        const result = await gateway.investigate(
          `${Guard}\n自主研究 ${c.title} 的往届获奖名单、作品名称和作者，再沿学校报道、团队页面追查公开的完整作品或演示。每一步用搜索与页面验证，不得编造。仅输出 JSON {"urls":[{"url":"https://...","title":"..."}],"missing":["..."]}，只填实际访问过的 URL，最多 10 个。已有证据：${JSON.stringify(evidence)}`,
        );
        await save(
          cfg,
          store,
          s.jobId,
          "claude-research.json",
          JSON.stringify(
            { sessionId: result.sessionId, result: result.text },
            null,
            2,
          ),
          "research_agent",
          modelLabel(cfg, "research"),
        );
        const parsed = parseJSON(result.text) as any;
        if (!Array.isArray(parsed?.urls))
          throw Error("研究 Agent 未返回可验证的来源列表");
        await Promise.all(
          parsed.urls
            .slice(0, 10)
            .filter((x: any) => typeof x?.url === "string")
            .map((x: any) =>
              saveSourceBestEffort(
                store,
                s.competitionId,
                x.url,
                "agent_research",
                typeof x.title === "string" ? x.title : undefined,
              ),
            ),
        );
      } catch (e) {
        if (isJobControlError(e) || budgetError(e)) throw e;
        await save(
          cfg,
          store,
          s.jobId,
          "research-agent-error.json",
          JSON.stringify(
            {
              error: e instanceof Error ? e.message : String(e),
              continued: true,
            },
            null,
            2,
          ),
          "research_agent_error",
          null,
        );
      }
      return {};
    })
    .addNode("analyze", async (s: S) => {
      const c = store.competition(s.competitionId);
      const sources = store
        .evidence(s.competitionId)
        .map((e) => ({
          url: e.url,
          title: e.title,
          kind: e.kind,
          text: e.text.slice(0, 18000),
        }));
      const prompt = `${Guard}\n读取来源并只输出一个 JSON 对象，字段必须为 title, edition, eligibility, deadline, ai_rules, scoring, deliverables, requires_idea, missing, citations, research。未知值用 null，不要猜测；冲突与未知记在 missing。deliverables 是数组，每项包含 type, quantity, formats(数组), limits(数组), naming, attachments(数组), submission, official_template；没有明确规定的项用 null 或空数组；不要制定模板。deliverables 只收录需要产出提交文件的参赛作品（论文、方案、设计、译文等）；线上报名、问卷填报、注册缴费这类流程性事项不是交付物，不要列入，也不要把“报名信息表”当成交付物。citations 为数组，每项包含 field、url、quote，其中 quote 必须逐字摘自该 url 的来源正文；每项已知规则尽量提供引用。research 必须为 {past_winners:[],past_works:[],judging:[],missing:[]}，前三项为 {url,quote,title} 数组；仅当找到真实获奖名单时填 past_winners，仅找到实际公开作品、代码或展示时填 past_works，仅有奖项或标题不足以证明完整作品；评分依据填 judging。quote 必须逐字来自该 URL 正文；未找到就留空，不要猜测。requires_idea 对翻译等给定材料的任务为 false，不确定为 null。赛事：${c.title}\n用户情况：${JSON.stringify(cfg.profile)}\n来源：${JSON.stringify(sources)}`;
      let candidate = parseJSON(
        await gateway.generate("writer", prompt, "research"),
      );
      let parsed = Brief.safeParse(candidate);
      if (!parsed.success) {
        candidate = parseJSON(
          await gateway.generate(
            "writer",
            `${Guard}\n上一份规则档案不符合指定 JSON 字段类型。请只修复结构和字段类型，不增加未证实事实；eligibility、deadline、ai_rules、scoring、edition 必须是字符串或 null，deliverables 的 type 必须是字符串。返回完整 JSON 对象。\n校验问题：${JSON.stringify(parsed.error.issues)}\n原始档案：${JSON.stringify(candidate)}`,
            "research",
          ),
        );
        parsed = Brief.safeParse(candidate);
      }
      if (!parsed.success) throw parsed.error;
      const brief = parsed.data;
      if (
        brief.deliverables.some((item) =>
          /征文|论文|essay|paper|article/i.test(item.type),
        )
      )
        brief.requires_idea = true;
      const known = store.evidence(s.competitionId);
      const normalized = (x: string) => x.replace(/\s+/g, " ").trim();
      const valid = brief.citations.filter((citation) =>
        known.some(
          (e) =>
            e.url === citation.url &&
            citation.quote.trim().length > 0 &&
            normalized(e.text).includes(normalized(citation.quote)),
        ),
      );
      if (valid.length !== brief.citations.length)
        brief.missing.push("部分引用无法在实际来源正文中核对，已剔除");
      brief.citations = valid;
      for (const key of ["past_winners", "past_works", "judging"] as const) {
        const before = brief.research[key].length;
        brief.research[key] = brief.research[key].filter((proof) =>
          known.some(
            (e) =>
              e.url === proof.url &&
              proof.quote.trim().length >= 5 &&
              normalized(e.text).includes(normalized(proof.quote)),
          ),
        );
        if (before !== brief.research[key].length)
          brief.research.missing.push(`${key} 部分证据无法逐字核对，已剔除`);
      }
      // 同一赛事可能多轮分析：缺口按语义去重后写回，避免提示词里堆出十条相同内容。
      const missingGaps: string[] = [];
      if (!brief.research.past_winners.length)
        missingGaps.push("尚未找到可核对的往届获奖名单");
      if (!brief.research.past_works.length)
        missingGaps.push("尚未找到可核对的往届完整作品或展示；不能判断创新性");
      if (!brief.research.judging.length)
        missingGaps.push("尚未找到可核对的评分细则");
      if (gateway.canSearch === false)
        missingGaps.push(
          "未配置全网关键词搜索，往届作品与相似方案检索范围受限",
        );
      brief.research.missing = [
        ...new Set([...brief.research.missing, ...missingGaps]),
      ];
      for (const field of ["eligibility", "deadline", "ai_rules", "scoring"])
        if (
          brief[field as keyof typeof brief] &&
          !valid.some((x) => x.field === field)
        )
          brief.missing.push(`${field} 缺少可核对的原文引用`);
      store.setBrief(s.competitionId, brief);
      await save(
        cfg,
        store,
        s.jobId,
        "research-coverage.json",
        JSON.stringify(
          {
            coverage: brief.research,
            searches: store.searches(s.competitionId),
            source_attempts: store.sourceAttempts(s.competitionId),
          },
          null,
          2,
        ),
        "research_coverage",
        null,
      );
      return {};
    })
    .addNode("writeReport", async (s: S) => {
      const c = store.competition(s.competitionId);
      const evidence = store
        .evidence(s.competitionId)
        .map(({ url, title, kind, text }) => ({
          url,
          title,
          kind,
          excerpt: text.slice(0, 12000),
        }));
      const searches = store.searches(s.competitionId);
      const report = await gateway.generate(
        "writer",
        `${Guard}\n依据以下数据撰写中文赛事研究报告。对每项可核实事实标注来源 URL。明确区分当届规则、历届获奖名单与公开完整作品；如果证据不足或无公开作品，明确说明，不得推断其不存在或捏造。指出资格、截止日期、评分、AI规则、交付要求、冲突及资料缺口。\n档案：${JSON.stringify(c.brief)}\n证据：${JSON.stringify(evidence)}\n检索记录：${JSON.stringify(searches)}\n来源访问记录：${JSON.stringify(store.sourceAttempts(s.competitionId))}`,
      );
      const path = await save(
        cfg,
        store,
        s.jobId,
        "research.md",
        report,
        "research_report",
        modelLabel(cfg, "writer"),
      );
      return { report, outputPath: path };
    })
    .addEdge(START, "collect")
    .addEdge("collect", "followup")
    .addEdge("followup", "agentResearch")
    .addEdge("agentResearch", "analyze")
    .addEdge("analyze", "writeReport")
    .addEdge("writeReport", END);
  const saver = SqliteSaver.fromConnString(
    join(cfg.dataDir, "checkpoints.sqlite"),
  );
  return { graph: builder.compile({ checkpointer: saver }), saver };
}

export function translationGraph(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
) {
  const builder = new StateGraph(State)
    .addNode("validate", async (s: S) => {
      const c = store.competition(s.competitionId);
      if (!c.brief) throw Error("请先执行 research，核对比赛交付要求");
      if (!s.sourcePath) throw Error("缺少原文文件，请通过 --source 指定");
      if (!s.targetLanguage) throw Error("缺少目标语言，请通过 --target 指定");
      if (!["txt", "md", "docx"].includes(s.format))
        throw Error(
          "请通过 --format 指定 txt、md 或 docx；不支持的格式需人工处理",
        );
      const allItems = c.brief.deliverables as {
        type: string;
        formats: string[];
        official_template: string | null;
      }[];
      const items = allItems.filter((x) =>
        /translation|翻译|译文|译稿/i.test(x.type),
      );
      if (!items.length)
        throw Error(
          "赛事交付清单中未识别到翻译作品；请核对规则，不能自动按翻译赛处理",
        );
      if (items.some((x) => x.official_template))
        throw Error(
          "赛事要求官方模板；当前适配器无法保证保留该模板，请人工处理",
        );
      const formats = items
        .flatMap((x) => x.formats)
        .map((x) => x.toLowerCase().replace(/^\./, ""));
      if (
        formats.length &&
        !formats.some((x) => x === s.format || x.includes(s.format))
      )
        throw Error(
          `指定格式 ${s.format} 与赛事要求不一致：${formats.join(", ")}`,
        );
      const source = await readSource(s.sourcePath);
      if (!source.trim()) throw Error("原文为空或无法提取；扫描件可能需要 OCR");
      await save(cfg, store, s.jobId, "source.txt", source, "source", null);
      await save(
        cfg,
        store,
        s.jobId,
        "brief.json",
        JSON.stringify(c.brief, null, 2),
        "rules_snapshot",
        null,
      );
      return {};
    })
    .addNode("writeDraft", async (s: S) => {
      const source = await readFile(
        join(dir(cfg, s.jobId), "source.txt"),
        "utf8",
      );
      const brief = await readFile(
        join(dir(cfg, s.jobId), "brief.json"),
        "utf8",
      );
      const draft = await gateway.generate(
        "writer",
        `${Guard}\n你是专业翻译。将原文翻译成${s.targetLanguage}，遵守比赛要求，忠实完整，不添加编造信息。只返回译文。\n比赛规则：${brief}\n原文：\n${source}`,
      );
      await save(
        cfg,
        store,
        s.jobId,
        "draft.txt",
        draft,
        "draft",
        modelLabel(cfg, "writer"),
      );
      return { draft };
    })
    .addNode("revise", async (s: S) => {
      await save(
        cfg,
        store,
        s.jobId,
        "final.txt",
        s.draft,
        "final_text",
        modelLabel(cfg, "writer"),
      );
      return { finalText: s.draft };
    })
    .addNode("export", async (s: S) => {
      await mkdir(dir(cfg, s.jobId), { recursive: true });
      const out = join(dir(cfg, s.jobId), `submission.${s.format}`);
      if (s.format === "docx") {
        const doc = new Document({
          sections: [
            {
              children: s.finalText
                .split(/\r?\n/)
                .map((line) => new Paragraph(line)),
            },
          ],
        });
        await writeFile(out, await Packer.toBuffer(doc));
      } else await writeFile(out, s.finalText, "utf8");
      store.artifact(s.jobId, "submission", out, modelLabel(cfg, "writer"));
      return { outputPath: out };
    })
    .addEdge(START, "validate")
    .addEdge("validate", "writeDraft")
    .addEdge("writeDraft", "revise")
    .addEdge("revise", "export")
    .addEdge("export", END);
  const saver = SqliteSaver.fromConnString(
    join(cfg.dataDir, "checkpoints.sqlite"),
  );
  return { graph: builder.compile({ checkpointer: saver }), saver };
}

export function reportGraph(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
) {
  const builder = new StateGraph(State)
    .addNode("validate", async (s: S) => {
      const c = store.competition(s.competitionId);
      if (!c.brief) throw Error("请先执行 research，核对比赛交付要求");
      if (!s.sourcePath) throw Error("缺少材料，请通过 --source 指定");
      if (!["txt", "md", "docx"].includes(s.format))
        throw Error("请通过 --format 指定 txt、md 或 docx");
      const items = (
        c.brief.deliverables as {
          type: string;
          formats: string[];
          official_template: string | null;
        }[]
      ).filter((x) =>
        /report|document|proposal|报告|文档|文稿|方案书|申报书/i.test(x.type),
      );
      if (!items.length)
        throw Error("赛事交付清单中未识别到报告或文档；请先核对规则");
      if (items.some((x) => x.official_template))
        throw Error(
          "赛事要求官方模板；当前适配器无法保证保留该模板，请人工处理",
        );
      const formats = items
        .flatMap((x) => x.formats)
        .map((x) => x.toLowerCase().replace(/^\./, ""));
      if (
        formats.length &&
        !formats.some((x) => x === s.format || x.includes(s.format))
      )
        throw Error(
          `指定格式 ${s.format} 与赛事要求不一致：${formats.join(", ")}`,
        );
      const source = await readSource(s.sourcePath);
      if (!source.trim()) throw Error("材料为空或无法提取");
      await save(cfg, store, s.jobId, "source.txt", source, "source", null);
      await save(
        cfg,
        store,
        s.jobId,
        "brief.json",
        JSON.stringify(c.brief, null, 2),
        "rules_snapshot",
        null,
      );
      return {};
    })
    .addNode("writeDraft", async (s: S) => {
      const source = await readFile(
        join(dir(cfg, s.jobId), "source.txt"),
        "utf8",
      );
      const brief = await readFile(
        join(dir(cfg, s.jobId), "brief.json"),
        "utf8",
      );
      const draft = await gateway.generate(
        "writer",
        `${Guard}\n依据比赛要求、用户提供的材料与指示撰写作品。不使用预设模板，自行组织适合本赛题的结构；不得编造事实、数据、采访或来源。只输出正文。\n比赛要求：${brief}\n指示：${s.instructions}\n用户材料：${source}`,
      );
      await save(
        cfg,
        store,
        s.jobId,
        "draft.txt",
        draft,
        "draft",
        modelLabel(cfg, "writer"),
      );
      return { draft };
    })
    .addNode("revise", async (s: S) => {
      await save(
        cfg,
        store,
        s.jobId,
        "final.txt",
        s.draft,
        "final_text",
        modelLabel(cfg, "writer"),
      );
      return { finalText: s.draft };
    })
    .addNode("export", async (s: S) => {
      await mkdir(dir(cfg, s.jobId), { recursive: true });
      const outputPath = join(dir(cfg, s.jobId), `submission.${s.format}`);
      if (s.format === "docx") {
        const doc = new Document({
          sections: [
            {
              children: s.finalText
                .split(/\r?\n/)
                .map((line) => new Paragraph(line)),
            },
          ],
        });
        await writeFile(outputPath, await Packer.toBuffer(doc));
      } else await writeFile(outputPath, s.finalText, "utf8");
      store.artifact(
        s.jobId,
        "submission",
        outputPath,
        modelLabel(cfg, "writer"),
      );
      return { outputPath };
    })
    .addEdge(START, "validate")
    .addEdge("validate", "writeDraft")
    .addEdge("writeDraft", "revise")
    .addEdge("revise", "export")
    .addEdge("export", END);
  const saver = SqliteSaver.fromConnString(
    join(cfg.dataDir, "checkpoints.sqlite"),
  );
  return { graph: builder.compile({ checkpointer: saver }), saver };
}

export async function runJob(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
  jobId: string,
  resume = false,
) {
  const job = store.job(jobId);
  if (job.state === "completed") throw Error("任务已经完成");
  const release = beginJobRun(store, jobId);
  gateway = controlledGateway(store, jobId, gateway, release.assert);
  const runtime =
    job.kind === "research"
      ? researchGraph(cfg, store, gateway)
      : job.kind === "translation"
        ? translationGraph(cfg, store, gateway)
        : job.kind === "report"
          ? reportGraph(cfg, store, gateway)
          : null;
  if (!runtime) {
    release();
    throw Error(`暂不支持作品类型：${job.kind}`);
  }
  const { graph, saver } = runtime;
  const config = { configurable: { thread_id: jobId } };
  store.setJob(jobId, "running");
  try {
    const checkpoint = resume ? await graph.getState(config) : null;
    const initial =
      resume && checkpoint?.createdAt
        ? null
        : {
            jobId,
            competitionId: job.competitionId,
            sourcePath: String(job.input.sourcePath || ""),
            targetLanguage: String(job.input.targetLanguage || ""),
            instructions: String(job.input.instructions || ""),
            format: String(job.input.format || ""),
          };
    const result = await graph.invoke(initial as any, config);
    release.assert();
    assertJobCanRun(store, jobId);
    const state = store.finishJob(jobId, "completed", null, {
      outputPath: result.outputPath,
    });
    if (state !== "completed") {
      release.assert();
      assertJobCanRun(store, jobId);
    }
    return result;
  } catch (e) {
    release.assert();
    const state = store.finishJob(
      jobId,
      "failed",
      e instanceof Error ? e.message : String(e),
    );
    await saveJobProgress(cfg.dataDir, jobId, {
      stage: state,
      action:
        state === "paused"
          ? "任务已暂停"
          : state === "stopped"
            ? "任务已停止"
            : "任务中断，检查点已保存",
    });
    throw e;
  } finally {
    saver.db.close();
    release();
  }
}
