/** 幻灯片预览：用 officecli 把 PPTX 逐页渲染成 PNG。失败一律抛错。 */
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const officecli = () => process.env.COMPETE_OFFICECLI || "officecli";

/** 读取 PPTX 实际页数；读不出来就抛错。 */
export async function slideCount(file: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await exec(officecli(), ["view", file, "stats"], {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 2_000_000,
    }));
  } catch (e) {
    throw Error(
      `无法用 officecli 读取 ${file} 的页数：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const m = /Slides:\s*(\d+)/i.exec(stdout);
  const n = m ? Number(m[1]) : 0;
  if (!n)
    throw Error(`无法从 officecli 输出中解析页数：${stdout.slice(0, 200)}`);
  return n;
}

/**
 * 渲染 PPTX 每一页为 PNG，并核对实际页数与生成时一致。
 * 任一页渲染失败即抛错：交付的演示文稿必须逐页看过。
 */
export async function previewSlides(
  file: string,
  expected: number,
): Promise<string[]> {
  const folder = join(resolve(dirname(file)), "previews");
  await mkdir(folder, { recursive: true });
  const total = await slideCount(file);
  if (total !== expected)
    throw Error(`PPT 实际 ${total} 页，与生成的 ${expected} 页不一致`);
  const pages: string[] = [];
  for (let page = 1; page <= total; page++) {
    const out = join(folder, `slide-${page}.png`);
    try {
      await exec(
        officecli(),
        [
          "view",
          file,
          "screenshot",
          "--page",
          String(page),
          "--screenshot-width",
          "1600",
          "-o",
          out,
        ],
        { timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000 },
      );
      const data = await readFile(out);
      if (!data.length) throw Error("渲染结果为空");
      pages.push(out);
    } catch (e) {
      await unlink(out).catch(() => {});
      throw Error(
        `渲染 ${file} 第 ${page}/${total} 页失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // 关闭常驻进程，释放文件句柄，避免后续覆盖或清理失败。
  await exec(officecli(), ["close", file], {
    timeout: 30_000,
    windowsHide: true,
  }).catch(() => {});
  return pages;
}
