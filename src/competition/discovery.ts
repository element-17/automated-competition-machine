import { createHash } from "node:crypto";
import { isJobControlError } from "../core/job-control.js";
import { searchSettings, type SearchSettings } from "../core/config.js";
import type { Store } from "../core/store.js";
import type { ModelGateway, SearchResult } from "../core/types.js";
import { searchLogged, fetchDocument } from "./sources.js";
import type { BrowserFetchOptions } from "./browser-fetcher.js";
import { z } from "zod";
import { parseJSON } from "../core/gateway.js";
import { todayChina } from "./screening.js";
import { competitionCoreKey } from "./dedupe.js";
import { guards } from "../agents/prompts.js";

export const isCompetitionCandidate = (title: string) =>
  !/获奖名单|获奖公告|评审结果|圆满落幕|获奖公示|比赛结果|入围名单|评审公示|竞赛平台|竞赛导航|比赛大全|赛事大全|竞赛汇总|竞赛资讯|竞赛榜单|竞赛信息网|竞赛网|赛事平台|大赛平台|竞赛中心首页|竞赛归档|赛事归档|报名系统|报名平台|竞赛列表|赛事列表|竞赛分类|赛事专区|竞赛专区/.test(
    title,
  ) && /竞赛|比赛|大赛|挑战赛|征文|征稿|作品征集/.test(title);

/** 内置搜索方向；每次按最久未搜索的顺序轮换，避免反复只搜同几类。 */
export const builtinQueries = (year: number) => [
  `${year} 大学生 竞赛 征集作品 报名`,
  `${year} 高校 翻译大赛 征稿`,
  `${year} 大学生 设计大赛 海报 摄影`,
  `${year} 大学生 创新 创业 比赛 项目 方案`,
  `${year} 大学生 AI 创意 软件 比赛`,
  `${year} 大学生 征文 写作 比赛`,
  `${year} 大学生 视频 微课 比赛 作品`,
  `${year} 全国大学生 学科竞赛 通知`,
  `${year} 大学生 数学建模 竞赛 通知`,
  `${year} 大学生 程序设计 算法 竞赛 报名`,
  `${year} 大学生 电子设计 机器人 竞赛 通知`,
  `${year} 挑战杯 互联网+ 大学生 竞赛 通知`,
  `${year} 大学生 英语 演讲 写作 大赛`,
  `${year} 大学生 商业 营销 案例 大赛`,
  `${year} 大学生 广告 艺术 动漫 大赛 征集`,
  `${year} 大学生 环保 公益 社会实践 比赛`,
  `${year} 大学生 网络安全 竞赛 报名`,
  `${year} 大学生 数据分析 统计 大赛`,
  `${year} 大学生 文创 非遗 设计 比赛`,
  `${year} 大学生 化学 生物 实验 竞赛`,
];

/** 本次要执行的搜索词：自定义搜索词每次都搜，剩余名额从内置方向中轮换。 */
export function plannedQueries(
  store: Store,
  settings: SearchSettings,
  year = new Date().getFullYear(),
) {
  const custom = [...new Set(settings.queries)];
  const last = new Map<string, string>();
  for (const x of store.searches(null) as {
    query: string;
    searched_at: string;
  }[])
    last.set(x.query, x.searched_at);
  const rotated = builtinQueries(year)
    .filter((q) => !custom.includes(q))
    .map((q, i) => ({ q, i, t: last.get(q) || "" }))
    .sort((a, b) => a.t.localeCompare(b.t) || a.i - b.i)
    .map((x) => x.q);
  return [
    ...custom,
    ...rotated.slice(0, Math.max(0, settings.queriesPerRun - custom.length)),
  ];
}

