import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import type { Brief } from "../core/types.js";
import { readSource } from "../competition/sources.js";

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
  return /^[^\s]+\.[a-z0-9]{1,10}$/i.test(text) ? text : null;
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
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  return result;
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
    // 字数必须明确计数口径；模糊的“1000 字”不能假装与官方统计口径一致。
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
        unknown(
          `read-${index + 1}`,
          "文件可读取",
          `${basename(metric.path)} 无法完整读取：${metric.errors.join("；")}`,
        ),
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
    const name = fixedFileName(item.naming);
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
            "命名规则不是固定文件名或需要真实作者信息，尚未自动核实",
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
