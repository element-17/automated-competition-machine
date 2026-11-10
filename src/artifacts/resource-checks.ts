import { load } from "cheerio";

const origin = "https://artifact.invalid/";
const cssEscape = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\r\n\f])|([^\r\n\f]))/gi;
const unescapeCss = (text: string) => text.replace(cssEscape, (_, hex: string | undefined, newline: string | undefined, char: string | undefined) => {
  if (hex) {
    const point = parseInt(hex, 16);
    return String.fromCodePoint(!point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point);
  }
  return newline ? "" : char || "";
});
const escapeToken = String.raw`\\(?:[0-9a-fA-F]{1,6}(?:\r\n|[ \t\r\n\f])?|[^\r\n\f])`;
const cssString = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`;

/** Read only resource-bearing CSS tokens, not comments or strings such as content: "url(...)". */
function cssResources(text: string): string[] {
  const refs: string[] = [];
  const token = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${cssString}|@?(?:${escapeToken}|[-_a-zA-Z])(?:${escapeToken}|[-_a-zA-Z0-9])*`, "g");
  const space = (at: number) => {
    const match = /^(?:\s|\/\*[\s\S]*?\*\/)*/.exec(text.slice(at));
    return at + (match?.[0].length || 0);
  };
  for (let match; (match = token.exec(text));) {
    const word = unescapeCss(match[0]).toLowerCase();
    if (word !== "url" && word !== "@import") continue;
    let at = space(token.lastIndex);
    if (word === "url") {
      if (text[at] !== "(") continue;
      at = space(at + 1);
    }
    const quoted = new RegExp(`^(?:${cssString})`).exec(text.slice(at));
    if (quoted) {
      refs.push(unescapeCss(quoted[0].slice(1, -1)));
      token.lastIndex = at + quoted[0].length;
    } else if (word === "url") {
      const value = new RegExp(String.raw`^(?:${escapeToken}|[^)\\])*`).exec(text.slice(at))![0];
      refs.push(unescapeCss(value.trim()));
      token.lastIndex = at + value.length;
    }
  }
  return refs;
}

/** A data URL may contain commas; only descriptor separators end such a candidate. */
function srcsetResources(text: string): string[] {
  const refs: string[] = [];
  let at = 0;
  while (at < text.length) {
    while (/[\s,]/.test(text[at] || "") && at < text.length) at++;
    const start = at;
    while (at < text.length && !/\s/.test(text[at]!)) at++;
    const raw = text.slice(start, at);
    if (!raw) break;
    refs.push(raw.replace(/,+$/, ""));
    if (raw.endsWith(",")) continue;
    let parentheses = 0;
    while (at < text.length) {
      const char = text[at++];
      if (char === "(") parentheses++;
      if (char === ")") parentheses--;
      if (char === "," && parentheses <= 0) break;
    }
  }
  return refs;
}

/** Inspect actual delivery bytes only. No workspace access, URL fetching, inlining, or repair. */
export function assertArtifactResources(
  files: ReadonlyMap<string, Buffer>,
  mode: "html" | "zip",
): void {
  const issues = new Set<string>();
  const check = (value: string, base: URL, file: string) => {
    const ref = value.trim();
    if (!ref || ref.startsWith("#") || /^data:/i.test(ref)) return;
    if (mode === "html") {
      issues.add(`${file}：单 HTML 存在未内嵌资源 ${ref}`);
      return;
    }
    try {
      const target = new URL(ref, base);
      if (target.origin !== new URL(origin).origin) {
        issues.add(`${file}：离线作品引用外部资源 ${ref}`);
        return;
      }
      const path = decodeURIComponent(target.pathname).replace(/^\//, "") || "index.html";
      if (!files.has(path)) issues.add(`${file}：实际归档缺少资源 ${ref}（${path}）`);
    } catch {
      issues.add(`${file}：资源地址无效 ${ref}`);
    }
  };
  const markup = (text: string, file: string, base: URL, xmlMode = false, depth = 0) => {
    if (depth > 8) throw Error("嵌套 srcdoc 过深，无法完整检查资源；请简化页面");
    const $ = load(text, { xmlMode });
    const baseHref = $("base[href]").first().attr("href");
    if (baseHref) {
      try { base = new URL(baseHref, base); }
      catch { issues.add(`${file}：base 地址无效 ${baseHref}`); }
    }
    $("*").each((_, el) => {
      if (!("tagName" in el)) return;
      const node = $(el), tag = el.tagName.toLowerCase();
      const attr = (name: string) => {
        const value = node.attr(name);
        if (value !== undefined) check(value, base, file);
      };
      if (["img", "script", "source", "video", "audio", "track", "iframe", "embed"].includes(tag)) attr("src");
      if (tag === "input" && node.attr("type")?.toLowerCase() === "image") attr("src");
      if (tag === "video") attr("poster");
      if (tag === "object") attr("data");
      if (["image", "use", "feimage", "script"].includes(tag)) {
        attr("href");
        attr("xlink:href");
      }
      if (["body", "table", "td", "th"].includes(tag)) attr("background");
      if (tag === "link") {
        const rel = (node.attr("rel") || "").toLowerCase().split(/\s+/);
        if (rel.some((r) => ["stylesheet", "icon", "preload", "modulepreload", "prefetch", "manifest", "mask-icon", "apple-touch-icon", "apple-touch-icon-precomposed"].includes(r))) {
          attr("href");
          for (const ref of srcsetResources(node.attr("imagesrcset") || "")) check(ref, base, file);
        }
      }
      if (tag === "img" || tag === "source")
        for (const ref of srcsetResources(node.attr("srcset") || "")) check(ref, base, file);
      const css = [node.attr("style") || "", ...["fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "cursor"].map((name) => node.attr(name) || "")];
      if (tag === "style") css.push(node.text());
      for (const ref of cssResources(css.join("\n"))) check(ref, base, file);
      const srcdoc = tag === "iframe" ? node.attr("srcdoc") : undefined;
      if (srcdoc !== undefined) markup(srcdoc, file, base, false, depth + 1);
    });
  };
  for (const [file, bytes] of files) {
    const base = new URL(file.split("/").map(encodeURIComponent).join("/"), origin);
    if (/\.(?:html?|svg)$/i.test(file)) markup(bytes.toString("utf8"), file, base, /\.svg$/i.test(file));
    else if (/\.css$/i.test(file))
      for (const ref of cssResources(bytes.toString("utf8"))) check(ref, base, file);
  }
  if (issues.size) throw Error(`交付资源检查未通过：${[...issues].join("；")}`);
}
