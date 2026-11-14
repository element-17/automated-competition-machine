import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const Docxtemplater = require("docxtemplater");
const PizZip = require("pizzip");
const InspectModule = require("docxtemplater/js/inspect-module.js");

const decode = (x: string) =>
  x
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const encode = (x: string) =>
  x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const textOf = (xml: string) =>
  [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) => decode(m[1]!))
    .join("");

/** 标签、提示语和占位符不构成填写值；这里不推断或补造个人资料。 */
export function hasFieldValue(value: string): boolean {
  const text = value.trim().replace(/^[（(\[【]+|[）)\]】]+$/g, "").trim();
  return !!text && /[\p{L}\p{N}]/u.test(text) &&
    !/^(?:无|暂无|不详|未知|未提供|未填写|待定|待补充|待确认|待填(?:写)?|请填(?:写)?|请在此填写|填写此处|此处填写|略|n\/?a|null|undefined|none|tbd|todo|placeholder)$/i.test(text) &&
    !/^(?:待填|待补|待提供|请填|请输入|由.*填写|签字后|盖章后)/.test(text) &&
    !/^(?:x+|某某.*|your\s+.+)$/i.test(text) &&
    !/[{｛}｝]|\$\{|<[^>]+>|^[\[【].*[\]】]$/.test(value.trim()) &&
    !/^[^：:]{1,30}[：:]\s*$/.test(text);
}

const fieldLabel = (text: string) => /^([^：:\r\n]{1,30})[：:][ \t]*(.*)$/s.exec(text.trim());
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 逐个替换同名嵌套区块（表格/行/单元格）。用标签扫描而不是正则整体匹配，
 * 避免把 <w:tblPr> 当成 <w:tbl>，也避免嵌套表格被截断。
 */
function mapBlocks(
  xml: string,
  tag: string,
  fn: (inner: string, index: number) => string,
): string {
  const re = new RegExp(`<w:${tag}(?=[\\s>])[^>]*>|</w:${tag}>`, "g");
  let out = "",
    cursor = 0,
    depth = 0,
    openEnd = -1,
    closeStart = -1,
    index = 0,
    m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (!m[0].startsWith("</")) {
      if (depth === 0) openEnd = m.index + m[0].length;
      depth++;
      continue;
    }
    depth--;
    if (depth > 0 || openEnd < 0) continue;
    // 闭合标签必须原样写回，否则生成的 docx 会结构损坏。
    closeStart = m.index;
    out +=
      xml.slice(cursor, openEnd) +
      fn(xml.slice(openEnd, closeStart), index++) +
      m[0];
    cursor = m.index + m[0].length;
    openEnd = -1;
  }
  return depth === 0 ? out + xml.slice(cursor) : xml;
}

/**
 * 读取单元格里第一个 run 的字符格式（字体、字号），用于让填入的值和模板标签
 * 完全一致——字号不同会让同一行里的文字基线错开。
 */
function runPropsOf(cellXml: string): string {
  const run = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/.exec(cellXml);
  const inRun = run?.[1] && /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run[1]);
  if (inRun) return inRun[0];
  const inPara = /<w:pPr>[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)[\s\S]*?<\/w:pPr>/.exec(
    cellXml,
  );
  return inPara?.[1] || "";
}

/** 在单元格的最后一个段落里追加文字，沿用模板原有的字符格式和垂直对齐。 */
function writeCell(
  cellXml: string,
  value: string,
  labelCell: string,
): string {
  const props = runPropsOf(labelCell);
  const run = `<w:r>${props}<w:t xml:space="preserve">${encode(value)}</w:t></w:r>`;
  // 标签单元格是垂直居中/顶端对齐时，值单元格必须一致，否则同一行的文字会错位。
  const vAlign = /<w:vAlign\s+w:val="[^"]*"\/>/.exec(labelCell)?.[0];
  let cell = cellXml;
  if (vAlign && !/<w:vAlign\s/.test(cell) && /<w:tcPr>/.test(cell))
    cell = cell.replace(/<\/w:tcPr>/, `${vAlign}</w:tcPr>`);
  const end = cell.lastIndexOf("</w:p>");
  if (end < 0) return `${cell}<w:p>${run}</w:p>`;
  return cell.slice(0, end) + run + cell.slice(end);
}

export type TemplateSlot = {
  /** 程序生成的位置标识，模型按它返回要填的内容。 */
  id: string;
  label: string;
  path: string;
};
export type TemplateInspection = {
  /** docxtemplater 能识别的 {字段}。 */
  tags: string[];
  /** 没有占位符、但由“标签：”加空单元格构成的表格字段。 */
  slots: TemplateSlot[];
  /** 模板里实际存在的字段名（表格标签 + 冒号结尾的独立段落，如“指导教师签字：”）。 */
  labels: string[];
  /** 已填栏目值，用于区分存在栏目与实际填写。 */
  fieldValues?: Record<string, string[]>;
  /** 原始占位符在部件及段落中的锚点；填写后仍按原位置验证。 */
  tagLocations?: { part: string; paragraph: number; text: string; tags: string[] }[];
};

