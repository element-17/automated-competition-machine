import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
/** 输入只包含可序列化数据；对象键顺序不影响任务身份。 */
export function taskInputHash(task: unknown, context: unknown): string {
  return sha256(
    JSON.stringify(sorted(JSON.parse(JSON.stringify({ task, context })))),
  );
}

const Receipt = z.object({
  version: z.literal(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .default([]),
});
export type TaskReceipt = z.infer<typeof Receipt>;

async function checkedFile(
  path: string,
  root: string,
): Promise<{ absolute: string; relative: string }> {
  const base = resolve(root),
    absolute = resolve(path),
    rel = relative(base, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw Error("产物路径超出任务目录");
  let cursor = base;
  const rootStat = await lstat(cursor);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw Error("任务目录不是普通目录");
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw Error("产物或父目录包含符号链接");
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
      throw Error("产物路径不是普通文件");
  }
  return { absolute, relative: rel.split(sep).join("/") };
}

export async function createTaskReceipt(
  task: unknown,
  context: unknown,
  artifactPaths: string[],
  root: string,
): Promise<TaskReceipt> {
  const files = [];
  for (const path of artifactPaths) {
    const file = await checkedFile(path, root);
    files.push({
      path: file.relative,
      sha256: sha256(await readFile(file.absolute)),
    });
  }
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw Error("产物路径重复");
  if (files.length === 0) throw Error("没有实际产物，不能生成完成收据");
  return Receipt.parse({
    version: 1,
    inputHash: taskInputHash(task, context),
    files,
  });
}

/** 恢复时核对输入与真实文件；旧记录没有收据时重新执行，绝不只信完成标记。 */
export async function checkTaskReceipt(
  receipt: unknown,
  task: unknown,
  context: unknown,
  artifactPaths: string[],
  root: string,
): Promise<{ valid: boolean; reason?: string }> {
  const parsed = Receipt.safeParse(receipt);
  if (!parsed.success) return { valid: false, reason: "缺少有效产物收据" };
  if (parsed.data.inputHash !== taskInputHash(task, context))
    return { valid: false, reason: "任务输入已变化" };
  try {
    const actual = await createTaskReceipt(task, context, artifactPaths, root);
    if (JSON.stringify(actual.files) !== JSON.stringify(parsed.data.files))
      return { valid: false, reason: "产物路径或内容已变化" };
    return { valid: true };
  } catch (e) {
    return {
      valid: false,
      reason: `产物不可核验：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** 同目录 rename 防止进程中断留下半份恢复记录。 */
export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