const numeral = (s: string) => {
  if (/^\d+$/.test(s)) return Number(s);
  const d: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let n = 0,
    cur = 0;
  for (const ch of s) {
    if (ch === "百") {
      n += (cur || 1) * 100;
      cur = 0;
    } else if (ch === "十") {
      n += (cur || 1) * 10;
      cur = 0;
    } else cur = d[ch] ?? 0;
  }
  return n + cur;
};
/** 从“第X届……大赛”提取届次和赛事名，用来合并不同学校转发的同一场比赛；无届次时不合并。 */
export function competitionKey(title: string): string | null {
  const m = title
    .replace(/[\s"“”'‘’「」『』《》（）()]/g, "")
    .match(
      /第([0-9零一二两三四五六七八九十百]+)届(.{2,40}?(?:大赛|竞赛|比赛|挑战赛))/,
    );
  return m ? `${numeral(m[1]!)}|${m[2]}` : null;
}
const cleanUrl = (input: string) => {
  try {
    const u = new URL(input);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
};

const Screened = z.array(
  z.object({
    i: z.number().int(),
    keep: z.boolean(),
    reason: z.string().default(""),
  }),
);
export const SCREEN_RECORD = "screen:搜索结果评估";
// 搜索摘要具有时效性：同内容最多复用一周；失败只冷却 15 分钟，仍需正式审核。
export const SCREEN_RECHECK_MS = 7 * 24 * 60 * 60_000;
export const SCREEN_FAILURE_COOLDOWN_MS = 15 * 60_000;
const ScreenEntry = z.object({
  url: z.string(),
  title: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string(),
  status: z.enum(["retained", "rejected", "unreviewed"]),
  reason: z.string(),
  recheckReason: z.string(),
});
type ScreenEntry = z.infer<typeof ScreenEntry>;
const fingerprint = (r: SearchResult) =>
  createHash("sha256")
    .update(JSON.stringify([r.title, r.snippet].map((s) => s.replace(/\s+/g, " ").trim())))
    .digest("hex");

function screeningHistory(store: Store) {
  const entries = new Map<string, Map<string, ScreenEntry>>(),
    legacy = new Set<string>();
  for (const row of store.searches(null) as { query: string; results: string }[]) {
    if (row.query !== SCREEN_RECORD) continue;
    try {
      const data = JSON.parse(row.results);
      for (const d of Array.isArray(data.dropped) ? data.dropped : []) {
        const url = typeof d?.url === "string" ? cleanUrl(d.url) : null;
        if (url) legacy.add(url);
      }
      if (data.version !== 2 || !Array.isArray(data.decisions)) continue;
      for (const raw of data.decisions) {
        const parsed = ScreenEntry.safeParse(raw);
        if (!parsed.success) continue;
        const entry = parsed.data, url = cleanUrl(entry.url);
        if (!url || !Number.isFinite(Date.parse(entry.checkedAt))) continue;
        const versions = entries.get(url) || new Map<string, ScreenEntry>();
        const prior = versions.get(entry.fingerprint);
        if (!prior || Date.parse(prior.checkedAt) <= Date.parse(entry.checkedAt))
          versions.set(entry.fingerprint, { ...entry, url });
        entries.set(url, versions);
      }
    } catch { /* 无法验证的旧记录不构成永久剔除依据。 */ }
  }
  return { entries, legacy };
}

/** 初筛只决定候选保留/剔除，不代表正式审核通过；失败必须明确记为未审核。 */
export async function screenResults(
  store: Store,
  gateway: ModelGateway,
  items: SearchResult[],
  batch = 20,
): Promise<Set<string>> {
  if (!Number.isInteger(batch) || batch < 1) throw Error("初筛批量必须为正整数");
  const rejected = new Set<string>();
  if (!items.length) return rejected;
  const history = screeningHistory(store), now = Date.now();
  const unique = new Map<string, SearchResult>();
  for (const r of items) {
    const url = cleanUrl(r.url);
    if (url && !unique.has(url)) unique.set(url, { ...r, url });
  }
  const decisions: (ScreenEntry & { reused?: boolean })[] = [];
  const pending: { item: SearchResult; entry: ScreenEntry }[] = [];
  for (const r of unique.values()) {
    const hash = fingerprint(r), versions = history.entries.get(r.url);
    const prior = versions?.get(hash);
    const age = prior ? now - Date.parse(prior.checkedAt) : Infinity;
    const ttl = prior?.status === "unreviewed" ? SCREEN_FAILURE_COOLDOWN_MS : SCREEN_RECHECK_MS;
    if (prior && age >= 0 && age < ttl) {
      decisions.push({ ...prior, reused: true });
      continue;
    }
    pending.push({ item: r, entry: {
      url: r.url, title: r.title, fingerprint: hash,
      checkedAt: new Date(now).toISOString(), status: "unreviewed",
      reason: "初筛尚未完成，等待人工或正式审核",
      recheckReason: prior ? "expired" : versions?.size ? "content_changed"
        : history.legacy.has(r.url) ? "legacy_record" : "first_seen",
    } });
  }
  let checked = 0, attempted = 0;
  for (let start = 0; start < pending.length; start += batch) {
    const group = pending.slice(start, start + batch);
    const prompt = `${guards.searchResults}本次时间是北京时间 ${todayChina()}。逐条判断是否可能是面向高校学生的当届或即将举办的赛事公告、报名或作品征集通知。只把明显不是的标 keep=false 并写明原因；拿不准的标 keep=true。只输出 JSON 数组，每条形如 {"i":序号,"keep":true或false,"reason":"简短原因"}，覆盖全部序号。\n${JSON.stringify(group.map(({ item: r }, i) => ({ i, title: r.title, snippet: r.snippet.slice(0, 200), url: r.url })))}`;
    attempted += group.length;
    try {
      const verdicts = Screened.parse(
        parseJSON(await gateway.generate("reviewer", prompt, "screener")),
      );
      if (verdicts.length !== group.length || new Set(verdicts.map((v) => v.i)).size !== group.length ||
          verdicts.some((v) => v.i < 0 || v.i >= group.length))
        throw Error("初筛结果未完整且唯一地覆盖全部序号");
      for (const v of verdicts) {
        const entry = group[v.i]!.entry;
        entry.status = v.keep ? "retained" : "rejected";
        entry.reason = v.reason || (v.keep ? "保留候选，仍需正式审核" : "模型剔除，未说明理由");
        entry.checkedAt = new Date().toISOString();
      }
      checked += group.length;
    } catch (e) {
      if (isJobControlError(e)) throw e;
      const error = e instanceof Error ? e.message : String(e);
      for (const { entry } of group) entry.reason = `初筛失败，未审核：${error}`;
      if (/调用失败|API_KEY|预算/.test(error)) {
        for (const { entry } of pending.slice(start + batch))
          entry.reason = `初筛未执行，未审核：${error}`;
        break;
      }
    }
  }
  decisions.push(...pending.map(({ entry }) => entry));
  const dropped = decisions.filter((d) => d.status === "rejected");
  const unreviewed = decisions.filter((d) => d.status === "unreviewed");
  for (const d of dropped) rejected.add(d.url);
  store.search(
    null, SCREEN_RECORD,
    { version: 2, checked, attempted, reused: decisions.filter((d) => d.reused).length,
      decisions, dropped, unreviewed },
    unreviewed.length ? `初筛未完成，${unreviewed.length} 条仅保留为未审核候选，不能视为通过：${unreviewed[0]!.reason}` : null,
  );
  return rejected;
}

export const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export async function discoverCompetitions(
  store: Store,
  gateway: ModelGateway,
  query?: string,
  sources: readonly string[] = [],
  options: Partial<SearchSettings> = {},
  browserFallback?: BrowserFetchOptions,
) {
  const settings = searchSettings({ search: options }),
    year = new Date().getFullYear();
  const queries = query ? [query] : plannedQueries(store, settings, year);
  const score = (r: { title: string; url: string }) => {
    let n = 0;
    if (/\.(edu|gov)\.cn$/i.test(siteOf(r.url))) n += 3;
    if (r.title.includes(String(year)) || r.title.includes(String(year + 1)))
      n += 2;
    if (/通知|征集|征稿|章程|报名/.test(r.title)) n++;
    return n;
  };
  let lists: SearchResult[][] = await Promise.all(
    queries.map(async (q) =>
      (
        await searchLogged(store, gateway, null, q, {
          pages: settings.pages,
          timeRange: settings.timeRange,
        })
      )
        .filter((r) => isCompetitionCandidate(r.title))
        .sort((a, b) => score(b) - score(a)),
    ),
  );
  for (const source of sources) {
    try {
      const page = await fetchDocument(source, { browserFallback });
      const links = page.links
        .filter((x) => isCompetitionCandidate(x.title))
        .slice(0, 30)
        .map((x) => ({ url: x.url, title: x.title, snippet: "" }));
      store.search(null, `source:${source}`, links);
      lists.push(links.sort((a, b) => score(b) - score(a)));
    } catch (e) {
      store.search(
        null,
        `source:${source}`,
        [],
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  // 各列表轮流取结果；每个网站本次最多新增 perHost 场，同一届赛事只保留第一条公告。已入库的赛事不占名额。
  const known = new Map<string, string>(),
    keys = new Map<string, string>(),
    cores = new Map<string, string>();
  for (const c of store.list() as {
    id: string;
    url: string;
    title: string;
  }[]) {
    known.set(c.url, c.id);
    const k = competitionKey(c.title);
    if (k && !keys.has(k)) keys.set(k, c.url);
    // 无届次的标题靠剥壳核心名合并：“关于举办……的通知”换个网站发布不算新赛事。
    const core = competitionCoreKey(c.title);
    if (core && !cores.has(core)) cores.set(core, c.url);
  }
  // 同 URL 本次只初筛一次；历史决定仅在指纹匹配且未到期时复用。
  if (settings.screen) {
    const fresh = new Map<string, SearchResult>();
    for (const list of lists)
      for (const r of list) {
        const url = cleanUrl(r.url);
        if (url && !known.has(url) && !fresh.has(url))
          fresh.set(url, { ...r, url });
      }
    const rejected = await screenResults(store, gateway, [...fresh.values()]);
    if (rejected.size)
      lists = lists.map((list) =>
        list.filter((r) => !rejected.has(cleanUrl(r.url) || "")),
      );
  }
  const perSite = new Map<string, number>(),
    ids: string[] = [];
  const max = Math.max(0, ...lists.map((x) => x.length));
  for (let i = 0; i < max; i++)
    for (const list of lists) {
      const r = list[i];
      if (!r) continue;
      let url: string;
      try {
        const u = new URL(r.url);
        if (!["http:", "https:"].includes(u.protocol)) continue;
        u.hash = "";
        url = u.toString();
      } catch {
        continue;
      }
      const existing = known.get(url);
      if (existing) {
        if (!ids.includes(existing)) ids.push(existing);
        continue;
      }
      const site = siteOf(url),
        key = competitionKey(r.title),
        core = competitionCoreKey(r.title);
      if ((perSite.get(site) || 0) >= settings.perHost) continue;
      if (key && keys.has(key) && keys.get(key) !== url) continue;
      if (core && cores.has(core) && cores.get(core) !== url) continue;
      const id = store.addCompetition(url, r.title);
      known.set(url, id);
      if (key) keys.set(key, url);
      if (core) cores.set(core, url);
      perSite.set(site, (perSite.get(site) || 0) + 1);
      ids.push(id);
    }
  return ids;
}
