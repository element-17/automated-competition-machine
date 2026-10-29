import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { agents, type AgentName } from './prompts.js';

export const timeRanges=['any','day','week','month','year'] as const;
/** 搜索与发现参数；未写入配置文件的字段使用这里的默认值。 */
const Search=z.object({
  provider:z.enum(['brave','searxng','sources']).default('brave'),
  url:z.string().url().optional(),
  pages:z.number().int().min(1).max(5).default(2),
  timeRange:z.enum(timeRanges).default('year'),
  language:z.string().default('zh-CN'),
  perHost:z.number().int().min(1).max(50).default(4),
  queriesPerRun:z.number().int().min(1).max(30).default(8),
  queries:z.array(z.string().trim().min(1)).default([]),
  screen:z.boolean().default(true),
});
export type SearchSettings=z.infer<typeof Search>;
export const searchDefaults:SearchSettings=Search.parse({});
export const searchSettings=(cfg:{search?:Partial<SearchSettings>}):SearchSettings=>({...searchDefaults,...cfg.search});

const Config = z.object({
  dataDir: z.string().default('./data'),
  writer: z.object({ providerID: z.literal('google'), id: z.string().regex(/^gemini[-.]/i, '写作模型必须明确为 Gemini') }),
  reviewer: z.object({ providerID: z.enum(['anthropic','deepseek']), id: z.string().min(1) }),
  image: z.object({ providerID: z.literal('google'), id: z.string().min(1) }).default({providerID:'google',id:'gemini-2.5-flash-image'}),
  coder: z.object({id:z.string().min(1)}).default({id:'gpt-5.4'}),
  researchAgent: z.object({enabled:z.boolean().default(true),maxTurns:z.number().int().min(1).max(10).default(4),maxBudgetUsd:z.number().positive().default(1)}).default({enabled:true,maxTurns:4,maxBudgetUsd:1}),
  search: Search.prefault({}),
  maxCalls: z.number().int().min(1).default(12),
  sources: z.array(z.string().url()).default([]),
  profile: z.object({ school: z.string().optional(), identity: z.string().optional() }).default({}),
  /** 覆盖各 Agent 的系统提示词；未填写的使用内置默认值。 */
  prompts: z.partialRecord(z.enum(agents),z.string().max(20_000)).default({})
}).refine(x=>x.reviewer.providerID!=='deepseek'||!x.researchAgent.enabled,{message:'DeepSeek 评审模式下请关闭 Claude 研究 Agent（researchAgent.enabled=false）'})
  .refine(x=>x.search.provider!=='searxng'||!!x.search.url,{message:'SearXNG 需要配置 search.url'});
export type AppConfig = z.infer<typeof Config>;
export const configPath=(path?:string)=>path||process.env.COMPETE_CONFIG||'config/config.json';
const defaults=()=>({ writer: { providerID: 'google', id: process.env.GEMINI_MODEL || 'gemini-2.5-pro' }, reviewer: { providerID: 'anthropic', id: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5' } });
export function loadConfig(path?: string): AppConfig {
  const localEnv=fileURLToPath(new URL('../.env',import.meta.url));if(existsSync(localEnv))process.loadEnvFile(localEnv);
  const file=configPath(path); const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const result = Config.parse({ ...defaults(), ...raw, ...(process.env.COMPETE_DATA_DIR ? {dataDir: process.env.COMPETE_DATA_DIR} : {}) });
  result.dataDir = resolve(result.dataDir); mkdirSync(result.dataDir, { recursive: true }); return result;
}
/** 只改写配置文件中给定的顶层字段，保留其余原始内容；校验通过后才写入。 */
function patchConfig(path:string|undefined,patch:Record<string,unknown>){
  const file=configPath(path);const raw=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};const next={...raw,...patch};
  Config.parse({...defaults(),...next});writeFileSync(file,JSON.stringify(next,null,2)+'\n','utf8');
}
export const saveSearchConfig=(path:string|undefined,search:SearchSettings,sources:string[])=>patchConfig(path,{search,sources});
/** 写入单个 Agent 的系统提示词；text 为空时删除覆盖，恢复内置默认值。 */
export function savePrompt(path:string|undefined,agent:AgentName,text:string){
  const file=configPath(path);const raw=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};const prompts={...raw.prompts};
  if(text.trim())prompts[agent]=text.trim();else delete prompts[agent];patchConfig(path,{prompts});
}
