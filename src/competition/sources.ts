import { isJobControlError } from "../core/job-control.js";
import { load } from "cheerio";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { Evidence, ModelGateway, SearchOptions } from "../core/types.js";
import type { Store } from "../core/store.js";
import {
  fetchDocumentWithBrowser,
  shouldUseBrowserFallback,
  type BrowserFetchOptions,
} from "./browser-fetcher.js";
async function pdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
  });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((x) => ("str" in x ? x.str : "")).join(" "));
    }
    return pages.join("\n");
  } finally {
    await doc.destroy();
  }
}

export function normalizeUrl(input: string): string {
  const u = new URL(input);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("仅支持 HTTP(S) 来源");
  u.hash = "";
  return u.toString();
}
export const MAX_SOURCE_BYTES = 15_000_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;
type SourceOptions = {
  signal?: AbortSignal;
  browserFallback?: BrowserFetchOptions;
};
type SourceFormat = "pdf" | "docx" | "pptx" | "text";
class DownloadError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}
function sourceFormat(contentType: string, url: string): SourceFormat {
  const path = new URL(url).pathname.toLowerCase();
  if (contentType.includes("pdf") || path.endsWith(".pdf")) return "pdf";
  if (contentType.includes("wordprocessingml") || path.endsWith(".docx")) return "docx";
  if (contentType.includes("presentationml") || path.endsWith(".pptx")) return "pptx";
  if (/html|text|xml/.test(contentType)) return "text";
  throw new DownloadError(`暂不支持此来源类型：${contentType || "unknown"}`);
}

/** 始终限制实际解压后的读取字节；预报大小不是可信的上限。 */
async function boundedBody(res: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = res.headers.get("content-length");
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_SOURCE_BYTES)
    throw new DownloadError("来源超过 15 MB，需手动下载并处理");
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, done = false;
  // 即使调用方在读取正文时取消，也立即释放 reader 和连接。
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) { done = true; break; }
      size += part.value.byteLength;
      if (size > MAX_SOURCE_BYTES)
        throw new DownloadError("来源超过 15 MB，需手动下载并处理");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 网络、暂时 HTTP 错误及中断正文共用三次机会和同一截止时间。解析不重试。 */
