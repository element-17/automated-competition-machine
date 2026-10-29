import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Config = z.object({
  dataDir: z.string().default('./data'),
  writer: z.object({ providerID: z.literal('google'), id: z.string().regex(/^gemini[-.]/i, '写作模型必须明确为 Gemini') }),
  reviewer: z.object({ providerID: z.enum(['anthropic','deepseek']), id: z.string().min(1) }),
  image: z.object({ providerID: z.literal('google'), id: z.string().min(1) }).default({providerID:'google',id:'gemini-2.5-flash-image'}),
  coder: z.object({id:z.string().min(1)}).default({id:'gpt-5.4'}),
  researchAgent: z.object({enabled:z.boolean().default(true),maxTurns:z.number().int().min(1).max(10).default(4),maxBudgetUsd:z.number().positive().default(1)}).default({enabled:true,maxTurns:4,maxBudgetUsd:1}),
  search: z.object({provider:z.enum(['brave','searxng']).default('brave'),url:z.string().url().optional()}).default({provider:'brave'}),
  maxCalls: z.number().int().min(1).default(12),
  sources: z.array(z.string().url()).default([]),
  profile: z.object({ school: z.string().optional(), identity: z.string().optional() }).default({})
}).refine(x=>x.reviewer.providerID!=='deepseek'||!x.researchAgent.enabled,{message:'DeepSeek 评审模式下请关闭 Claude 研究 Agent（researchAgent.enabled=false）'});
export type AppConfig = z.infer<typeof Config>;
export function loadConfig(path = process.env.COMPETE_CONFIG || 'config/config.json'): AppConfig {
  const localEnv=fileURLToPath(new URL('../.env',import.meta.url));if(existsSync(localEnv))process.loadEnvFile(localEnv);
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const result = Config.parse({ writer: { providerID: 'google', id: process.env.GEMINI_MODEL || 'gemini-2.5-pro' }, reviewer: { providerID: 'anthropic', id: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5' }, ...raw, ...(process.env.COMPETE_DATA_DIR ? {dataDir: process.env.COMPETE_DATA_DIR} : {}) });
  result.dataDir = resolve(result.dataDir); mkdirSync(result.dataDir, { recursive: true }); return result;
}
