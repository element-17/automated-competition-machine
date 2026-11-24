/**
 * 定量计算与数值仿真沙箱：针对工科、算法、数据分析、创新创业与财务测算类比赛，
 * 在隔离目录执行纯数学/建模脚本（优先 Python，不可用时自动退回 Node.js），
 * 产出 100% 可复现的精确指标、数据表与高清科研图表，并严格标注为“数值仿真/模型测算”，
 * 彻底取代模型纸面口算参数。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Brief, ModelGateway } from "../core/types.js";
import { parseJSON } from "../core/gateway.js";
import { ChartSpec, renderChartPng } from "./diagrams.js";

const exec = promisify(execFile);

export const SimulationScript = z.object({
  language: z.enum(["python", "javascript"]).default("python"),
  purpose: z.string().trim().min(1).max(400),
  code: z.string().min(20).max(20_000),
});
export type SimulationScript = z.infer<typeof SimulationScript>;

export const SimulationOutput = z.object({
  methodology: z.string().trim().min(1).max(1000),
  disclaimer: z
    .string()
    .trim()
    .default("以下结果均由本地可复现数值仿真/数学模型计算得出，不代表真人或实地实测数据"),
  metrics: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        value: z.union([z.number(), z.string()]),
        unit: z.string().trim().max(32).default(""),
        basis: z.string().trim().max(200).default(""),
      }),
    )
    .min(1)
    .max(30),
  tables: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(100),
        headers: z.array(z.string().trim().min(1).max(50)).min(2).max(10),
        rows: z.array(z.array(z.string().max(120)).min(2).max(10)).min(1).max(40),
      }),
    )
    .max(6)
    .default([]),
  charts: z.array(ChartSpec).max(4).default([]),
});
export type SimulationOutput = z.infer<typeof SimulationOutput>;

export type SimulationArtifact = {
  scriptPath: string;
  reportPath: string;
  language: "python" | "javascript";
  purpose: string;
  output: SimulationOutput;
  charts: { id: string; title: string; path: string; caption: string }[];
};

const forbiddenPatterns: [RegExp, string][] = [
  [/\b(?:subprocess|shutil|socket|urllib|requests|http\.client|ftplib|ctypes|paramiko|webbrowser|pty)\b/, "禁止网络或系统进程模块"],
  [/\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|rename)\b/, "禁止危险系统调用"],
  [/\b(?:child_process|node:http|node:https|node:net|node:dgram|node:tls|node:fs|fs\/promises)\b/, "禁止 Node 系统/网络/文件模块"],
  [/\bfetch\s*\(|\b(?:XMLHttpRequest|WebSocket)\b/, "禁止外部网络请求"],
  [/\b__import__\b|\b(?:exec|eval)\s*\(|\bopen\s*\([^)]*['"][wa]/, "禁止动态执行或写外部文件"],
];

/** 静态安全检查：只允许纯数值计算、统计建模与标准输出 JSON。 */
export function assertSafeSimulationCode(code: string): void {
  for (const [re, reason] of forbiddenPatterns) {
    if (re.test(code)) throw Error(`仿真脚本安全检查未通过：${reason}`);
  }
}

let cachedPython: string | null | undefined;
export async function detectPython(): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython;
  for (const bin of process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]) {
    try {
      await exec(bin, ["--version"], { timeout: 5_000, windowsHide: true });
      cachedPython = bin;
      return bin;
    } catch { /* 尝试下一个可执行名 */ }
  }
  cachedPython = null;
  return null;
}

/** 仅在工程/算法/数据/创客/商业计划等需要定量论证的比赛中触发仿真，纯文学/翻译/纯海报错开。 */
export function needsSimulation(brief: Brief, idea: { title?: string; mechanism?: string; problem?: string } | null): boolean {
  const text = [
    brief.title,
    brief.scoring || "",
    ...brief.deliverables.map((d) => d.type),
    idea?.title || "",
    idea?.problem || "",
    idea?.mechanism || "",
  ].join(" ");
  if (/翻译|诗歌|散文|小说|征文|书法|绘画|摄影|微电影|短片/.test(brief.title) &&
      !/算法|模型|仿真|数据|工程|硬件|创业|商业计划|挑战杯|创客|设计大赛/.test(text))
    return false;
  return /技术方案|算法|模型|仿真|建模|数据分析|机器学习|深度学习|人工智能|智能硬件|物联网|嵌入式|雷达|传感器|电路|机械|结构|创客|挑战杯|互联网\+|创业计划|商业计划|财务|BOM|能耗|效率|优化|数学建模/i.test(
    text,
  );
}