/**
 * 识别官方模板的填写位置：
 * 1. docxtemplater 占位符（{字段}）；
 * 2. 常见报名表结构——标签单元格（“团队名称：”）后紧跟一个空单元格。
 */
export function inspectTemplate(data: Buffer, strict = true): TemplateInspection {
  const zip = new PizZip(data);
  const file = zip.file("word/document.xml");
  if (!file) throw Error("官方模板缺少正文");
  const xml = file.asText();
  let tags: string[] = [];
  try {
    const inspector = InspectModule();
    new Docxtemplater(new PizZip(data), {
      modules: [inspector],
      paragraphLoop: true,
      linebreaks: true,
      // 普通作品里的花括号解析失败是预期情况，不往终端打印整段错误堆栈。
      errorLogging: strict,
    });
    tags = Object.keys(inspector.getAllTags() as Record<string, unknown>);
  } catch (e) {
    // 普通作品正文里的花括号（公式、代码）不是模板占位符；只有官方模板才要求占位符可解析。
    if (strict) throw Error(`官方模板字段无法解析：${e instanceof Error ? e.message : String(e)}`);
  }
  const slots: TemplateSlot[] = [];
  const fieldValues: Record<string, string[]> = {};
  const add = (label: string, value: string) => {
    (fieldValues[label] ||= []).push(value);
  };
  const outsideTables = mapBlocks(xml, "tbl", (table, tableIndex) => {
    mapBlocks(table, "tr", (row, rowIndex) => {
      const cells: string[] = [];
      mapBlocks(row, "tc", (cell) => { cells.push(textOf(cell).trim()); return cell; });
      const consumed = new Set<number>();
      cells.forEach((text, cellIndex) => {
        if (consumed.has(cellIndex)) return;
        const match = fieldLabel(text);
        if (!match) return;
        const label = match[1]!.trim(), inline = match[2]!.trim();
        const next = cells[cellIndex + 1];
        const adjacent = !inline && next !== undefined && !fieldLabel(next);
        const target = adjacent ? cellIndex + 1 : cellIndex;
        const value = adjacent ? next! : inline;
        if (adjacent) consumed.add(target);
        add(label, value);
        // 已有实际值的栏目仍记录标签和值，但不能重新推断为新的填写槽。
        if (!tags.length && !value) slots.push({
          id: `t${tableIndex}r${rowIndex}c${target}`, label,
          path: `/body/tbl[${tableIndex + 1}]/tr[${rowIndex + 1}]/tc[${target + 1}]`,
        });
      });
      return row;
    });
    return "";
  });
  for (const p of outsideTables.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const match = fieldLabel(textOf(p[0]));
    if (match) add(match[1]!.trim(), match[2]!.trim());
  }
  const tagLocations: NonNullable<TemplateInspection["tagLocations"]> = [];
  for (const part of Object.keys(zip.files).filter((name) => /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name))) {
    const paragraphs = [...zip.file(part).asText().matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)];
    paragraphs.forEach((p, paragraph) => {
      const text = textOf(p[0]);
      const found = [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());
      if (found.length) tagLocations.push({ part, paragraph, text, tags: found });
    });
  }
  return { tags, slots, labels: [...new Set([...tags, ...Object.keys(fieldValues)])], fieldValues, tagLocations };
}

/** 读取已填模板里每个字段的实际值，用于验收时核对而不是只信写作模型的自述。 */
export function readTemplateValues(
  data: Buffer,
  slots: TemplateSlot[],
): Record<string, string> {
  const zip = new PizZip(data);
  const file = zip.file("word/document.xml");
  if (!file) throw Error("已填模板缺少正文");
  const xml = file.asText();
  const values: Record<string, string> = {};
  let tableIndex = -1;
  mapBlocks(xml, "tbl", (table) => {
    tableIndex++;
    const current = tableIndex;
    let rowIndex = -1;
    return mapBlocks(table, "tr", (row) => {
      rowIndex++;
      const currentRow = rowIndex;
      let cellIndex = -1;
      return mapBlocks(row, "tc", (cell) => {
        cellIndex++;
        const slot = slots.find(
          (s) => s.id === `t${current}r${currentRow}c${cellIndex}`,
        );
        if (!slot) return cell;
        const text = textOf(cell).trim();
        // 值单元格里除填进去的内容外没有别的文字；标签单元格要先去掉“标签：”。
        values[slot.id] = text.replace(new RegExp(`^${escaped(slot.label)}[：:]\\s*`), "").trim();
        return cell;
      });
    });
  });
  return values;
}

