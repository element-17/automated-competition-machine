/**
 * 项目单一事实源（Project Spec）：把选定方案、视觉主题、数值仿真指标与已定稿主文档的核心参数/结构
 * 沉淀到同一份结构化档案中，下游答辩 PPT、软件原型、展板和附表全部按它对齐，彻底消灭跨文件数据打架。
 */
import type { Brief } from "../core/types.js";
import type { Idea } from "./shared.js";
import type { SlideThemeName } from "../artifacts/slide-templates.js";
import type { SimulationArtifact } from "../artifacts/simulation.js";

export type PrimaryWorkDigest = {
  sourceTaskId: string;
  title: string;
  headings: string[];
  keyFigures: string[];
  summaryExcerpt: string;
};

export type ProjectSpec = {
  title: string;
  theme: SlideThemeName;
  problem: string;
  audience: string;
  mechanism: string;
  verification: string;
  simulation?: {
    purpose: string;
    methodology: string;
    disclaimer: string;
    metrics: SimulationArtifact["output"]["metrics"];
    tables: SimulationArtifact["output"]["tables"];
    chartIds: string[];
  };
  primaryWork?: PrimaryWorkDigest;
};

/** 按赛题领域为整套交付物选定统一视觉主题。 */
export function chooseVisualTheme(
  brief: Brief,
  idea: Idea | null,
): SlideThemeName {
  const text = `${brief.title} ${idea?.title || ""} ${idea?.mechanism || ""}`;
  if (/生态|环保|农业|碳中和|低碳|绿|林|水文|ESG/i.test(text)) return "eco-green";
  if (/人工智能|AI|大模型|软件|算法|数据|网络安全|计算机|智能科学|AIGC/i.test(text))
    return "tech-dark";
  if (/文创|非遗|历史|文化|文学|诗歌|散文|艺术|传媒|社科/i.test(text))
    return "editorial-warm";
  if (/工业设计|产品设计|机械|硬件|创客|制造|智能车|机器人|嵌入式/i.test(text))
    return "industrial-clean";
  return "academic-blue";
}

export function createProjectSpec(
  brief: Brief,
  idea: Idea | null,
): ProjectSpec {
  return {
    title: idea?.title || brief.title,
    theme: chooseVisualTheme(brief, idea),
    problem: idea?.problem || "",
    audience: idea?.audience || "",
    mechanism: idea?.mechanism || "",
    verification: idea?.verification || "",
  };
}

/** 将数值仿真结果注入单一事实源，供文档、PPT 和软件原型共享精确指标与图表。 */
export function attachSimulationToSpec(
  spec: ProjectSpec,
  sim: SimulationArtifact,
): ProjectSpec {
  return {
    ...spec,
    simulation: {
      purpose: sim.purpose,
      methodology: sim.output.methodology,
      disclaimer: sim.output.disclaimer,
      metrics: sim.output.metrics,
      tables: sim.output.tables,
      chartIds: sim.charts.map((c) => c.id),
    },
  };
}

/** 从已通过验收的主文档正文中确定性地抽取章节结构、关键数值/参数行与核心摘要（零额外模型调用）。 */
export function extractPrimaryDigest(
  sourceTaskId: string,
  title: string,
  markdown: string,
): PrimaryWorkDigest {
  const lines = markdown.split(/\r?\n/);
  const headings = lines
    .map((l) => /^#{1,3}\s+(.+)$/.exec(l.trim())?.[1]?.replace(/\*\*/g, "").trim())
    .filter((x): x is string => !!x)
    .slice(0, 18);

  const keyFigures: string[] = [];
  const seen = new Set<string>();
  const numPattern =
    /(?:\d+(?:\.\d+)?)\s*(?:元|万元|%|ms|s|Hz|kHz|MHz|GHz|mm|cm|m|km|g|kg|W|mW|V|mA|dB|lx|K|GB|MB|KB|小时|天|人|台|次|倍)/;
  for (const raw of lines) {
    const clean = raw.replace(/\*\*/g, "").trim();
    if (!clean || clean.startsWith("#") || clean.length > 140 || !numPattern.test(clean))
      continue;
    const key = clean.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    keyFigures.push(clean);
    if (keyFigures.length >= 16) break;
  }

  const bodyLines = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```") && !l.startsWith("---"));
  const summaryExcerpt = bodyLines.join("\n").slice(0, 1800);

  return { sourceTaskId, title, headings, keyFigures, summaryExcerpt };
}

/** 构造注入各制作任务的“项目单一事实源”提示片段，保证跨文件数值、术语与视觉风格统一。 */
export function projectSpecPrompt(
  spec: ProjectSpec | undefined,
  taskKind: "document" | "translation" | "slides" | "spreadsheet" | "image" | "software",
): string {
  if (!spec || taskKind === "translation") return "";
  const parts: string[] = [];
  if (spec.simulation) {
    parts.push(
      `已通过本地沙箱实算的数值仿真结果（精确数字可直接引用，必须注明为数值仿真/模型测算，不得改篡或冒充真人实测；对应图表可用图片引用 ${spec.simulation.chartIds.join("、") || "无"}）：${JSON.stringify({
        purpose: spec.simulation.purpose,
        methodology: spec.simulation.methodology,
        metrics: spec.simulation.metrics,
        tables: spec.simulation.tables,
      })}`,
    );
  }
  if (spec.primaryWork && taskKind !== "image") {
    parts.push(
      `已定稿主文档《${spec.primaryWork.title}》单一事实源（请严格保持项目名、核心参数、BOM/指标数字与主文档完全一致，不得出现跨文件数值冲突）：章节=${JSON.stringify(spec.primaryWork.headings)}；关键量化参数=${JSON.stringify(spec.primaryWork.keyFigures)}；核心内容摘录=${spec.primaryWork.summaryExcerpt.slice(0, 1200)}`,
    );
  }
  if (taskKind === "slides") {
    parts.push(`推荐统一 PPT 视觉主题 theme="${spec.theme}"。`);
  }
  return parts.length ? `\n【跨交付物单一事实源（Project Spec）】\n${parts.join("\n")}\n` : "";
}