/** 在隔离临时目录运行仿真脚本并解析严格 JSON 输出（不传递任何 API 密钥环境变量）。 */
export async function runSimulationScript(
  script: SimulationScript,
  outputFolder: string,
): Promise<SimulationArtifact> {
  assertSafeSimulationCode(script.code);
  const py = script.language === "python" ? await detectPython() : null;
  if (script.language === "python" && !py)
    throw Error("本机未检测到 Python 解释器，请改用 javascript 语言编写计算脚本");

  const runDir = await mkdtemp(join(tmpdir(), "sim-run-"));
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "",
    SYSTEMROOT: process.env.SYSTEMROOT || "",
    TEMP: runDir,
    TMP: runDir,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  const ext = script.language === "python" ? "py" : "mjs";
  const tmpScript = join(runDir, `simulate.${ext}`);
  await writeFile(tmpScript, script.code, "utf8");

  let stdout = "";
  try {
    const res =
      script.language === "python"
        ? await exec(py!, [tmpScript], {
            cwd: runDir,
            env: safeEnv,
            timeout: 25_000,
            maxBuffer: 2_000_000,
            windowsHide: true,
          })
        : await exec(process.execPath, [tmpScript], {
            cwd: runDir,
            env: safeEnv,
            timeout: 25_000,
            maxBuffer: 2_000_000,
            windowsHide: true,
          });
    stdout = res.stdout.trim();
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || e).slice(0, 800);
    throw Error(`仿真脚本执行失败：${stderr}`);
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!stdout) throw Error("仿真脚本没有在标准输出打印任何 JSON 结果");
  const output = SimulationOutput.parse(parseJSON(stdout));

  await mkdir(outputFolder, { recursive: true });
  const scriptPath = join(outputFolder, `simulation.${ext}`);
  await writeFile(scriptPath, script.code, "utf8");

  const charts: SimulationArtifact["charts"] = [];
  for (const [idx, chart] of output.charts.entries()) {
    const id = `sim-chart-${idx + 1}`;
    const png = await renderChartPng({
      ...chart,
      source: chart.source || "数据来源：本地数值仿真模型计算",
    });
    const path = join(outputFolder, `${id}.png`);
    await writeFile(path, png.data);
    charts.push({
      id,
      title: chart.title,
      path,
      caption: `${chart.title}（数值仿真结果）`,
    });
  }

  const reportPath = join(outputFolder, "simulation-report.json");
  const report = {
    purpose: script.purpose,
    language: script.language,
    scriptPath,
    output,
    charts,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return {
    scriptPath,
    reportPath,
    language: script.language,
    purpose: script.purpose,
    output,
    charts,
  };
}

/** 结合赛题与方案，让模型编写纯计算仿真脚本并在沙箱执行（失败自动修复 1 次）。 */
export async function generateAndRunSimulation(
  gateway: ModelGateway,
  input: {
    brief: Brief;
    idea: unknown;
    evidenceSummary?: string;
  },
  outputFolder: string,
): Promise<SimulationArtifact> {
  const py = await detectPython();
  const lang = py ? "python" : "javascript";
  const basePrompt = `任务：为以下高校竞赛方案编写一段纯数学/工程/财务数值仿真与计算脚本，通过实际运行得出 100% 可复现的定量指标、明细表和图表数据，取代纸面估算。
要求：
1. 语言使用 ${lang}，只允许标准库数学/统计/JSON 模块（${lang === "python" ? "math/statistics/random/json" : "Math/JSON"}），禁止任何网络、subprocess、文件读写或外部依赖。
2. 严禁虚构真人实验或实地调查数据；所有计算必须基于公开物理公式、明确设定的设计参数（如 BOM 单价核算、功耗续航模型、蒙特卡洛参数敏感性分析、排队/调度仿真、盈亏平衡与财务现金流测算），并在 disclaimer 明确标注为数值仿真结果。
3. 脚本必须将最终结果以单个 JSON 对象打印到 stdout，结构为：
   {"methodology":"计算模型与参数设定说明","disclaimer":"数值仿真声明","metrics":[{"name":"指标名","value":数值或字符串,"unit":"单位","basis":"公式或设定依据"}],"tables":[{"title":"表名","headers":["列1","列2"],"rows":[["值1","值2"]]}],"charts":[{"type":"bar|horizontal-bar|line|pie|donut|radar","title":"图表标题","subtitle":"副标题","yLabel":"纵轴","unit":"单位","labels":["A","B","C"],"series":[{"name":"系列名","values":[1,2,3]}]}]}
4. 至少计算 4 项核心定量指标、1 张结构化表格（如 BOM 成本/性能参数对比/财务预测）、1-2 张有信息量的科研/分析图表（charts）。
5. 只输出 JSON：{"language":"${lang}","purpose":"本次仿真要验证的核心定量问题","code":"完整可执行代码"}。
赛事档案：${JSON.stringify({ title: input.brief.title, scoring: input.brief.scoring, deliverables: input.brief.deliverables.map((d) => d.type) })}
选定方案：${JSON.stringify(input.idea)}
${input.evidenceSummary ? `已有事实线索：${input.evidenceSummary}` : ""}`;

  let lastErr = "";
  let prevCode = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = lastErr
      ? `${basePrompt}\n\n上次生成的仿真脚本运行失败，请修复后输出完整 JSON：\n错误：${lastErr}\n上次代码：\n${prevCode}`
      : basePrompt;
    const raw = await gateway.generate("writer", prompt, "writer");
    const script = SimulationScript.parse(parseJSON(raw));
    prevCode = script.code;
    try {
      return await runSimulationScript(script, outputFolder);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === 1) throw e;
    }
  }
  throw Error("数值仿真未完成");
}
