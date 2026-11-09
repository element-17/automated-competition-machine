import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Runner = (command: string, args: string[]) => Promise<unknown>;
const run: Runner = (command, args) =>
  exec(command, args, {
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 2_000_000,
  });

/** Render actual PPTX pages with established office and PDF tools, when installed. */
export async function previewSlides(
  file: string,
  expected: number,
  runner: Runner = run,
) {
  const base = resolve(dirname(file), "previews");
  await mkdir(base, { recursive: true });
  const folder = await mkdtemp(join(base, "render-"));
  const pdf = join(folder, `${basename(file, ".pptx")}.pdf`);
  try {
    await runner(process.env.COMPETE_SOFFICE || "soffice", [
      `-env:UserInstallation=${pathToFileURL(join(folder, "office-profile")).href}`,
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      folder,
      resolve(file),
    ]);
    await runner(process.env.COMPETE_PDFTOPPM || "pdftoppm", [
      "-png",
      "-r",
      "110",
      pdf,
      join(folder, "slide"),
    ]);
    const pages = (await readdir(folder))
      .filter((x) => /^slide-\d+\.png$/.test(x))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
      .map((x) => join(folder, x));
    if (pages.length !== expected)
      throw Error(`渲染得到 ${pages.length} 页，预期 ${expected} 页`);
    return { status: "rendered" as const, pages };
  } catch (e) {
    return {
      status: "unavailable" as const,
      pages: [] as string[],
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
