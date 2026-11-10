import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import type { Store } from "../core/store.js";
import { atomicWriteJson } from "./task-receipts.js";
import { guards } from "../agents/prompts.js";

/** 来源正文的防注入约束；其他材料类型（搜索摘要、公告网页）直接用 guards 中对应的条目。 */
export const Guard = guards.evidence;
export const Idea = z.object({
  title: z.string().min(1),
  audience: z.string().min(1),
  problem: z.string().min(1),
  mechanism: z.string().min(1),
  verification: z.string().min(1),
  evidence_urls: z.array(z.string()).default([]),
});
export type Idea = z.infer<typeof Idea>;
/**
 * 只有全部验收通过才算产出。任何不满足要求的情况都必须抛错，
 * 不再用"草稿""辅助材料""阻塞"这类状态把失败包装成有产物。
 * 旧任务记录里的历史状态仍可在 job-view 中读取。
 */
export type DeliverableStatus = "submission";
export type DeliverableResult = {
  type: string;
  requestedFormats: string[];
  status: DeliverableStatus;
  artifactPaths: string[];
  gaps: string[];
  checks?: {
    id: string;
    status: "passed" | "failed" | "unverified";
    details: string[];
  }[];
};

export function contents(store: Store, id: string) {
  return store
    .evidence(id)
    .map(({ url, title, kind, text }) => ({
      url,
      title,
      kind,
      text: text.slice(0, 12000),
    }));
}
export async function record(
  cfg: AppConfig,
  store: Store,
  jobId: string,
  name: string,
  value: unknown,
  model: string | null,
) {
  const folder = join(cfg.dataDir, "jobs", jobId);
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  if (typeof value === "string") await writeFile(path, value, "utf8");
  else await atomicWriteJson(path, value);
  store.artifact(jobId, name, path, model);
  return path;
}
/** 结果已存在于任务目录时直接读取，用于断点恢复时跳过已完成的模型调用。 */
export async function cached<T>(
  cfg: AppConfig,
  store: Store,
  jobId: string,
  name: string,
  schema: z.ZodType<T>,
  model: string | null,
  produce: () => Promise<unknown>,
): Promise<T> {
  const path = join(cfg.dataDir, "jobs", jobId, name);
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const result = schema.parse(await produce());
  await record(cfg, store, jobId, name, result, model);
  return result;
}
/** 错误信息中模型原文之前的部分；解析失败的错误会附带模型原文，原文里出现"预算""上限"等字样不能当作任务控制信号。 */
export const errorHead = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const i = m.search(/原始内容如下|--- 模型原始返回开始/);
  return i >= 0 ? m.slice(0, i) : m;
};
/** 预算耗尽：中止任务并保留检查点，调整预算后可恢复。 */
export const budgetError = (e: unknown) => /预算|上限/.test(errorHead(e));
