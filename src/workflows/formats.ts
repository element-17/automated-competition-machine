/**
 * 交付格式补全：公告没写格式的交付物，先在已有资料里找，再搜索官方通知、附件和征文要求。
 * 只有模型给出的原文引用能在实际抓取的页面里逐字找到、且引用本身写明了文件格式，才写入赛事档案；
 * 否则保持未知，作品仍是草稿，并把缺口交给用户。
 */
import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import type { Store } from "../core/store.js";
import type { Brief, ModelGateway } from "../core/types.js";
import { parseJSON } from "../core/gateway.js";
import { isJobControlError } from "../core/job-control.js";
import { modelLabel } from "../agents/models.js";
import { saveSourceBestEffort, searchLogged } from "../competition/sources.js";
import { Guard, budgetError, cached, contents } from "./shared.js";

/** 引用里出现这些写法才算写明了格式；键是写法，值是程序使用的格式名。 */
const formatWords: [RegExp, string][] = [
  [/\.?docx?\b|word\s*(文档|格式)?|word版/i, "docx"],
  [/\.?pdf\b/i, "pdf"],
  [/\.?pptx?\b|powerpoint|演示文稿/i, "pptx"],
  [/\.?xlsx?\b|excel|电子表格/i, "xlsx"],
  [/\.?zip\b|\.?rar\b|\.?7z\b|压缩包|压缩文件/i, "zip"],
  [/\.?png\b/i, "png"],
  [/\.?jpe?g\b/i, "jpg"],
  [/\.?mp4\b|\.?mov\b/i, "mp4"],
  [/\.?html?\b|网页文件/i, "html"],
  [/\.?txt\b|纯文本/i, "txt"],
  [/\.?md\b|markdown/i, "md"],
];
export const formatsInQuote = (quote: string) => [
  ...new Set(formatWords.filter(([re]) => re.test(quote)).map(([, f]) => f)),
];
const normalized = (x: string) => x.replace(/\s+/g, " ").trim();
/** 列表页抓取的标题常夹带日期、通知编号和正文摘录，作为搜索词前先裁净。 */
export function cleanSearchTitle(raw: string): string {
  const cleaned = raw
    .replace(/^\s*\d{4}[.\-/年]\d{1,2}[.\-/月]\d{1,2}日?\s*/g, "")
    .replace(/【[^】]{2,24}】\s*/g, "")
    .replace(/\s+一、[\s\S]*$/, "")
    .replace(/\s*[（(]一[）)][\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || raw.trim()).slice(0, 60);
}

const Found = z.object({
  items: z
    .array(
      z.object({
        deliverable: z.number().int().min(0),
        formats: z.array(z.string()).default([]),
        url: z.string().nullable().default(null),
        quote: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
const Record_ = z.object({
  resolved: z.array(
    z.object({
      deliverable: z.number().int(),
      formats: z.array(z.string()),
      url: z.string(),
      quote: z.string(),
    }),
  ),
  unresolved: z.array(z.number().int()),
  queries: z.array(z.string()),
});
export type FormatDiscovery = z.infer<typeof Record_>;

/** 为缺少格式的交付物查找并核对官方格式；结果缓存在任务目录，恢复时不重复搜索。会直接更新 brief.deliverables[i].formats 和 citations。 */
export async function discoverFormats(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
  input: { jobId: string; competitionId: string; title: string; brief: Brief },
): Promise<FormatDiscovery> {
  const { jobId, competitionId, title, brief } = input;
  const missing = brief.deliverables
    .map((d, i) => ({ d, i }))
    .filter((x) => !x.d.formats.length && !x.d.official_template);
  if (!missing.length) return { resolved: [], unresolved: [], queries: [] };
  const result = await cached(
    cfg,
    store,
    jobId,
    "format-discovery.json",
    Record_,
    modelLabel(cfg, "reviewer"),
    async () => {
      const queryTitle = cleanSearchTitle(brief.title || title);
      const queries = [
        `${queryTitle} 提交 格式 要求`,
        `${queryTitle} 作品 提交 附件 模板`,
        ...new Set(missing.map((x) => `${queryTitle} ${x.d.type} 格式 字数 要求`)),
      ].slice(0, 4);
      if (gateway.canSearch !== false) {
        const groups = await Promise.all(
          queries.map((q) => searchLogged(store, gateway, competitionId, q)),
        );
        await Promise.all(
          groups
            .flatMap((g) => g.slice(0, 3))
            .map((r) =>
              saveSourceBestEffort(
                store,
                competitionId,
                r.url,
                "format",
                r.title,
              ),
            ),
        );
      }
      const evidence = contents(store, competitionId).map((e) => ({
        url: e.url,
        title: e.title,
        text: e.text.slice(0, 8000),
      }));
      let found: z.infer<typeof Found> = { items: [] };
      try {
        found = Found.parse(
          parseJSON(
            await gateway.generate(
              "reviewer",
              `${Guard}\n下面这些交付物的公告没有写提交文件格式。请在资料中查找主办方对它们文件格式的明确规定（如“以 Word 格式提交”“PDF 文档”“压缩包”）。只输出 JSON {"items":[{"deliverable":交付物下标,"formats":["docx"],"url":"来源 URL","quote":"逐字摘自该来源、写明格式的原文"}]}。quote 必须逐字来自资料原文并包含格式字样；资料没有明确规定的交付物不要输出，不要按常识推断。\n交付物：${JSON.stringify(missing.map((x) => ({ deliverable: x.i, type: x.d.type, limits: x.d.limits, submission: x.d.submission })))}\n资料：${JSON.stringify(evidence)}`,
              "reviewer",
            ),
          ),
        );
      } catch (e) {
        if (isJobControlError(e) || budgetError(e)) throw e;
      }
      const known = store.evidence(competitionId);
      const resolved: FormatDiscovery["resolved"] = [];
      for (const x of found.items) {
        if (
          !missing.some((m) => m.i === x.deliverable) ||
          !x.url ||
          !x.quote ||
          resolved.some((r) => r.deliverable === x.deliverable)
        )
          continue;
        const quote = x.quote.trim();
        if (quote.length < 4) continue;
        if (
          !known.some(
            (e) =>
              e.url === x.url && normalized(e.text).includes(normalized(quote)),
          )
        )
          continue;
        const formats = formatsInQuote(quote);
        if (!formats.length) continue;
        resolved.push({
          deliverable: x.deliverable,
          formats,
          url: x.url,
          quote,
        });
      }
      return {
        resolved,
        queries,
        unresolved: missing
          .map((m) => m.i)
          .filter((i) => !resolved.some((r) => r.deliverable === i)),
      };
    },
  );
  for (const r of result.resolved) {
    const d = brief.deliverables[r.deliverable];
    if (!d || d.formats.length) continue;
    d.formats = r.formats;
    brief.citations = [
      ...(brief.citations || []),
      {
        field: `deliverables.${r.deliverable}.formats`,
        url: r.url,
        quote: r.quote,
      },
    ];
  }
  if (result.resolved.length) store.setBrief(competitionId, brief);
  return result;
}
