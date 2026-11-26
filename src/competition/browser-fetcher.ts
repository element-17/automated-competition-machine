import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BrowserSessionStore,
  PlaywrightBrowserDriver,
  createGatewayBrowserAdapter,
  runBrowserAgent,
  type BrowserAgentResult,
  type BrowserDriver,
  type DownloadedFile,
} from "../browser/index.js";
import type { ModelGateway } from "../core/types.js";
import type { Store } from "../core/store.js";
import { readSource } from "./sources.js";

export interface BrowserFetchOptions {
  dataDir?: string;
  profile?: string;
  downloadDir?: string;
  downloadAttachments?: boolean;
  maxAttachments?: number;
  timeoutMs?: number;
  headless?: boolean;
  driver?: BrowserDriver;
}

export interface BrowserFetchedDocument {
  url: string;
  title: string;
  text: string;
  links: { url: string; title: string }[];
  downloads: DownloadedFile[];
}

const ATTACHMENT_LINK_RE =
  /附件|规程|章程|模板|赛题|报名表|申报书|通知原文|下载|\.(?:pdf|docx|pptx|xlsx|zip)(?:$|\?)/i;

/** 判断静态 HTTP 抓取失败是否适合切换内置无头浏览器重试。 */
export function shouldUseBrowserFallback(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /网页没有可提取的正文|可能需要浏览器|来源不可访问 \((?:401|403|406|412|418|429|520|521)\)|暂不支持此来源类型：unknown|fetch failed|ECONNRESET|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(
    msg,
  );
}

/**
 * 使用后台无头浏览器抓取动态渲染/需登录态的赛事官网，并可自动下载页面中的比赛附件。
 * 不占用用户鼠标或焦点。
 */
export async function fetchDocumentWithBrowser(
  url: string,
  options: BrowserFetchOptions = {},
): Promise<BrowserFetchedDocument> {
  const driver = options.driver || new PlaywrightBrowserDriver();
  const sessionStore = options.dataDir
    ? new BrowserSessionStore(options.dataDir)
    : null;
  const storageStatePath = sessionStore?.resolveForUrl(url, options.profile);
  const downloadDir =
    options.downloadDir ||
    (options.dataDir
      ? join(options.dataDir, "attachments", "general")
      : join(process.cwd(), "downloads"));

  const session = await driver.open({
    headless: options.headless ?? true,
    storageStatePath,
    downloadDir,
    timeoutMs: options.timeoutMs ?? 25_000,
  });

  try {
    await session.goto(url);
    const snap = await session.snapshot({ maxTextChars: 120_000 });
    if (snap.gate) {
      throw Error(
        `浏览器访问受阻（${snap.gate.reason}）：${snap.gate.detail}`,
      );
    }
    if (!snap.text.trim()) {
      throw Error("浏览器渲染后仍无正文，可能需要人工登录或目标页为空");
    }

    const downloads: DownloadedFile[] = [];
    if (options.downloadAttachments) {
      await mkdir(downloadDir, { recursive: true });
      const limit = options.maxAttachments ?? 4;
      const seenUrls = new Set<string>();

      // 优先下载明确指向文件扩展名的直链附件
      for (const link of snap.links) {
        if (downloads.length >= limit) break;
        if (!/\.(?:pdf|docx|pptx|xlsx|zip)(?:$|\?)/i.test(link.url)) continue;
        if (seenUrls.has(link.url)) continue;
        seenUrls.add(link.url);
        try {
          const res = await session.execute({
            action: "download",
            url: link.url,
          });
          if (res.downloaded) downloads.push(res.downloaded);
        } catch {
          /* 单个附件失败不阻塞主文档抓取 */
        }
      }

      // 再尝试点击页面上标注“下载/附件/模板”的交互按钮触发浏览器下载事件
      if (downloads.length < limit) {
        for (const el of snap.elements) {
          if (downloads.length >= limit) break;
          if (!ATTACHMENT_LINK_RE.test(el.name)) continue;
          if (el.href && seenUrls.has(el.href)) continue;
          if (el.tag === "a" && el.href && !/\.(?:pdf|docx|pptx|xlsx|zip)/i.test(el.href) && !/download|attach|file/i.test(el.href)) {
            continue;
          }
          try {
            const res = await session.execute({
              action: "download",
              ref: el.ref,
            });
            if (res.downloaded) {
              downloads.push(res.downloaded);
              if (el.href) seenUrls.add(el.href);
            }
          } catch {
            /* 非下载按钮点击超时忽略 */
          }
        }
      }
    }

    return {
      url: snap.url,
      title: snap.title,
      text: snap.text.slice(0, 120_000),
      links: snap.links,
      downloads,
    };
  } finally {
    await session.close();
  }
}

/** 将浏览器下载的比赛附件（PDF/DOCX/TXT/MD 等）解析正文并写入赛事证据库。 */
export async function ingestDownloadedAttachments(
  store: Store,
  competitionId: string,
  downloads: DownloadedFile[],
): Promise<number> {
  let ingested = 0;
  for (const dl of downloads) {
    const ext = extname(dl.savedPath).toLowerCase();
    let text = "";
    if ([".txt", ".md", ".pdf", ".docx"].includes(ext)) {
      try {
        text = await readSource(dl.savedPath);
      } catch {
        text = "";
      }
    }
    const content = text.trim()
      ? `[本地已下载附件：${dl.savedPath}]\n\n${text.slice(0, 120_000)}`
      : `[本地已下载附件：${dl.savedPath}，文件名：${dl.suggestedFilename}，大小：${dl.bytes} 字节]`;
    store.putEvidence({
      id: randomUUID(),
      competitionId,
      url: dl.url || `file://${dl.savedPath}`,
      title: `附件：${dl.suggestedFilename}`,
      text: content,
      fetchedAt: new Date().toISOString(),
      kind: "attachment",
    });
    ingested += 1;
  }
  return ingested;
}

export interface BrowserExploreOptions {
  dataDir: string;
  profile?: string;
  downloadDir?: string;
  traceDir?: string;
  maxSteps?: number;
  useVision?: boolean;
  headless?: boolean;
  driver?: BrowserDriver;
  onStep?: (step: number, note: string) => void;
}

/**
 * 使用内置 Computer-Use 浏览器代理自主浏览赛事站点、寻找比赛通知或下载附件。
 * 后台运行，不占用用户鼠标键盘。
 */
export async function exploreCompetitionWithBrowser(
  gateway: ModelGateway,
  startUrl: string,
  goal: string,
  options: BrowserExploreOptions,
): Promise<BrowserAgentResult> {
  const driver = options.driver || new PlaywrightBrowserDriver();
  const sessionStore = new BrowserSessionStore(options.dataDir);
  const storageStatePath = sessionStore.resolveForUrl(
    startUrl,
    options.profile,
  );
  const downloadDir =
    options.downloadDir || join(options.dataDir, "attachments", "agent");

  const session = await driver.open({
    headless: options.headless ?? true,
    storageStatePath,
    downloadDir,
  });

  try {
    const model = createGatewayBrowserAdapter(gateway, {
      agent: "reviewer",
      preferVision: options.useVision ?? true,
    });
    return await runBrowserAgent(session, model, goal, {
      startUrl,
      maxSteps: options.maxSteps ?? 12,
      useVision: options.useVision ?? true,
      traceDir: options.traceDir,
      onStep: options.onStep
        ? (t) => options.onStep!(t.step, `${t.action.action}: ${t.note || ""}`)
        : undefined,
    });
  } finally {
    await session.close();
  }
}
