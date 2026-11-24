/**
 * 两级竞赛评委打分卡与定向冲奖精修：
 * 第 1 关是硬性底线（合规、真实性、格式、版面、交互）；
 * 第 2 关按赛事评委视角 5 维量化打分（0–100），底线已过但仍停留在平庸及格线时，
 * 针对拉分最低的 1–2 个维度做定向精修，且严格保证单调择优（新版本更差则回退保留原通过版）。
 */
import { z } from "zod";
import type { Brief } from "../core/types.js";

const dimScore = z.number().min(0).max(20);

export const Scorecard = z
  .object({
    novelty: dimScore,
    depth: dimScore,
    evidence: dimScore,
    craft: dimScore,
    presentation: dimScore,
    total: z.number().min(0).max(100).optional(),
    weakest: z
      .array(
        z.object({
          dimension: z.string().trim().min(1).max(40),
          score: z.number().min(0).max(20),
          upgrade: z.string().trim().min(1).max(300),
        }),
      )
      .max(3)
      .default([]),
    summary: z.string().trim().max(300).default(""),
  })
  .transform((s) => {
    const computed = Math.round(s.novelty + s.depth + s.evidence + s.craft + s.presentation);
    return { ...s, total: computed };
  });
export type Scorecard = z.infer<typeof Scorecard>;

export type CompetitionGenre = "technical" | "business" | "design" | "creative";

export function detectGenre(brief: Brief, taskTitle = ""): CompetitionGenre {
  const s = `${brief.title} ${brief.scoring || ""} ${taskTitle} ${brief.deliverables.map((d) => d.type).join(" ")}`;
  if (/征文|散文|诗歌|小说|文学|翻译|作文|写作|故事|剧本/.test(s)) return "creative";
  if (/创业|商业计划|互联网\+|挑战杯|营销|策划|金融|经济/.test(s)) return "business";
  if (/海报|视觉|插画|平面|产品设计|工业设计|文创|米兰设计|华灿|蓝桥杯.*视觉|AIGC/.test(s))
    return "design";
  return "technical";
}

const rubricDescriptors: Record<CompetitionGenre, string> = {
  technical:
    "novelty(切口独特、非烂大街母题与技术差异化,0-20)、depth(核心原理、参数推导、约束取舍与边界分析深度,0-20)、evidence(数据/仿真/公式/交互可验证性与前后一致,0-20)、craft(表达精准凝练、无AI八股与空泛口号,0-20)、presentation(表格/架构图/数据图与视觉信息密度,0-20)",
  business:
    "novelty(商业切入点与差异化定位,0-20)、depth(市场逻辑、竞品拆解、商业模式与财务测算闭环,0-20)、evidence(行业依据、成本/现金流核算与风险对策可执行性,0-20)、craft(商业表达干练、无空洞宏大叙事,0-20)、presentation(图表、财务表与结构化呈现清晰度,0-20)",
  design:
    "novelty(设计概念辨识度与文化/功能转译,0-20)、depth(用户场景洞察、人机/材料/结构逻辑完整度,0-20)、evidence(设计依据、工艺/尺寸约束与可用性验证合理性,0-20)、craft(阐述克制精准、视觉叙事统一,0-20)、presentation(版式美学、图题与多图展示完整度,0-20)",
  creative:
    "novelty(视角与意象独特性、避开陈词滥调,0-20)、depth(情感/思想纵深与叙事张力,0-20)、evidence(细节真实感、历史/生活质感与逻辑自洽,0-20)、craft(文采节奏、克制白描与去AI说明文腔,0-20)、presentation(篇章结构节奏与版面阅读质感,0-20)",
};

/** 附在内容评审提示词中的评委打分要求（单次评审顺带产出，不增加额外模型调用）。 */
export function judgeRubricPrompt(brief: Brief, taskTitle: string): string {
  const genre = detectGenre(brief, taskTitle);
  const official = brief.scoring ? `官方评分要点参考：${brief.scoring}。` : "";
  return `\n同时请以省级/国家级竞赛评委的严格标准（切勿虚高：平庸及格稿给 65-75 分，省奖水准 78-85 分，国奖标杆 88+ 分）在 JSON 中附加可选字段 scorecard：{"novelty":0-20,"depth":0-20,"evidence":0-20,"craft":0-20,"presentation":0-20,"weakest":[{"dimension":"最低分维度","score":得分,"upgrade":"最能拉高该维度的具体改法（指明章节/位置）"}],"summary":"一句评委总评"}。维度标准：${rubricDescriptors[genre]}。${official}scorecard 仅用于区分获奖竞争力，不替代底线 issues 判定。`;
}

const aiClichePatterns: [RegExp, string][] = [
  [/^\s*(?:#[^\n]*\n+)*\s*(?:随着[^。\n]{2,30}(?:快速发展|全面加速|不断推进|日新月异|深入推进|蓬勃发展)|在当前[^。\n]{2,30}背景下|在当今[^。\n]{2,30}时代)/m, "开头出现典型的“随着……的发展/在当前……背景下”AI八股起笔，请直接切入具体场景、对象或硬问题"],
  [/(?:综上所述|总而言之)[^。\n]{0,40}(?:具有重要(?:的)?(?:现实)?意义|广阔的应用前景|显著提升)/, "结尾或段末出现空泛套话（“综上所述……具有重要意义/广阔前景”），请改为具体量化收益、边界结论或下一步验证动作"],
  [/(?:不仅[^。\n]{2,20}，而且[^。\n]{2,20}，更[^。\n]{2,20}){2,}/, "连续堆叠排比宣传句，请删去形容词堆砌，换成具体机制细节或数据对比"],
];

/** 确定性扫描正文中的高频 AI 八股腔，为冲奖精修提供精准落点。 */
export function detectAiCliches(text: string): string[] {
  if (!text.trim()) return [];
  const hits: string[] = [];
  for (const [re, advice] of aiClichePatterns) {
    if (re.test(text)) hits.push(advice);
  }
  return hits;
}

/** 构造冲奖定向精修反馈：保留已过底线的骨架，只精准拉升最低分的 1–2 个维度。 */
export function buildPolishFeedback(
  scorecard: Scorecard,
  cliches: string[],
  minScore: number,
): string[] {
  const dims: [string, number][] = (
    [
      ["立意与独特性(novelty)", scorecard.novelty],
      ["机制与专业深度(depth)", scorecard.depth],
      ["证据与可验证性(evidence)", scorecard.evidence],
      ["表达质感与去AI味(craft)", scorecard.craft],
      ["结构与视觉信息密度(presentation)", scorecard.presentation],
    ] as [string, number][]
  ).sort((a, b) => a[1] - b[1]);

  const lines: string[] = [
    `【冲奖定向精修】上一版已满足基础合规底线，但评委模拟打分为 ${scorecard.total}/100（目标 ≥ ${minScore}）。请保留已通过核验的事实、参数与结构，重点针对以下最拉分维度做升维打磨，严禁编造事实或删除已验证内容：`,
  ];
  if (scorecard.weakest.length) {
    for (const w of scorecard.weakest.slice(0, 2))
      lines.push(`- 重点拉升【${w.dimension}（当前 ${w.score}/20）】：${w.upgrade}`);
  } else {
    for (const [name, val] of dims.slice(0, 2))
      lines.push(`- 重点拉升【${name}（当前 ${val}/20）】：补充具体机制推演、边界对比、结构化表格或可视化图示（mermaid/chart）`);
  }
  for (const c of cliches) lines.push(`- 去 AI 味精修：${c}`);
  return lines;
}
