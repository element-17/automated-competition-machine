import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import type { Brief } from "../core/types.js";
import { readSource } from "../competition/sources.js";
import { hasFieldValue, inspectTemplate } from "./templates.js";
import { readXlsx, xlsxText } from "./xlsx.js";

export type RequirementCheck = {
  id: string;
  requirement: string;
  status: "passed" | "failed" | "unverified";
  details: string[];
  actual?: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
};
type Bounds = { minimum?: number; maximum?: number };
export type ArtifactMetrics = {
  path: string;
  bytes: number;
  characters?: number;
  words?: number;
  pages?: number;
  width?: number;
  height?: number;
  entries?: string[];
  /** 工作簿的工作表数与总数据行数（xlsx）。 */
  sheets?: number;
  rows?: number;
  /** Word 文档里实际存在的栏目标签（“团队名称：”），用于核对报名表字段。 */
  fields?: string[];
  /** 按真实标签位置读取的值；存在栏目不等于已经填写。 */
  fieldValues?: Record<string, string[]>;
  /** 导出的全文，用于核对“稿末注明姓名、联系电话”这类内容要求。 */
  text?: string;
  errors: string[];
};

/** 完整匹配短句，避免把“摘要 200 字、全文 3000 字”等局部规则当作整件规则。 */
export function parseBounds(raw: string, unit: string): Bounds | null {
  const text = raw
    .trim()
    .replace(/[。.]$/, "")
    .replace(/\s+/g, "")
    .replace(/[，,](?=\d{3}(?:\D|$))/g, "");
  const range = new RegExp(
    `^(\\d+(?:\\.\\d+)?)[~～—–-](\\d+(?:\\.\\d+)?)${unit}$`,
    "i",
  ).exec(text);
  if (range) {
    const minimum = Number(range[1]),
      maximum = Number(range[2]);
    return minimum <= maximum ? { minimum, maximum } : null;
  }
  const prefix = new RegExp(
    `^(不超过|不得超过|最多|至多|不多于|不少于|不得少于|至少|不低于|等于|恰好)?(\\d+(?:\\.\\d+)?)${unit}(以内|以下|以上)?$`,
    "i",
  ).exec(text);
  if (!prefix) return null;
  const n = Number(prefix[2]),
    pre = prefix[1] || "",
    post = prefix[3] || "";
  const min = /不少于|不得少于|至少|不低于/.test(pre) || post === "以上",
    max =
      /不超过|不得超过|最多|至多|不多于/.test(pre) || /以内|以下/.test(post);
  if (min && max) return null;
  return min
    ? { minimum: n }
    : max
      ? { maximum: n }
      : { minimum: n, maximum: n };
}

