import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { browserAvailability } from "../artifacts/browser-checks.js";

export interface SavedBrowserProfile {
  name: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

/** 将域名或自定义名称规范化为安全文件名。 */
export function sanitizeProfileName(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) throw Error("浏览器会话名称无效");
  return cleaned.slice(0, 80);
}

/** 从 URL 提取默认会话名（按站点主域名隔离 Cookie 与 LocalStorage）。 */
export function profileNameForUrl(url: string): string {
  try {
    return sanitizeProfileName(new URL(url).hostname);
  } catch {
    return "default";
  }
}

export class BrowserSessionStore {
  readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = join(dataDir, "browser-profiles");
  }

  profilePath(name: string): string {
    return join(this.rootDir, `${sanitizeProfileName(name)}.json`);
  }

  has(name: string): boolean {
    return existsSync(this.profilePath(name));
  }

  /** 按显式 profile 名或目标 URL 自动查找可用的已保存登录态。 */
  resolveForUrl(url: string, explicitProfile?: string): string | undefined {
    if (explicitProfile) {
      const p = this.profilePath(explicitProfile);
      return existsSync(p) ? p : undefined;
    }
    const hostProfile = this.profilePath(profileNameForUrl(url));
    if (existsSync(hostProfile)) return hostProfile;
    // 支持匹配父域名（例如 sub.contest.edu.cn 复用 contest.edu.cn 登录态）
    try {
      const parts = new URL(url).hostname.replace(/^www\./, "").split(".");
      for (let i = 1; i <= parts.length - 2; i++) {
        const parent = this.profilePath(parts.slice(i).join("."));
        if (existsSync(parent)) return parent;
      }
    } catch {
      /* 忽略非法 URL */
    }
    const fallback = this.profilePath("default");
    return existsSync(fallback) ? fallback : undefined;
  }

  list(): SavedBrowserProfile[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = join(this.rootDir, f);
        const st = statSync(full);
        return {
          name: basename(f, ".json"),
          path: full,
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  remove(name: string): boolean {
    const p = this.profilePath(name);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }

  ensureDir(): void {
    mkdirSync(this.rootDir, { recursive: true });
  }
}

export interface InteractiveLoginOptions {
  profile?: string;
  executablePath?: string;
  /** 自定义等待回调（便于 TUI 或测试接管确认流程）；默认从终端按回车确认。 */
  waitForUser?: (info: {
    url: string;
    profileName: string;
    storagePath: string;
  }) => Promise<void>;
}

/**
 * 仅在需要人工登录/扫码/验证码时弹出可见浏览器窗口；
 * 用户完成登录后持久化保存 Cookie 与 LocalStorage，后续所有后台无头操作自动复用且不干扰用户。
 */
export async function openInteractiveLogin(
  store: BrowserSessionStore,
  url: string,
  options: InteractiveLoginOptions = {},
): Promise<{ profileName: string; storagePath: string; finalUrl: string }> {
  const avail = browserAvailability();
  const executablePath = options.executablePath || avail.executablePath;
  if (!executablePath) {
    throw Error(avail.reason || "未找到可用的 Chromium 浏览器");
  }
  const profileName = sanitizeProfileName(
    options.profile || profileNameForUrl(url),
  );
  await mkdir(store.rootDir, { recursive: true });
  const storagePath = store.profilePath(profileName);
  const existing = existsSync(storagePath) ? storagePath : undefined;

  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const context = await browser.newContext({
      ...(existing ? { storageState: existing } : {}),
      viewport: { width: 1280, height: 820 },
      locale: "zh-CN",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });

    if (options.waitForUser) {
      await options.waitForUser({ url, profileName, storagePath });
    } else {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        await rl.question(
          `\n已在浏览器打开 ${url}\n请在弹出的窗口中完成登录（支持扫码/验证码/统一身份认证），完成后回到此处按回车保存登录态…`,
        );
      } finally {
        rl.close();
      }
    }

    await context.storageState({ path: storagePath });
    const finalUrl = page.url();
    await context.close();
    return { profileName, storagePath, finalUrl };
  } finally {
    await browser.close();
  }
}
