import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { agents, type AgentName } from "../agents/prompts.js";
import {
  AgentSettings,
  Provider,
  envPath,
  modelProblems,
  resolveAgent,
  type ModelConfig,
} from "../agents/models.js";

export const timeRanges = ["any", "day", "week", "month", "year"] as const;
/** 搜索与发现参数；未写入配置文件的字段使用这里的默认值。 */
const Search = z.object({
  provider: z.enum(["brave", "searxng", "sources"]).default("brave"),
  url: z.string().url().optional(),
  pages: z.number().int().min(1).max(5).default(2),
  timeRange: z.enum(timeRanges).default("year"),
  language: z.string().default("zh-CN"),
  perHost: z.number().int().min(1).max(50).default(4),
  queriesPerRun: z.number().int().min(1).max(30).default(8),
  queries: z.array(z.string().trim().min(1)).default([]),
  screen: z.boolean().default(true),
});
export type SearchSettings = z.infer<typeof Search>;
export const searchDefaults: SearchSettings = Search.parse({});
export const searchSettings = (cfg: {
  search?: Partial<SearchSettings>;
}): SearchSettings => ({ ...searchDefaults, ...cfg.search });

const Execution = z.object({
  productionRounds: z.number().int().min(1).max(8).default(4),
  plannerRounds: z.number().int().min(1).max(5).default(3),
  researchRounds: z.number().int().min(1).max(6).default(3),
  requestTimeoutSeconds: z.number().int().min(30).max(1800).default(300),
  /** 一次模型调用最多尝试几次（含首次）；总时长上限 = 本次数 × requestTimeoutSeconds，重试共享该上限。 */
  requestAttempts: z.number().int().min(1).max(5).default(3),
});
export type ExecutionSettings = z.infer<typeof Execution>;
export const executionSettings = (cfg: {
  execution?: Partial<ExecutionSettings>;
}): ExecutionSettings => Execution.parse(cfg.execution || {});

const Legacy = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
});
const Config = z
  .object({
    dataDir: z.string().default("./data"),
    /** 供应商与各 Agent 的模型、运行时；见 models.ts。 */
    providers: z.array(Provider).default([]),
    agents: z.partialRecord(z.enum(agents), AgentSettings).default({}),
    /** 旧版字段，读取时转换为 agents；通过界面保存后会被移除。 */
    writer: Legacy.optional(),
    reviewer: Legacy.optional(),
    image: Legacy.optional(),
    coder: z.object({ id: z.string().min(1) }).optional(),
    researchAgent: z
      .object({
        enabled: z.boolean().optional(),
        maxTurns: z.number().int().min(1).max(10).optional(),
        maxBudgetUsd: z.number().positive().optional(),
      })
      .optional(),
    search: Search.prefault({}),
    execution: Execution.prefault({}),
    maxCalls: z.number().int().min(1).default(80),
    sources: z.array(z.string().url()).default([]),
    profile: z
      .object({
        school: z.string().optional(),
        identity: z.string().optional(),
      })
      .default({}),
    /** 覆盖各 Agent 的系统提示词；未填写的使用内置默认值。 */
    prompts: z
      .partialRecord(z.enum(agents), z.string().max(20_000))
      .default({}),
  })
  .superRefine((x, ctx) => {
    for (const message of structural(x))
      ctx.addIssue({ code: "custom", message });
  })
  .refine((x) => x.search.provider !== "searxng" || !!x.search.url, {
    message: "SearXNG 需要配置 search.url",
  });
/** 加载时只拦截供应商不存在等结构问题；协议与运行时不匹配在保存和调用时提示，避免一处配置错误让整个程序无法启动。 */
function structural(x: ModelConfig) {
  const out: string[] = [];
  for (const name of agents) {
    try {
      resolveAgent(x, name);
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (
    new Set((x.providers || []).map((p) => p.id)).size !==
    (x.providers || []).length
  )
    out.push("供应商 ID 重复");
  return out;
}
export type AppConfig = z.infer<typeof Config>;
export const configPath = (path?: string) =>
  path || process.env.COMPETE_CONFIG || "config/config.json";
export function loadConfig(path?: string): AppConfig {
  const localEnv = envPath();
  if (existsSync(localEnv)) process.loadEnvFile(localEnv);
  const file = configPath(path);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const result = Config.parse({
    ...raw,
    ...(process.env.COMPETE_DATA_DIR
      ? { dataDir: process.env.COMPETE_DATA_DIR }
      : {}),
  });
  result.dataDir = resolve(result.dataDir);
  mkdirSync(result.dataDir, { recursive: true });
  return result;
}
/** 只改写配置文件中给定的顶层字段，保留其余原始内容；校验通过后才写入。 */
function patchConfig(path: string | undefined, patch: Record<string, unknown>) {
  const file = configPath(path);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const next = { ...raw, ...patch };
  Config.parse(next);
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}
/** 保存供应商和全部 Agent 设置；同时移除已转换的旧版字段。协议或运行时不匹配时拒绝保存。 */
export function saveModels(
  path: string | undefined,
  providerList: Provider[],
  agentSettings: Partial<Record<AgentName, AgentSettings>>,
) {
  const problems = modelProblems({
    providers: providerList,
    agents: agentSettings,
  });
  if (problems.length) throw Error(problems.join("；"));
  const file = configPath(path);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const k of ["writer", "reviewer", "image", "coder", "researchAgent"])
    delete raw[k];
  Config.parse({ ...raw, providers: providerList, agents: agentSettings });
  writeFileSync(
    file,
    JSON.stringify(
      { ...raw, providers: providerList, agents: agentSettings },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
export const saveSearchConfig = (
  path: string | undefined,
  search: SearchSettings,
  sources: string[],
) => patchConfig(path, { search, sources });
export const saveExecutionConfig = (
  path: string | undefined,
  execution: ExecutionSettings,
  maxCalls: number,
) => patchConfig(path, { execution, maxCalls });
/** 写入单个 Agent 的系统提示词；text 为空时删除覆盖，恢复内置默认值。 */
export function savePrompt(
  path: string | undefined,
  agent: AgentName,
  text: string,
) {
  const file = configPath(path);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const prompts = { ...raw.prompts };
  if (text.trim()) prompts[agent] = text.trim();
  else delete prompts[agent];
  patchConfig(path, { prompts });
}