/** 核对生成文件是否保留了模板的全部字段；缺字段说明改坏了官方结构。 */
export function compareTemplate(
  original: TemplateInspection,
  produced: Buffer,
): { preserved: boolean; missing: string[]; filled: string[]; blank: string[] } {
  const after = inspectTemplate(produced);
  const present = new Set(after.labels);
  const values = readTemplateValues(produced, original.slots);
  const actual: Record<string, string[]> = {};
  const missingSlots: string[] = [];
  for (const slot of original.slots) {
    (actual[slot.label] ||= []).push(values[slot.id] || "");
    if (!Object.hasOwn(values, slot.id)) missingSlots.push(slot.label);
  }
  const zip = new PizZip(produced);
  const locatedTags = new Set<string>();
  for (const location of original.tagLocations || []) {
    const xml = zip.file(location.part)?.asText() || "";
    const p = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)][location.paragraph];
    const matches = [...location.text.matchAll(/\{([^{}]+)\}/g)];
    let pattern = "^", end = 0;
    for (const match of matches) {
      pattern += escaped(location.text.slice(end, match.index)) + "([\\s\\S]*?)";
      end = match.index! + match[0].length;
    }
    pattern += escaped(location.text.slice(end)) + "$";
    const filled = p && new RegExp(pattern).exec(textOf(p[0]));
    matches.forEach((match, index) => {
      const tag = match[1]!.trim();
      (actual[tag] ||= []).push(filled?.[index + 1] || "");
      if (filled) locatedTags.add(tag);
    });
  }
  const missing = [...new Set([
    ...original.labels.filter((label) => original.tags.includes(label)
      ? !locatedTags.has(label)
      : !present.has(label)),
    ...missingSlots,
  ])];
  const blank = original.labels.filter((label) => {
    const found = actual[label] || after.fieldValues?.[label] || [];
    return !found.length || !found.every(hasFieldValue);
  });
  const filled = original.labels.filter((label) => !blank.includes(label) && !missing.includes(label));
  return { preserved: missing.length === 0, missing, filled, blank };
}

export function fillTemplateSlots(
  data: Buffer,
  values: Record<string, string>,
): { data: Buffer; filled: string[]; empty: string[] } {
  const zip = new PizZip(data);
  const file = zip.file("word/document.xml");
  if (!file) throw Error("官方模板缺少正文");
  const slots = inspectTemplate(data).slots;
  for (const [id, value] of Object.entries(values)) {
    if (!slots.some((slot) => slot.id === id)) throw Error(`模板填写位置不存在或已有内容：${id}`);
    if (typeof value !== "string" || (value.trim() && !hasFieldValue(value)))
      throw Error(`模板字段不是已确认的实际值：${id}`);
  }
  const filled: string[] = [];
  const empty: string[] = [];
  let tableIndex = -1;
  const xml = mapBlocks(file.asText(), "tbl", (table) => {
    tableIndex++;
    let rowIndex = -1;
    return mapBlocks(table, "tr", (row) => {
      rowIndex++;
      const cells: string[] = [];
      // 先收集整行的单元格，才能让值单元格沿用标签单元格的格式。
      mapBlocks(row, "tc", (cell) => {
        cells.push(cell);
        return cell;
      });
      let cellIndex = -1;
      return mapBlocks(row, "tc", (cell) => {
        cellIndex++;
        const id = `t${tableIndex}r${rowIndex}c${cellIndex}`;
        if (!Object.hasOwn(values, id)) return cell;
        const value = values[id]!.trim();
        if (!value) {
          empty.push(id);
          return cell;
        }
        // “标签：空单元格”结构中，值是写到相邻单元格里的；对齐和字号要跟标签一致。
        const label = slots.find((slot) => slot.id === id)!.label;
        const labelCell = fieldLabel(textOf(cell))?.[1]?.trim() === label ? cell : cells[cellIndex - 1] ?? cell;
        filled.push(id);
        return writeCell(cell, value, labelCell);
      });
    });
  });
  zip.file("word/document.xml", xml);
  return {
    data: zip.generate({ type: "nodebuffer" }) as Buffer,
    filled,
    empty,
  };
}

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
          (tag) => typeof fields[tag] !== "string" || !hasFieldValue(fields[tag]!),
        )
      )
        throw Error("官方模板存在未能确认的必填字段");
      doc.render(fields);
      return doc.getZip().generate({ type: "nodebuffer" });
    },
  };
}
/** 用空字符串补全模板里的未知字段：报名表等模板允许留白，不因缺个人信息整份作废。 */
export function renderTemplate(
  data: Buffer,
  fields: Record<string, string>,
): Buffer {
  for (const [label, value] of Object.entries(fields))
    if (typeof value !== "string" || (value.trim() && !hasFieldValue(value)))
      throw Error(`模板字段不是已确认的实际值：${label}`);
  const doc = new Docxtemplater(new PizZip(data), {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });
  doc.render(fields);
  return doc.getZip().generate({ type: "nodebuffer" });
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
  baseName = "submission",
) {
  await mkdir(folder, { recursive: true });
  const out = join(folder, `${baseName}.${format}`);
  await writeFile(out, data);
  return out;
}
