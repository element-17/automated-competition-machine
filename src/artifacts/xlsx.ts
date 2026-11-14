/** 最小 OOXML 工作簿读取：文件测量与正文复用审计用，不依赖 officecli，解析失败就抛错。 */
import JSZip from "jszip";

const decode = (x: string) =>
  x
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** "BC12" 的列字母部分转 0 起始列号。 */
const colIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref) {
    if (ch >= "A" && ch <= "Z") n = n * 26 + (ch.charCodeAt(0) - 64);
    else if (ch >= "a" && ch <= "z") n = n * 26 + (ch.charCodeAt(0) - 96);
    else break;
  }
  return n - 1;
};

/** 共享字符串表：<si> 可能由多个 <r><t> 富文本片段拼成。 */
const sharedStrings = (xml: string): string[] =>
  [...xml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) =>
    [...m[1]!.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((t) => decode(t[1]!))
      .join(""),
  );

/** 单元格取值：t="s" 引用共享字符串，inlineStr 内联，其余按字面值（含公式缓存结果）。 */
const cellValue = (
  cell: string,
  shared: string[],
): string => {
  const type = /t="([^"]+)"/.exec(cell)?.[1];
  const inline = /<(?:\w+:)?is(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?is>/.exec(cell);
  if (inline)
    return [...inline[1]!.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((t) => decode(t[1]!))
      .join("");
  const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cell)?.[1];
  if (v === undefined) return "";
  const raw = decode(v);
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) && shared[index] !== undefined
      ? shared[index]!
      : "";
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
};

export type XlsxSheet = { name: string; rows: string[][] };
export type XlsxWorkbook = { sheets: XlsxSheet[] };

export async function readXlsx(data: Buffer | Uint8Array): Promise<XlsxWorkbook> {
  const zip = await JSZip.loadAsync(data);
  const sharedXml = zip.file("xl/sharedStrings.xml");
  const shared = sharedXml ? sharedStrings(await sharedXml.async("string")) : [];
  const bookXml = zip.file("xl/workbook.xml");
  if (!bookXml) throw Error("缺少 xl/workbook.xml，不是有效的 xlsx 工作簿");
  const relsXml = zip.file("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsXml)
    for (const m of (await relsXml.async("string")).matchAll(
      /<Relationship\b[^>]*\/?>(?:<\/Relationship>)?/g,
    )) {
      const id = /Id="([^"]+)"/.exec(m[0])?.[1];
      const target = /Target="([^"]+)"/.exec(m[0])?.[1];
      if (id && target && /worksheets\/.+\.xml$/.test(target))
        rels.set(id, target.replace(/^\//, "").replace(/^(?!xl\/)/, "xl/"));
    }
  const sheets: XlsxSheet[] = [];
  for (const m of (await bookXml.async("string")).matchAll(
    /<(?:\w+:)?sheet\b[^>]*\/?>(?:<\/(?:\w+:)?sheet>)?/g,
  )) {
    const name = decode(/name="([^"]*)"/.exec(m[0])?.[1] || "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const path = rid ? rels.get(rid) : undefined;
    const sheetXml = path ? zip.file(path) : undefined;
    if (!sheetXml) {
      sheets.push({ name, rows: [] });
      continue;
    }
    const shared2 = shared;
    const rows: string[][] = [];
    for (const row of (await sheetXml.async("string")).matchAll(
      /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>|<(?:\w+:)?row\b[^>]*\/>/g,
    )) {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(
        /<(?:\w+:)?c\b[^>]*>([\s\S]*?)<\/(?:\w+:)?c>|<(?:\w+:)?c\b[^>]*\/>/g,
      )) {
        const ref = /r="([A-Za-z]+)\d+"/.exec(cell[0])?.[1];
        const value = cellValue(cell[0]!, shared2);
        // 有 r 属性按坐标落位（跳过的空列补空串）；没有就按出现顺序。
        const index = ref ? colIndex(ref) : cells.length;
        cells[index] = value;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
      rows.push(cells);
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}

/** 工作簿的纯文本视图：逐表“表名: 制表符分隔的行”，供复用审计比对正文。 */
export const xlsxText = (workbook: XlsxWorkbook): string =>
  workbook.sheets
    .map((s) =>
      [
        `${s.name}:`,
        ...s.rows.map((row) => row.join("\t")),
      ].join("\n"),
    )
    .join("\n\n");
