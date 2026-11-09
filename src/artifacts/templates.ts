import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const Docxtemplater = require("docxtemplater");
const PizZip = require("pizzip");
const InspectModule = require("docxtemplater/js/inspect-module.js");

/** 只填写官方模板中明确存在的简单 {字段}，不改变原始排版。 */
export function readTemplate(data: Buffer): {
  tags: string[];
  render: (fields: Record<string, string>) => Buffer;
} {
  const inspector = InspectModule();
  const doc = new Docxtemplater(new PizZip(data), {
    modules: [inspector],
    paragraphLoop: true,
    linebreaks: true,
  });
  const all = inspector.getAllTags() as Record<string, unknown>;
  const tags = Object.keys(all);
  if (!tags.length)
    throw Error("官方模板没有可自动识别的字段；需要人工确认填写位置");
  if (
    tags.some((k) => {
      const child = all[k];
      return (
        !!child &&
        typeof child === "object" &&
        Object.keys(child as object).length > 0
      );
    })
  )
    throw Error("官方模板包含复杂循环或嵌套字段，当前不支持自动填写");
  return {
    tags,
    render(fields) {
      if (
        tags.some(
          (tag) => typeof fields[tag] !== "string" || !fields[tag]?.trim(),
        )
      )
        throw Error("官方模板存在未能确认的必填字段");
      doc.render(fields);
      return doc.getZip().generate({ type: "nodebuffer" });
    },
  };
}
export async function downloadTemplate(url: string): Promise<Buffer> {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("官方模板地址无效");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw Error(`官方模板下载失败 ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > 15_000_000) throw Error("官方模板超过 15 MB");
  return data;
}
export async function saveTemplateFile(
  data: Buffer,
  format: "docx" | "pptx",
  folder: string,
) {
  await mkdir(folder, { recursive: true });
  const out = join(folder, `submission.${format}`);
  await writeFile(out, data);
  return out;
}
