import { mkdir, writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load } from "cheerio";
import JSZip from "jszip";
import { z } from "zod";
import type { ModelGateway } from "../core/types.js";

const execFileAsync = promisify(execFile);
export const InterfaceCopy = z.object({
  title: z.string().min(1),
  strings: z.record(z.string(), z.string()),
});
export type InterfaceCopy = z.infer<typeof InterfaceCopy>;
function hash(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
async function files(base: string, relative = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const name of await readdir(join(base, relative))) {
    if (name === ".opencode" || name === "node_modules" || name.startsWith("."))
      continue;
    const rel = join(relative, name);
    const st = await lstat(join(base, rel));
    if (st.isSymbolicLink()) throw Error("软件作品包含符号链接，无法校验");
    if (st.isDirectory()) paths.push(...(await files(base, rel)));
    else if (st.isFile()) {
      if (st.size > 2_000_000) throw Error("软件作品文件过大");
      paths.push(rel);
    }
  }
  return paths;
}

/** 软件作品的文件结构检查：入口存在、JS 语法通过、无符号链接、数量和体积受限。 */
async function checkWorkspace(workspace: string) {
  const paths = await files(workspace);
  if (!paths.length) throw Error("代码 Agent 没有生成任何文件");
  if (paths.length > 200) throw Error("软件作品文件数量过多");
  if (!paths.some((p) => p.replace(/\\/g, "/") === "index.html"))
    throw Error("代码 Agent 没有生成 index.html 入口");
  for (const path of paths.filter((p) =>
    [".js", ".mjs"].includes(extname(p).toLowerCase()),
  ))
    await execFileAsync(process.execPath, ["--check", join(workspace, path)], {
      timeout: 15_000,
      windowsHide: true,
    });
  return paths;
}
export type SoftwareSpec = {
  brief: unknown;
  idea: unknown;
  task: { title: string; instructions: string; acceptance: string[] };
  feedback?: string[];
};
/** 编码 Agent 依据任务说明完整制作软件作品（含界面文字和 README）；feedback 为评审意见，用于在同一工作区返工。 */
export async function buildSoftware(
  gateway: ModelGateway,
  spec: SoftwareSpec,
  format: "zip" | "html",
  outputFolder: string,
): Promise<string> {
  if (!gateway.buildProject) throw Error("当前执行器不支持代码 Agent");
  const workspace = join(outputFolder, "workspace");
  await mkdir(workspace, { recursive: true });
  const rules = `制作一个可直接在浏览器打开、离线可运行的完整软件作品，入口为 index.html。${format === "html" ? "所有 CSS 和 JS 必须内嵌在 index.html 中，不依赖其他文件。" : "可以拆分为多个本地 CSS/JS 文件，并写一份 README.md 说明功能、使用方法和技术实现。"}界面使用规范中文，功能完整可操作，而不是只有静态说明页。不得依赖在线资源或外部服务，不调用 shell 或网络。演示数据必须明确标注为示例，不得伪造用户数、调查或实验结果。`;
  const prompt = `${rules}\n作品任务：${spec.task.title}\n制作要求：${spec.task.instructions}\n验收标准：${JSON.stringify(spec.task.acceptance)}\n竞赛要求：${JSON.stringify(spec.brief)}\n选定方案：${JSON.stringify(spec.idea)}${spec.feedback?.length ? `\n上一版未通过评审，请在本工作区重新制作完整作品并解决：\n${spec.feedback.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : ""}`;
  await gateway.buildProject(workspace, prompt);
  const paths = await checkWorkspace(workspace);
  await mkdir(outputFolder, { recursive: true });
  if (format === "html") {
    const $ = load(await readFile(join(workspace, "index.html"), "utf8"));
    if ($('script[src],link[rel="stylesheet"][href]').length)
      throw Error("HTML 存在外部依赖，不能按单个 HTML 文件交付");
    const out = join(outputFolder, "submission.html");
    await writeFile(out, $.html(), "utf8");
    return out;
  }
  const zip = new JSZip();
  for (const path of paths)
    zip.file(path.replace(/\\/g, "/"), await readFile(join(workspace, path)));
  const out = join(outputFolder, "submission.zip");
  await writeFile(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}
/** 供评审读取的软件作品摘要：文件清单、README 与入口页片段。 */
export async function softwareDigest(outputFolder: string): Promise<string> {
  const workspace = join(outputFolder, "workspace");
  const paths = await files(workspace);
  const read = async (p: string) => {
    try {
      return (await readFile(join(workspace, p), "utf8")).slice(0, 6000);
    } catch {
      return "";
    }
  };
  return `文件：${JSON.stringify(paths)}\nREADME.md：\n${await read("README.md")}\nindex.html：\n${await read("index.html")}`;
}

/** 使用编码 Agent；实际运行仍需后续沙箱验收。 */
export async function makeSoftware(
  gateway: ModelGateway,
  copy: InterfaceCopy,
  brief: unknown,
  idea: unknown,
  format: "zip" | "html",
  outputFolder: string,
): Promise<string> {
  if (!gateway.buildProject) throw Error("当前执行器不支持代码 Agent");
  const workspace = join(outputFolder, "workspace");
  await mkdir(workspace, { recursive: true });
  const copySource = `window.COMPETITION_COPY = ${JSON.stringify(copy).replace(/</g, "\\u003c")};\n`;
  await writeFile(join(workspace, "copy.js"), copySource, "utf8");
  const prompt = `请依据比赛要求制作可运行、无服务器依赖的静态网页软件原型。用户可见文案全部来自当前目录 copy.js 中的 window.COMPETITION_COPY，不得重写 copy.js，不得写入新的用户可见文案。生成 index.html；必须用 <script src="copy.js"></script> 引用文案。${format === "html" ? "所有 CSS 和业务 JS 必须内嵌在 index.html，除了 copy.js 不依赖其他文件。" : "可使用本地 CSS/JS 文件，但不得依赖在线资源或外部服务。"}不要调用 shell 或外部网络。竞赛要求：${JSON.stringify(brief)}；方案：${JSON.stringify(idea)}。`;
  await gateway.buildProject(workspace, prompt);
  if (
    hash(await readFile(join(workspace, "copy.js"), "utf8")) !==
    hash(copySource)
  )
    throw Error("代码 Agent 修改了写作 Agent 文案，已阻止导出");
  let html: string;
  try {
    html = await readFile(join(workspace, "index.html"), "utf8");
  } catch {
    throw Error("代码 Agent 没有生成 index.html");
  }
  const $ = load(html);
  const script = $("script[src]")
    .toArray()
    .find((el) => /^(\.\/)?copy\.js$/.test($(el).attr("src") || ""));
  if (!script) throw Error("网页没有引用写作 Agent 文案 copy.js");
  const visible = $("body").clone();
  visible.find("script,style,noscript").remove();
  if (visible.text().trim())
    throw Error("网页包含未经过写作 Agent 生成的静态可见文字，已阻止导出");
  const paths = await files(workspace);
  for (const path of paths.filter((p) => extname(p).toLowerCase() === ".js"))
    await execFileAsync(process.execPath, ["--check", join(workspace, path)], {
      timeout: 15_000,
      windowsHide: true,
    });
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(outputFolder, { recursive: true }),
  );
  if (format === "html") {
    $(script).replaceWith(
      `<script>${copySource.replace(/<\/script/gi, "<\\/script")}</script>`,
    );
    if ($("script[src],link[href]").length)
      throw Error("HTML 存在外部依赖，不能按单个 HTML 文件交付");
    const out = join(outputFolder, "submission.html");
    await writeFile(out, $.html(), "utf8");
    return out;
  }
  const zip = new JSZip();
  for (const path of paths) {
    if (paths.length > 100) throw Error("软件作品文件数量过多");
    zip.file(path.replace(/\\/g, "/"), await readFile(join(workspace, path)));
  }
  const out = join(outputFolder, "submission.zip");
  await writeFile(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}