export function fixedFileName(
  naming: string | null | undefined,
): string | null {
  if (!naming) return null;
  const text = naming
    .trim()
    .replace(/^(?:文件名|命名)(?:必须)?(?:为|：|:)\s*/, "")
    .replace(/^[「“"']|[」”"']$/g, "");
  if (
    /[\\/:*?"<>|\r\n{}\[\]]/.test(text) ||
    /姓名|作者|学校|学号|作品名称|赛道名称|项目名称|团队|待填/.test(text) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\./i.test(text) ||
    text.startsWith(".") ||
    text.length > 120
  )
    return null;
  // 官方文件名常带空格（“附件2 校内选拔赛报名表.docx”），空格本身不是非法字符。
  return /^[^\\/:*?"<>|\r\n]{1,110}\.[a-z0-9]{1,10}$/i.test(text)
    ? text
    : null;
}

/** 命名规则里可以由用户资料和作品标题确定的占位词。 */
const namingFields: [RegExp, string][] = [
  [/作者姓名|参赛者姓名|学生姓名|姓名/g, "name"],
  [/学校名称|学校/g, "school"],
  [/学院/g, "college"],
  [/团队名称|队伍名称|队名/g, "teamName"],
  [/指导教师|指导老师/g, "advisor"],
  [/学号/g, "studentId"],
  // 赛道名称来自赛事分组，程序无法可靠推断，留给人工命名。
  [/赛道名称|参赛赛道/g, "__track"],
  [/项目名称|作品名称|作品标题/g, "workTitle"],
];
export type NamingValues = Partial<
  Record<
    | "name"
    | "school"
    | "college"
    | "teamName"
    | "advisor"
    | "studentId"
    | "workTitle",
    string
  >
>;

/** 命名规则里仍然缺值的占位词，用来向用户精确要点信息，而不是让他自己猜文件名。 */
export function missingNamingParts(
  naming: string | null | undefined,
  values: NamingValues,
): string[] {
  if (!naming) return [];
  const text = naming
    .trim()
    .replace(/^(?:文件名|命名)(?:必须)?(?:为|：|:)\s*/, "")
    .replace(/[（(][^）)]*例[：:][^）)]*[）)]/g, "");
  return [
    ...new Set(
      namingFields.flatMap(([re, key]) =>
        new RegExp(re.source).test(text) && !values[key as keyof NamingValues]?.trim()
          ? [re.source.split("|")[0]!]
          : [],
      ),
    ),
  ];
}

/**
 * 把“赛道名称_作品名称_作者姓名”这类命名规则变成真实文件名。
 * 规则本身没写扩展名时用实际产物格式补上；仍有未确定的个人信息时返回 null，交给人工命名。
 */
export function resolveFileName(
  naming: string | null | undefined,
  values: NamingValues,
  extension?: string,
): string | null {
  if (!naming) return null;
  let text = naming
    .trim()
    .replace(/^(?:文件名|命名)(?:必须)?(?:为|：|:)\s*/, "")
    .replace(/^[「“"']|[」”"']$/g, "")
    .replace(/[（(][^）)]*例[：:][^）)]*[）)]/g, "")
    // 命名规则后面的补充说明（“团队作品须注明成员分工”）不是文件名的一部分。
    .replace(/[，,；;].*$/, "")
    .trim();
  if (!text) return null;
  let unresolved = false;
  for (const [re, key] of namingFields) {
    text = text.replace(re, () => {
      const v = values[key as keyof NamingValues]?.trim();
      if (!v) {
        unresolved = true;
        return "\u0000";
      }
      return v.replace(/[\\/:*?"<>|\r\n]/g, "_");
    });
  }
  if (unresolved || /\u0000/.test(text)) return null;
  // 中文规则里的“_”分隔符要保留，但重复和首尾的分隔符要去掉。
  text = text.replace(/_+/g, "_").replace(/^[_\-\s]+|[_\-\s]+$/g, "");
  if (!text) return null;
  if (!/\.[a-z0-9]{1,10}$/i.test(text)) {
    const ext = extension?.toLowerCase().replace(/^\./, "");
    if (!ext) return null;
    text = `${text}.${ext}`;
  }
  return fixedFileName(text);
}

export async function measureArtifact(path: string): Promise<ArtifactMetrics> {
  const result: ArtifactMetrics = {
    path,
    bytes: (await stat(path)).size,
    errors: [],
  };
  const ext = extname(path).toLowerCase();
  try {
    if ([".txt", ".md", ".docx", ".pdf"].includes(ext)) {
      const text = await readSource(path);
      result.text = text;
      result.characters = Array.from(text.replace(/\s/gu, "")).length;
      if (!/\p{Script=Han}/u.test(text))
        result.words = (
          text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []
        ).length;
    }
    if ([".pptx", ".zip"].includes(ext)) {
      const zip = await JSZip.loadAsync(await readFile(path));
      result.entries = Object.values(zip.files)
        .filter((f) => !f.dir)
        .map((f) => f.name);
      if (ext === ".pptx")
        result.pages = result.entries.filter((p) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(p),
        ).length;
    }
    if (ext === ".pdf") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({
        data: new Uint8Array(await readFile(path)),
        useSystemFonts: true,
      });
      const doc = await task.promise;
      try {
        result.pages = doc.numPages;
      } finally {
        await doc.destroy();
      }
    }
    if ([".png", ".jpg", ".jpeg"].includes(ext)) {
      const info = await sharp(path).metadata();
      result.width = info.width;
      result.height = info.height;
    }
    // xlsx 必须能被真实解析成 OOXML 工作簿；改名冒充的 CSV/HTML 在这里直接报错。
    if (ext === ".xlsx") {
      const workbook = await readXlsx(await readFile(path));
      result.sheets = workbook.sheets.length;
      result.rows = workbook.sheets.reduce((sum, s) => sum + s.rows.length, 0);
      result.text = xlsxText(workbook);
      result.characters = Array.from(result.text.replace(/\s/gu, "")).length;
      // 首工作表的表头行作为可核对栏目（“需填写学校、学院…”），值取首条数据行。
      const header = workbook.sheets[0]?.rows[0] || [];
      const dataRow = workbook.sheets[0]?.rows[1] || [];
      result.fields = header.filter((h) => h.trim());
      result.fieldValues = Object.fromEntries(
        header
          .map((h, i): [string, string[]] => [h.trim(), [dataRow[i] || ""]])
          .filter(([h]) => h),
      );
    }
    // 报名表类规则常写成“需填写团队名称、参赛赛题和所在赛区”，用文档里的实际标签逐项核对。
    if (ext === ".docx") {
      const inspection = inspectTemplate(await readFile(path), false);
      result.fields = inspection.labels;
      result.fieldValues = inspection.fieldValues;
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  return result;
}

/**
 * “报名表需填写团队名称、参赛赛题和所在赛区”这类规则，可以用文档里实际存在的栏目标签核对。
 * 只认能逐项定位到的字段；无法拆解的规则仍然交人工确认。
 */
/** 表单栏目常见的结尾词；用于区分“报名表要填哪些栏目”和“论文要有哪些章节”。 */
const formFieldTail =
  /(?:名称|姓名|学号|工号|证号|编号|电话|手机|邮箱|地址|日期|时间|签字|签名|盖章|意见|备注|身份|身份证号|专业|学院|学校|单位|类别|组别|团队|赛题|赛区|方向|职务|职称|号码|邮件|院系|[状式表])$/;
export function fieldsInRule(rule: string, available: string[]): string[] | null {
  return parseFieldRules(rule, available)?.map((field) => field.name) || null;
}

type FieldRule = { name: string; mode: "present" | "value" | "optional" };
const fieldVerb = /(?:必须|需要|需|须|应|要)?(填写|注明|标注|写明|列出|附上|包含|包括|设置|设有|列有|具有)/;
const optionalField = /(?:可(?:以)?|允许)(?:留空|留白|为空|不填)|选填|非必填/;
function parseFieldRules(rule: string, available: string[]): FieldRule[] | null {
  const result: FieldRule[] = [];
  let mode: FieldRule["mode"] = "value", started = false;
  for (const clause of rule.split(/[。；;]/).filter((x) => x.trim())) {
    const first = fieldVerb.exec(clause);
    let body = clause;
    if (first) {
      mode = /设置|设有|列有|具有/.test(first[1]!) ? "present" : "value";
      if (/包含|包括/.test(first[1]!) && /栏目|字段|栏$/.test(clause)) mode = "present";
      body = clause.slice(first.index + first[0].length);
      started = true;
    } else if (!started && !optionalField.test(clause)) return null;
    for (let item of body.split(/[、，,]|以及|和|及|与|并/).map((x) => x.trim()).filter(Boolean)) {
      const verb = fieldVerb.exec(item);
      if (verb?.index === 0) {
        mode = /设置|设有|列有|具有/.test(verb[1]!) ? "present" : "value";
        item = item.slice(verb[0].length);
      }
      const allowEmpty = optionalField.test(item);
      item = item.replace(/[（(][^）)]*(?:选填|留空|留白|非必填)[^）)]*[）)]/g, "")
        .replace(/(?:可(?:以)?|允许)(?:留空|留白|为空|不填)|选填|非必填/g, "")
        .replace(/(?:栏目|字段|信息|等内容|栏|等)$/, "").trim();
      const range = /^(.*?)(\d+)(?:的)?(.*?)(?:至|到|—|–|－|-)(.*?)(\d+)(?:的)?(.*)$/.exec(item);
      const names: string[] = [];
      if (range) {
        const from = Number(range[2]), to = Number(range[5]);
        if (from > to || to - from > 30) return null;
        for (let n = from; n <= to; n++) names.push(`${range[1] || range[4]}${n}${range[6] || range[3]}`);
      } else names.push(item);
      for (const name of names) {
        if (!name || name.length > 30 || (!formFieldTail.test(name) && !available.includes(name))) return null;
        result.push({ name, mode: allowEmpty ? "optional" : mode });
      }
    }
  }
  if (!result.length) return null;
  const optional = new Set(result.filter((x) => x.mode === "optional").map((x) => x.name));
  return [...new Map(result.map((x) => [x.name, { ...x, mode: optional.has(x.name) ? "optional" as const : x.mode }])).values()];
}
const fieldAliases = [
  ["姓名", "作者姓名", "参赛者姓名", "学生姓名", "作者", "参赛者", "署名"],
  ["联系电话", "电话", "手机", "手机号", "手机号码", "联系方式"],
  ["学校", "所在学校", "学校名称", "就读学校", "院校"],
  ["邮箱", "电子邮箱", "邮件"],
  ["通讯地址", "联系地址", "地址"],
];
const normalizeField = (name: string) => {
  const text = name.replace(/\s|的/g, "");
  return fieldAliases.find((group) => group.includes(text))?.[0] || text;
};
const sameField = (a: string, b: string) => normalizeField(a) === normalizeField(b);
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 冒号不可被当成值，后一个标签也不可被跨行吞进前一个字段。 */
function textFieldValues(text: string, names: string[]): Record<string, string[]> {
  const labels = [...new Set([...names, ...fieldAliases.flat(), "学号", "身份证号", "学校", "学院", "单位", "日期", "备注"])];
  const pattern = new RegExp(`(${labels.sort((a, b) => b.length - a.length).map(escapePattern).join("|")})[ \\t]*[：:]`, "g");
  const matches = [...text.matchAll(pattern)];
  const values: Record<string, string[]> = {};
  matches.forEach((match, index) => {
    const rest = text.slice(match.index! + match[0].length, matches[index + 1]?.index).trim();
    const value = rest.split(/\r?\n|[；;]/)[0]!.replace(/[、，,]\s*$/, "").trim();
    (values[match[1]!] ||= []).push(value);
  });
  return values;
}
function validFieldValue(name: string, value: string): boolean {
  if (!hasFieldValue(value) || sameField(name, value) || /^[^：:]{1,30}[：:]/.test(value)) return false;
  if (/电话|手机/.test(name)) return /^\+?[\d()（） -]+$/.test(value) && value.replace(/\D/g, "").length >= 6;
  if (/邮箱|邮件/.test(name)) return /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(value);
  return true;
}
function statedInfoRule(rule: string, metrics: ArtifactMetrics[]): RequirementCheck | null {
  const labels = metrics.flatMap((m) => m.fields || []);
  const asked = parseFieldRules(rule, labels);
  if (!asked) return null;
  const textValues = metrics.map((m) => textFieldValues(m.text || "", [...labels, ...asked.map((x) => x.name)]));
  const failures: string[] = [], details: string[] = [];
  let actual = 0;
  for (const field of asked) {
    const values = metrics.flatMap((m, index) => {
      const structured = Object.entries(m.fieldValues || {}).filter(([key]) => sameField(key, field.name));
      return (structured.length ? structured : Object.entries(textValues[index]!).filter(([key]) => sameField(key, field.name))).flatMap(([, value]) => value);
    });
    const present = labels.some((label) => sameField(label, field.name)) || values.length > 0;
    const filled = values.length > 0 && values.every((value) => validFieldValue(field.name, value));
    const passed = field.mode === "optional" || (field.mode === "present" ? present : filled);
    if (passed) actual++; else failures.push(field.name);
    details.push(`${field.name}：${field.mode === "optional" ? "允许留空" : field.mode === "present" ? present ? "栏目存在" : "缺少栏目" : filled ? "已核验实际值" : present ? "缺少实际值（仅标签、空白或占位）" : "缺少栏目及实际值"}`);
  }
  return {
    id: "", requirement: rule, actual, minimum: asked.length, unit: "项字段",
    status: failures.length ? "failed" : "passed",
    details: [`逐项核对 ${asked.map((x) => x.name).join("、")}；${details.join("；")}`],
  };
}

function checked(
  id: string,
  requirement: string,
  actual: number | undefined,
  bounds: Bounds,
  unit: string,
  detail: string,
): RequirementCheck {
  return {
    id,
    requirement,
    actual,
    ...bounds,
    unit,
    status:
      actual === undefined
        ? "unverified"
        : (bounds.minimum !== undefined && actual < bounds.minimum) ||
            (bounds.maximum !== undefined && actual > bounds.maximum)
          ? "failed"
          : "passed",
    details: [
      actual === undefined
        ? `无法测量${unit}；${detail}`
        : `实测 ${actual} ${unit}；${detail}`,
    ],
  };
}
const unknown = (
  id: string,
  requirement: string,
  reason: string,
): RequirementCheck => ({
  id,
  requirement,
  status: "unverified",
  details: [reason],
});

export function checkLimits(
  limits: string[],
  metrics: ArtifactMetrics[],
): RequirementCheck[] {
  return limits.flatMap((raw, index) => {
    const id = `limit-${index + 1}`,
      trimmed = raw.trim();
    const single = metrics.length === 1 ? metrics[0] : undefined;
    // 字数：明确口径的按该口径算；只写“不少于 X 字”时按正文汉字+标点计，并在说明里写清口径。
    const chars =
      /^(?:全文)?(?:含标点不含空白字符数|含标点不含空格字数)[：:]?\s*(.*)$/.exec(
        trimmed,
      );
    if (chars) {
      const bounds = parseBounds(chars[1]!, "(?:字|字符)");
      if (bounds)
        return [
          checked(
            id,
            raw,
            single?.characters,
            bounds,
            "字符",
            "从导出文件提取全文，包含标题和标点，排除空白",
          ),
        ];
    }
    // “正文不少于3000字”“字数3000-5000字”这类常见要求，直接用实测字符数核对。
    const plainChars = parseBounds(
      trimmed.replace(/^(?:正文|全文|作品|稿件)?(?:汉字数|字数|字符数)?[：:]?\s*/i, ""),
      "(?:字|字符)",
    );
    if (plainChars && /字/.test(trimmed))
      return [
        checked(
          id,
          raw,
          single?.characters,
          plainChars,
          "字符",
          "从导出文件提取全文（含标题和标点、不含空白）后计数；未标注口径时以此为准",
        ),
      ];
    const words = /^(?:全文)?英文单词数[：:]?\s*(.*)$/.exec(trimmed);
    if (words) {
      const bounds = parseBounds(words[1]!, "(?:词|words?)");
      if (bounds)
        return [
          checked(
            id,
            raw,
            single?.words,
            bounds,
            "词",
            "按连续字母/数字计词，包含标题，连字符和撇号连接的词计为一词",
          ),
        ];
    }
    const pages = parseBounds(
      trimmed.replace(/^(?:页数|幻灯片数|PPT页数)[：:]?\s*/i, ""),
      "(?:页|张幻灯片)",
    );
    if (pages)
      return [
        checked(
          id,
          raw,
          single?.pages,
          pages,
          "页",
          "PDF/PPTX 读取实际页数；Word 尚无渲染页数",
        ),
      ];
    const size =
      /^(?:每个)?(?:文件大小|文件体积|大小)?[：:]?\s*(.*?)(KiB|MiB|KB|MB|字节|bytes?)$/i.exec(
        trimmed,
      );
    if (size) {
      const bounds = parseBounds(size[1]!.trim(), "");
      if (bounds) {
        const scale = /^(MiB|MB)$/i.test(size[2]!)
          ? /MiB/i.test(size[2]!)
            ? 1024 ** 2
            : 1e6
          : /^(KiB|KB)$/i.test(size[2]!)
            ? /KiB/i.test(size[2]!)
              ? 1024
              : 1000
            : 1;
        return metrics.length
          ? metrics.map((m, i) =>
              checked(
                `${id}-${i + 1}`,
                raw,
                m.bytes / scale,
                bounds,
                size[2]!,
                basename(m.path),
              ),
            )
          : [unknown(id, raw, "没有实际文件可检查")];
      }
    }
    const dimensions =
      /^(?:图片)?(?:尺寸|分辨率)[：:]?\s*(\d+)\s*[x×*]\s*(\d+)\s*(?:px|像素)$/i.exec(
        trimmed,
      );
    if (dimensions)
      return [
        checked(
          `${id}-width`,
          raw,
          single?.width,
          { minimum: Number(dimensions[1]), maximum: Number(dimensions[1]) },
          "像素宽",
          "读取图片元数据",
        ),
        checked(
          `${id}-height`,
          raw,
          single?.height,
          { minimum: Number(dimensions[2]), maximum: Number(dimensions[2]) },
          "像素高",
          "读取图片元数据",
        ),
      ];
    // “稿末注明作者姓名、学校、联系电话”这类要求：检查全文里这些信息确实出现了。
    const stated = statedInfoRule(trimmed, metrics);
    if (stated) return [{ ...stated, id }];
    return [
      unknown(
        id,
        raw,
        "规则未转换为可靠的自动检查；需要人工确认适用范围和计数口径",
      ),
    ];
  });
}

export function checkDelivery(
  item: Brief["deliverables"][number],
  metrics: ArtifactMetrics[],
  values: NamingValues = {},
): RequirementCheck[] {
  const checks = checkLimits(item.limits, metrics);
  const aliases: Record<string, string> = {
    word: "docx",
    powerpoint: "pptx",
    jpeg: "jpg",
    markdown: "md",
  };
  const formats = item.formats.flatMap((x) =>
    x
      .toLowerCase()
      .split(/\s*(?:\/|或|、|,)\s*/)
      .map((f) => {
        const norm = f.trim().replace(/^\./, "");
        return aliases[norm] || norm;
      }),
  );
  checks.unshift({
    id: "files",
    requirement: "至少存在一个实际产物",
    status: metrics.length ? "passed" : "failed",
    details: [`实际产物 ${metrics.length} 个`],
  });
  for (const [index, metric] of metrics.entries())
    if (metric.errors.length)
      checks.push(
        {
          id: `read-${index + 1}`, requirement: "文件可读取", status: "failed",
          details: [`${basename(metric.path)} 无法完整读取：${metric.errors.join("；")}`],
        },
      );
  checks.push({
    id: "format",
    requirement: `交付格式：${item.formats.join("/") || "未明确"}`,
    status: !formats.length
      ? "unverified"
      : !metrics.length ||
          metrics.some(
            (m) =>
              !formats.includes(
                extname(m.path)
                  .slice(1)
                  .toLowerCase()
                  .replace(/^jpeg$/, "jpg"),
              ),
          )
        ? "failed"
        : "passed",
    details: [
      `实际格式：${metrics.map((m) => extname(m.path)).join("、") || "无文件"}`,
    ],
  });
  if (item.quantity) {
    const bounds = parseBounds(item.quantity, "(?:份|个|件|张|套|文件)?");
    checks.push(
      bounds
        ? checked(
            "quantity",
            item.quantity,
            metrics.length,
            bounds,
            "份",
            "统计该交付物的最终独立文件；压缩包计一份",
          )
        : unknown(
            "quantity",
            item.quantity,
            "数量规则含范围或对象歧义，需人工核对",
          ),
    );
  }
  if (item.naming) {
    // 命名规则里带姓名、学校等占位词时，用用户资料和作品标题解析成真实文件名。
    const extensions = [...new Set(metrics.map((metric) => extname(metric.path).slice(1).toLowerCase()))];
    const extension = extensions.length === 1 ? extensions[0] : undefined;
    const name = fixedFileName(item.naming) || resolveFileName(item.naming, values, extension);
    checks.push(
      name
        ? {
            id: "naming",
            requirement: item.naming,
            status:
              metrics.length === 1 && basename(metrics[0]!.path) === name
                ? "passed"
                : "failed",
            details: [
              `要求文件名 ${name}；实际 ${metrics.map((m) => basename(m.path)).join("、") || "无文件"}`,
            ],
          }
        : unknown(
            "naming",
            item.naming,
            "命名规则需要未提供的作者/学校信息，尚未自动核实",
          ),
    );
  }
  for (const [index, attachment] of item.attachments.entries()) {
    const name = fixedFileName(attachment);
    checks.push(
      name
        ? {
            id: `attachment-${index + 1}`,
            requirement: attachment,
            status: metrics.some(
              (m) =>
                basename(m.path) === name ||
                m.entries?.some((p) => p.split("/").at(-1) === name),
            )
              ? "passed"
              : "failed",
            details: [
              `检查实际文件及 ZIP 内文件名：${name}；内容真实性仍需审核`,
            ],
          }
        : unknown(
            `attachment-${index + 1}`,
            attachment,
            "附件要求没有明确文件名，尚未验证对应文件及内容",
          ),
    );
  }
  return checks;
}
