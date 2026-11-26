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
  /** 是否在研究提示词中拼接社交平台（小红书/B站/知乎等）site: 查询；默认关闭避免登录后抓空。 */
  socialPlatforms: z.boolean().default(false),
});
export type SearchSettings = z.infer<typeof Search>;
export const searchDefaults: SearchSettings = Search.parse({});
export const searchSettings = (cfg: {
  search?: Partial<SearchSettings>;
}): SearchSettings => ({ ...searchDefaults, ...cfg.search });

/** 作品冲奖质量控制参数：评委打分卡、定向精修、定量数值仿真与可选人机确认点。 */
const Quality = z.object({
  rubricScoring: z.boolean().default(true),
  minScore: z.number().int().min(50).max(98).default(82),
  polishRounds: z.number().int().min(0).max(3).default(1),
  simulation: z.boolean().default(true),
  interactiveGates: z.boolean().default(false),
});
export type QualitySettings = z.infer<typeof Quality>;
export const qualityDefaults: QualitySettings = Quality.parse({});
export const qualitySettings = (cfg: {
  quality?: Partial<QualitySettings>;
}): QualitySettings => Quality.parse(cfg.quality || {});

/** 内置后台浏览器与 Computer-Use 配置；默认无头运行，不占用用户鼠标或焦点。 */
const BrowserConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoFallback: z.boolean().default(true),
  downloadAttachments: z.boolean().default(true),
  headless: z.boolean().default(true),
  useVision: z.boolean().default(true),
  maxSteps: z.number().int().min(3).max(40).default(14),
});
export type BrowserSettings = z.infer<typeof BrowserConfigSchema>;
export const browserSettings = (cfg: {
  browser?: Partial<BrowserSettings>;
}): BrowserSettings => BrowserConfigSchema.parse(cfg.browser || {});

/** 多通道交付配置（邮箱 SMTP / 浏览器自动填表上传）；密钥均存放在 .env 环境变量中。 */
const EmailDeliverySchema = z.object({
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(465),
  secure: z.boolean().default(true),
  user: z.string().optional(),
  from: z.string().optional(),
  passwordEnv: z.string().default("SMTP_PASS"),
  maxAttachmentMb: z.number().min(1).max(100).default(25),
});
const DeliveryConfigSchema = z.object({
  defaultChannel: z.enum(["auto", "email", "browser"]).default("auto"),
  confirmBeforeSubmit: z.boolean().default(true),
  email: EmailDeliverySchema.prefault({}),
});
export type DeliverySettings = z.infer<typeof DeliveryConfigSchema>;
export const deliverySettings = (cfg: {
  delivery?: Partial<DeliverySettings>;
}): DeliverySettings => DeliveryConfigSchema.parse(cfg.delivery || {});

const Execution = z.object({
  productionRounds: z.number().int().min(1).max(8).default(4),
  plannerRounds: z.number().int().min(1).max(5).default(3),
  researchRounds: z.number().int().min(1).max(6).default(3),
  requestTimeoutSeconds: z.number().int().min(30).max(1800).default(300),
  /** 一次模型调用最多尝试几次（含首次）；总时长上限 = 本次数 × requestTimeoutSeconds，重试共享该上限。 */
  requestAttempts: z.number().int().min(1).max(5).default(3),
  /**
   * 单次调用允许的最大输出 token。长篇作品（小说、报告）常超过 8k 被截断，
   * 这里是下限保护：写作/研究类默认给足，模型或供应商上限更低时以其自身限制为准。
   */
  maxOutputTokens: z.number().int().min(1024).max(200_000).default(32_000),
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
    quality: Quality.prefault({}),
    browser: BrowserConfigSchema.prefault({}),
    delivery: DeliveryConfigSchema.prefault({}),
    maxCalls: z.number().int().min(1).default(80),
    sources: z.array(z.string().url()).default([]),
    profile: z
      .object({
        school: z.string().optional(),
        college: z.string().optional(),
        major: z.string().optional(),
        identity: z.string().optional(),
        grade: z.string().optional(),
        className: z.string().optional(),
        studentId: z.string().optional(),
        idNumber: z.string().optional(),
        name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        qq: z.string().optional(),
        advisor: z.string().optional(),
        advisorPhone: z.string().optional(),
        advisorEmail: z.string().optional(),
        advisorDepartment: z.string().optional(),
        advisorTitle: z.string().optional(),
        teamName: z.string().optional(),
        members: z
          .array(
            z.object({
              name: z.string().optional(),
              studentId: z.string().optional(),
              idNumber: z.string().optional(),
              phone: z.string().optional(),
              major: z.string().optional(),
            }),
          )
          .optional(),
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
export const saveBrowserConfig = (
  path: string | undefined,
  browser: BrowserSettings,
) => patchConfig(path, { browser });
export const saveDeliveryConfig = (
  path: string | undefined,
  delivery: DeliverySettings,
) => patchConfig(path, { delivery });
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