async function download(url: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let res: Response | undefined;
    try {
      res = await fetch(url, { signal, headers: {
        "user-agent":
          "CompetitionResearchBot/1.0 (public research; contact site administrator for access issues)",
      } });
      signal.throwIfAborted();
      if (!res.ok)
        throw new DownloadError(`来源不可访问 (${res.status}): ${url}`,
          [408, 425, 429].includes(res.status) || (res.status >= 500 && ![501, 505].includes(res.status)));
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      const finalUrl = normalizeUrl(res.url || url);
      const format = sourceFormat(contentType, finalUrl);
      const bytes = await boundedBody(res, signal);
      return { bytes, contentType, finalUrl, format };
    } catch (e) {
      // fetch 的错误响应也必须取消正文，避免下一次尝试遗留连接。
      if (res?.body && !res.body.locked) await res.body.cancel().catch(() => {});
      signal.throwIfAborted();
      if (isJobControlError(e) ||
          (e instanceof Error && ["AbortError", "TimeoutError"].includes(e.name)) ||
          (e instanceof DownloadError && !e.retryable) || attempt + 1 >= DOWNLOAD_ATTEMPTS)
        throw e;
      try {
        await wait(800 * 2 ** attempt, undefined, { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
  }
}
export async function fetchDocument(input: string, options: SourceOptions = {}): Promise<{
  url: string;
  title: string;
  text: string;
  links: { url: string; title: string }[];
}> {
  options.signal?.throwIfAborted();
  const url = normalizeUrl(input);
  try {
    return await fetchDocumentHttp(url, options);
  } catch (e) {
    if (
      options.browserFallback &&
      !isJobControlError(e) &&
      !options.signal?.aborted &&
      shouldUseBrowserFallback(e)
    ) {
      const rendered = await fetchDocumentWithBrowser(url, options.browserFallback);
      return {
        url: rendered.url,
        title: rendered.title,
        text: rendered.text,
        links: rendered.links,
      };
    }
    throw e;
  }
}
async function fetchDocumentHttp(url: string, options: SourceOptions = {}): Promise<{
  url: string;
  title: string;
  text: string;
  links: { url: string; title: string }[];
}> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const { bytes, contentType, finalUrl, format } = await download(url, signal);
  signal.throwIfAborted();
  if (format === "pdf") {
    const text = await pdfText(bytes);
    if (!text.trim()) throw Error("PDF 无可提取文本；扫描件需 OCR");
    return {
      url: finalUrl,
      title: finalUrl,
      text: text.slice(0, 120_000),
      links: [],
    };
  }
  if (format === "docx") {
    const mammoth = await import("mammoth");
    const text = (await mammoth.extractRawText({ buffer: bytes })).value;
    if (!text.trim()) throw Error("DOCX 不含可提取文字");
    return {
      url: finalUrl,
      title: finalUrl,
      text: text.slice(0, 120_000),
      links: [],
    };
  }
  if (format === "pptx") {
    const JSZip = (await import("jszip")).default;
    const archive = await JSZip.loadAsync(bytes);
    const paths = Object.keys(archive.files)
      .filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const text = (
      await Promise.all(
        paths.map(async (p) => {
          const xml = await archive.files[p]!.async("string");
          const $ = load(xml, { xmlMode: true });
          return $("a\\:t")
            .toArray()
            .map((x) => $(x).text())
            .join(" ");
        }),
      )
    ).join("\n");
    if (!text.trim()) throw Error("PPTX 不含可提取文字");
    return {
      url: finalUrl,
      title: finalUrl,
      text: text.slice(0, 120_000),
      links: [],
    };
  }
  const declared =
    contentType.match(/charset\s*=\s*['"]?([^;'"\s]+)/i)?.[1] ||
    bytes
      .subarray(0, 4096)
      .toString("ascii")
      .match(/charset\s*=\s*['"]?([^;'"\s/>]+)/i)?.[1] ||
    "utf-8";
  let html: string;
  try {
    html = new TextDecoder(declared).decode(bytes);
  } catch {
    html = bytes.toString("utf8");
  }
  const $ = load(html);
  $("script,style,noscript,nav,footer").remove();
  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    finalUrl;
  const links: { url: string; title: string }[] = [];
  $("a[href]").each((_, a) => {
    try {
      const href = $(a).attr("href");
      if (!href) return;
      const link = normalizeUrl(new URL(href, finalUrl).toString());
      const text = $(a).text().replace(/\s+/g, " ").trim();
      if (text && !links.some((x) => x.url === link))
        links.push({ url: link, title: text });
    } catch {}
  });
  const text = $("body").text().replace(/\s+/g, " ").trim();
  if (!text) throw Error("网页没有可提取的正文，可能需要浏览器或登录");
  return { url: finalUrl, title, text: text.slice(0, 120_000), links };
}
export async function readSource(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  const data = await readFile(path);
  if (data.length > 15_000_000) throw Error("输入文件超过 15 MB");
  if ([".txt", ".md"].includes(ext)) return data.toString("utf8");
  if (ext === ".pdf") return pdfText(data);
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: data })).value;
  }
  throw Error(`暂不支持原文格式 ${ext}；可使用 txt、md、docx、pdf`);
}
export async function saveSource(
  store: Store,
  id: string,
  url: string,
  kind: string,
  titleHint?: string,
  options: SourceOptions = {},
): Promise<Evidence> {
  try {
    const doc = await fetchDocument(url, options);
    options.signal?.throwIfAborted();
    const e = {
      id: randomUUID(),
      competitionId: id,
      url: doc.url,
      title: doc.title === doc.url && titleHint ? titleHint : doc.title,
      text: doc.text,
      fetchedAt: new Date().toISOString(),
      kind,
    };
    store.putEvidence(e);
    store.sourceAttempt(id, url, kind);
    return e;
  } catch (e) {
    store.sourceAttempt(
      id,
      url,
      kind,
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  }
}
/** 下载失败只记录来源尝试，不阻断同一赛事的其他来源和后续制作。 */
export async function saveSourceBestEffort(
  store: Store,
  id: string,
  url: string,
  kind: string,
  titleHint?: string,
  options: SourceOptions = {},
): Promise<Evidence | null> {
  try {
    // fetchDocument 已有有界重试；不得在这里重新开启下载及截止时间。
    return await saveSource(store, id, url, kind, titleHint, options);
  } catch (e) {
    if (isJobControlError(e)) throw e;
    options.signal?.throwIfAborted();
    console.error(
      `来源跳过（${url}）：${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
export async function searchLogged(
  store: Store,
  gateway: ModelGateway,
  id: string | null,
  query: string,
  options?: SearchOptions,
) {
  if (gateway.canSearch === false) {
    store.search(id, query, [], "来源列表模式未配置全网关键词搜索");
    return [];
  }
  try {
    const results = await (options
      ? gateway.search(query, options)
      : gateway.search(query));
    store.search(id, query, results);
    return results;
  } catch (e) {
    if (isJobControlError(e)) throw e;
    const error = e instanceof Error ? e.message : String(e);
    store.search(id, query, [], error);
    console.error(`搜索失败（${query}）：${error}`);
    return [];
  }
}
