import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const Config = z.object({
  dataDir: z.string().default('./data'),
  opencodeUrl: z.string().url().default('http://127.0.0.1:4096'),
  writer: z.object({ providerID: z.literal('google'), id: z.string().regex(/^gemini[-.]/i, '写作模型必须明确为 Gemini') }),
  reviewer: z.object({ providerID: z.string().min(1), id: z.string().min(1) }),
  maxCalls: z.number().int().min(1).default(12),
  searchProvider: z.string().min(1).default('tinyfish'),
  sources: z.array(z.string().url()).default([]),
  profile: z.object({ school: z.string().optional(), identity: z.string().optional() }).default({})
}).refine(x => x.reviewer.providerID !== x.writer.providerID, '第二模型必须来自不同提供商');
export type AppConfig = z.infer<typeof Config>;
export function loadConfig(path = process.env.COMPETE_CONFIG || 'config/config.json'): AppConfig {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const result = Config.parse({ writer: { providerID: 'google', id: process.env.GEMINI_MODEL || 'gemini-2.5-pro' }, reviewer: { providerID: 'anthropic', id: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5' }, ...raw, ...(process.env.COMPETE_DATA_DIR ? {dataDir: process.env.COMPETE_DATA_DIR} : {}), ...(process.env.OPENCODE_URL ? {opencodeUrl: process.env.OPENCODE_URL} : {}) });
  result.dataDir = resolve(result.dataDir); mkdirSync(result.dataDir, { recursive: true }); return result;
}
