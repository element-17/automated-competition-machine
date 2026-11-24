/**
 * 赛事可胜率与前置硬阻塞评估：在消耗大量研究与制作调用之前，
 * 识别系统无法独立完成的硬约束（封闭外部指定平台作品 ID、手写原件扫描、纯实物邮寄、纯视频/3D CAD），
 * 并结合用户专业背景与系统强项（软件原型 + 数值仿真 + 图文方案书 + 答辩 PPT）计算匹配度。
 */
import type { UserProfile } from "../core/profile.js";

export type WinnabilityTier = "high" | "medium" | "low" | "blocked";
export type WinnabilityReport = {
  score: number;
  tier: WinnabilityTier;
  hardBlockers: string[];
  strengths: string[];
  cautions: string[];
};

const blockerRules: [RegExp, string][] = [
  [
    /(?:须|必须|需|仅限|统一|严格)[^。\n]{0,16}(?:使用|在|依托)[^。\n]{0,16}(?:指定|官方)(?:AI|创作|生成)?平台[^。\n]{0,20}(?:生成|创作|制作|提交|作品\s*ID)|(?:都奔|即梦|可灵|豆包)[^。\n]{0,16}(?:平台作品\s*ID|生成并提交)/i,
    "要求在官方指定外部封闭平台生成并绑定平台作品 ID，无法本地自动完成",
  ],
  [
    /(?:必须|须|仅限|统一)[^。\n]{0,10}(?:本人)?(?:手写|亲笔)(?:原件|答卷|译文|作文|稿件)?[^。\n]{0,12}(?:扫描|拍照|上传|邮寄)|手写原件扫描/,
    "要求本人手写/亲笔原件扫描提交，机器不能伪造手写扫描件",
  ],
  [
    /(?:邮寄|寄送)[^。\n]{0,12}(?:实物|纸质原件|作品原件)|(?:仅接受|须提交)[^。\n]{0,8}实物作品/,
    "要求邮寄实物或纸质原件",
  ],
  [
    /(?:仅接受|提交格式(?:为|限)|作品格式(?:为|限))[^。\n]{0,12}\b(?:mp4|mov|avi|wav|mp3|step|stp|stl|dwg|fbx|obj|psd|ai)\b/i,
    "核心提交格式为本系统暂不生成的音视频或专业三维/工程文件",
  ],
];

const majorDomains: [RegExp, RegExp, string][] = [
  [/智能|人工智能|AI|机器学习|计算机|软件|信息|数据|网安|自动化/, /人工智能|AI|大模型|AIGC|软件|算法|数据|计算机|程序|系统|创客|智能|物联网|机器人|数学建模/i, "高度契合参赛者专业背景（软件/AI/数据方向）"],
  [/机械|电气|电子|光电|测控|通信|物理|材料/, /硬件|嵌入式|传感器|电路|机械|结构|智能车|创客|机器人|电子设计/i, "契合工科硬件与工程建模背景"],
  [/经济|管理|金融|商|市场|营销/, /创业|商业计划|挑战杯|互联网\+|电商|营销|金融|经济/i, "契合商业分析与项目策划背景"],
  [/设计|艺术|美术|视觉|传媒|新闻|建筑/, /设计|海报|视觉|文创|新媒体|品牌|工业设计|米兰|华灿/i, "契合视觉传达与创意设计背景"],
  [/文学|汉语言|中文|历史|哲学|法学|外语|英语/, /征文|散文|诗歌|小说|翻译|演讲|辩论|调研报告/i, "契合人文社科与文字创作背景"],
];

export function assessWinnability(
  title: string,
  text: string,
  profile?: UserProfile,
): WinnabilityReport {
  const combined = `${title}\n${text}`;
  const hardBlockers: string[] = [];
  for (const [re, reason] of blockerRules) {
    if (re.test(combined)) hardBlockers.push(reason);
  }

  let score = 55;
  const strengths: string[] = [];
  const cautions: string[] = [];

  if (/软件|系统|网页|原型|算法|人工智能|AI|大数据|数据分析|计算机设计|挑战杯|创客|互联网\+|创业计划|商业计划|数学建模|技术方案/i.test(combined)) {
    score += 20;
    strengths.push("支持发挥软件原型、数值仿真与专业图文方案书组合优势");
  }
  if (/(?:方案书|论文|报告|说明书)[\s\S]{0,400}(?:PPT|演示文稿|答辩)|(?:PPT|演示文稿)[\s\S]{0,400}(?:方案书|论文|报告|源码|软件)/i.test(combined)) {
    score += 8;
    strengths.push("多模态组合交付，可发挥单一事实源跨文件协同优势");
  }
  const userBg = [profile?.college, profile?.major].filter(Boolean).join(" ");
  if (userBg) {
    for (const [bgRe, compRe, label] of majorDomains) {
      if (bgRe.test(userBg) && compRe.test(combined)) {
        score += 12;
        strengths.push(label);
        break;
      }
    }
  }
  if (/诗歌|书法|绘画|摄影|微电影|短视频|演讲|朗诵|合唱|舞蹈/i.test(title) && !/软件|算法|AI|方案|数据/i.test(combined)) {
    score -= 18;
    cautions.push("纯文艺/音视频/表演类赛道，自动化组合拳优势有限");
  }
  if (/实物照片|现场照片|实地调研|问卷调查|志愿者/.test(combined)) {
    score -= 8;
    cautions.push("公告涉及实物或实地材料，建议提前准备一手素材注入");
  }

  if (hardBlockers.length) {
    score = Math.min(score, 25);
    return { score: Math.max(0, score), tier: "blocked", hardBlockers, strengths, cautions };
  }
  score = Math.max(0, Math.min(100, score));
  const tier: WinnabilityTier = score >= 75 ? "high" : score >= 50 ? "medium" : "low";
  return { score, tier, hardBlockers, strengths, cautions };
}
