import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { browserAvailability } from "../artifacts/browser-checks.js";
import type {
  BrowserAction,
  BrowserDriver,
  BrowserSession,
  BrowserSessionOptions,
  DownloadedFile,
  InteractiveElement,
  PageGate,
  PageLink,
  PageSnapshot,
} from "./types.js";

const DEFAULT_VIEWPORT = { width: 1366, height: 900 };
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function safeFilename(name: string): string {
  const cleaned = basename(name || "download")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  return cleaned || `download-${Date.now()}`;
}

/** 识别验证码 / 登录墙 / 支付页等人工门禁，绝不绕过。 */
export function detectPageGate(input: {
  url: string;
  title: string;
  text: string;
  hasPasswordInput: boolean;
  hasCaptchaFrame: boolean;
}): PageGate | null {
  const combined = `${input.url}\n${input.title}\n${input.text.slice(0, 3000)}`;
  if (
    input.hasCaptchaFrame ||
    /请完成安全验证|滑动验证|拼图验证|图形验证码|行为验证|verify you are human|just a moment|cloudflare turnstile|recaptcha|hcaptcha|geetest/i.test(
      combined,
    )
  ) {
    return {
      reason: "captcha",
      detail: "页面存在人机验证或验证码，需由人工在浏览器中直接完成",
    };
  }
  if (
    /收银台|立即支付|微信支付|支付宝扫码|订单支付|checkout|payment/i.test(
      `${input.title}\n${input.text.slice(0, 1500)}`,
    ) &&
    /元|￥|RMB|支付/i.test(input.text.slice(0, 2000))
  ) {
    return {
      reason: "payment",
      detail: "页面涉及付费或收银台，需由人工确认处理",
    };
  }
  if (
    input.hasPasswordInput &&
    /(login|signin|passport|sso|auth|cas)/i.test(input.url)
  ) {
    return {
      reason: "login",
      detail:
        "页面需要账号登录；请先运行 browser-login 保存该站点的登录会话",
    };
  }
  return null;
}

class PlaywrightBrowserSession implements BrowserSession {
  readonly driverName = "playwright";
  private readonly timeoutMs: number;
  private readonly downloadDir: string;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    options: { timeoutMs: number; downloadDir: string },
  ) {
    this.timeoutMs = options.timeoutMs;
    this.downloadDir = options.downloadDir;
  }

  async goto(url: string): Promise<void> {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw Error(`内置浏览器仅支持 HTTP(S) 地址：${url}`);
    }
    await this.page.goto(parsed.toString(), {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });
    // 给 SPA 页面短暂渲染窗口，不阻塞于长轮询。
    await this.page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => {});
  }

  async snapshot(
    options: {
      withScreenshot?: boolean;
      annotateMarks?: boolean;
      maxTextChars?: number;
      maxElements?: number;
    } = {},
  ): Promise<PageSnapshot> {
    const maxTextChars = options.maxTextChars ?? 16_000;
    const maxElements = options.maxElements ?? 80;

    const extracted = await this.page.evaluate(
      ({ maxEl, maxText, drawMarks }) => {
        // 清理上一次叠加的视觉标记层
        document.getElementById("__acm_som_layer")?.remove();

        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
          return true;
        };

        const selector =
          'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]';
        const candidates = Array.from(document.querySelectorAll(selector));
        const elements: {
          ref: string;
          tag: string;
          role: string;
          name: string;
          type?: string;
          placeholder?: string;
          value?: string;
          href?: string;
          disabled?: boolean;
          rect: { x: number; y: number; width: number; height: number };
        }[] = [];

        let overlay: HTMLDivElement | null = null;
        if (drawMarks) {
          overlay = document.createElement("div");
          overlay.id = "__acm_som_layer";
          overlay.style.cssText =
            "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
          document.body?.appendChild(overlay);
        }

        let seq = 0;
        let hasPasswordInput = false;
        for (const el of candidates) {
          const htmlEl = el as HTMLElement;
          if (htmlEl.tagName === "INPUT") {
            const inp = htmlEl as HTMLInputElement;
            if (inp.type === "hidden") continue;
            if (inp.type === "password" && isVisible(el)) {
              hasPasswordInput = true;
            }
          }
          // 文件输入框常被隐藏在自定义上传按钮下方，仍需保留其引用以便上传。
          const isFileInput =
            htmlEl.tagName === "INPUT" &&
            (htmlEl as HTMLInputElement).type === "file";
          if (!isFileInput && !isVisible(el)) continue;
          if (seq >= maxEl) break;

          seq += 1;
          const ref = `e${seq}`;
          htmlEl.setAttribute("data-acm-ref", ref);
          const rect = htmlEl.getBoundingClientRect();
          const role =
            htmlEl.getAttribute("role") ||
            (htmlEl.tagName === "A"
              ? "link"
              : htmlEl.tagName === "BUTTON"
                ? "button"
                : htmlEl.tagName.toLowerCase());
          const rawName =
            htmlEl.getAttribute("aria-label") ||
            htmlEl.getAttribute("title") ||
            (htmlEl as HTMLInputElement).placeholder ||
            (htmlEl.innerText || htmlEl.textContent || "").trim();
          const name = rawName.replace(/\s+/g, " ").trim().slice(0, 120);
          const item: (typeof elements)[number] = {
            ref,
            tag: htmlEl.tagName.toLowerCase(),
            role,
            name,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
          if (htmlEl.tagName === "INPUT") {
            const inp = htmlEl as HTMLInputElement;
            item.type = inp.type;
            if (inp.placeholder) item.placeholder = inp.placeholder.slice(0, 80);
            if (inp.type !== "password" && inp.value) {
              item.value = inp.value.slice(0, 80);
            }
          } else if (
            htmlEl.tagName === "TEXTAREA" ||
            htmlEl.tagName === "SELECT"
          ) {
            const field = htmlEl as HTMLTextAreaElement | HTMLSelectElement;
            if (field.value) item.value = String(field.value).slice(0, 80);
          } else if (htmlEl.tagName === "A") {
            const href = (htmlEl as HTMLAnchorElement).href;
            if (href) item.href = href;
          }
          if ((htmlEl as HTMLButtonElement).disabled) item.disabled = true;
          elements.push(item);

          if (overlay && rect.width > 0 && rect.height > 0) {
            const badge = document.createElement("div");
            badge.textContent = `@${ref}`;
            badge.style.cssText = `position:fixed;left:${Math.max(0, Math.round(rect.x))}px;top:${Math.max(0, Math.round(rect.y))}px;background:#e11d48;color:#fff;font:bold 11px/1 monospace;padding:2px 4px;border-radius:3px;box-shadow:0 1px 2px rgba(0,0,0,.4);`;
            overlay.appendChild(badge);
          }
        }

        const links: { url: string; title: string }[] = [];
        const seen = new Set<string>();
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          const anchor = a as HTMLAnchorElement;
          const href = anchor.href;
          if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
          const title = (anchor.innerText || anchor.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          if (!title) continue;
          seen.add(href);
          links.push({ url: href, title });
          if (links.length >= 120) break;
        }

        const hasCaptchaFrame = Array.from(
          document.querySelectorAll("iframe"),
        ).some((f) =>
          /recaptcha|hcaptcha|turnstile|geetest|captcha/i.test(
            `${f.src} ${f.title} ${f.id}`,
          ),
        );

        const bodyText = (document.body?.innerText || "")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, maxText);

        return {
          url: window.location.href,
          title: document.title || window.location.href,
          text: bodyText,
          elements,
          links,
          hasPasswordInput,
          hasCaptchaFrame,
        };
      },
      {
        maxEl: maxElements,
        maxText: maxTextChars,
        drawMarks: Boolean(options.withScreenshot && options.annotateMarks),
      },
    );

    let ariaTree: string | undefined;
    try {
      const aria = await this.page.locator("body").ariaSnapshot({
        timeout: 3_000,
      });
      ariaTree = aria.slice(0, 8_000);
    } catch {
      /* 部分非标准页面无完整 ARIA 树，降级使用 @e 元素表即可 */
    }

    let screenshot: { data: Buffer; mime: string } | undefined;
    if (options.withScreenshot) {
      const buf = await this.page.screenshot({ type: "png" });
      screenshot = { data: buf, mime: "image/png" };
      if (options.annotateMarks) {
        await this.page
          .evaluate(() => document.getElementById("__acm_som_layer")?.remove())
          .catch(() => {});
      }
    }

    const gate = detectPageGate({
      url: extracted.url,
      title: extracted.title,
      text: extracted.text,
      hasPasswordInput: extracted.hasPasswordInput,
      hasCaptchaFrame: extracted.hasCaptchaFrame,
    });

    return {
      url: extracted.url,
      title: extracted.title,
      text: extracted.text,
      ariaTree,
      elements: extracted.elements as InteractiveElement[],
      links: extracted.links as PageLink[],
      gate,
      screenshot,
    };
  }

  private locateTarget(ref?: string, selector?: string): Locator {
    if (ref) {
      const normalized = ref.replace(/^@/, "");
      return this.page.locator(`[data-acm-ref="${normalized}"]`).first();
    }
    if (selector) {
      return this.page.locator(selector).first();
    }
    throw Error("操作缺少目标元素 ref 或 selector");
  }

  async execute(action: BrowserAction): Promise<{
    ok: boolean;
    note?: string;
    downloaded?: DownloadedFile;
  }> {
    switch (action.action) {
      case "goto":
        await this.goto(action.url);
        return { ok: true, note: `已跳转到 ${this.page.url()}` };

      case "click": {
        if (action.ref || action.selector) {
          const loc = this.locateTarget(action.ref, action.selector);
          await loc.click({ timeout: this.timeoutMs });
        } else if (action.x !== undefined && action.y !== undefined) {
          await this.page.mouse.click(action.x, action.y);
        } else {
          throw Error("click 需要提供 ref、selector 或 (x, y) 坐标");
        }
        await this.page
          .waitForLoadState("networkidle", { timeout: 4_000 })
          .catch(() => {});
        return { ok: true, note: `点击完成，当前页面：${this.page.url()}` };
      }

      case "fill": {
        const loc = this.locateTarget(action.ref, action.selector);
        await loc.fill(action.value, { timeout: this.timeoutMs });
        return { ok: true, note: `已填写字段` };
      }

      case "select": {
        const loc = this.locateTarget(action.ref, action.selector);
        await loc.selectOption(action.value, { timeout: this.timeoutMs });
        return { ok: true, note: `已选择 ${action.value}` };
      }

      case "press": {
        await this.page.keyboard.press(action.key);
        return { ok: true, note: `已按键 ${action.key}` };
      }

      case "scroll": {
        const delta = action.direction === "up" ? -action.amount : action.amount;
        await this.page.evaluate((dy) => window.scrollBy(0, dy), delta);
        await this.page.waitForTimeout(300);
        return {
          ok: true,
          note: `已向${action.direction === "up" ? "上" : "下"}滚动 ${action.amount}px`,
        };
      }

      case "upload": {
        for (const f of action.files) {
          if (!existsSync(f)) throw Error(`待上传文件不存在：${f}`);
        }
        const loc = this.locateTarget(action.ref, action.selector);
        const tag = await loc.evaluate((el) => el.tagName).catch(() => "");
        if (tag === "INPUT") {
          await loc.setInputFiles(action.files, { timeout: this.timeoutMs });
        } else {
          const [chooser] = await Promise.all([
            this.page.waitForEvent("filechooser", { timeout: 10_000 }),
            loc.click({ timeout: this.timeoutMs }),
          ]);
          await chooser.setFiles(action.files);
        }
        return {
          ok: true,
          note: `已选择上传 ${action.files.length} 个文件`,
        };
      }

      case "download": {
        await mkdir(this.downloadDir, { recursive: true });
        if (action.url) {
          const res = await this.context.request.get(action.url, {
            timeout: this.timeoutMs,
          });
          if (!res.ok()) {
            throw Error(`下载失败 (${res.status()}): ${action.url}`);
          }
          const body = await res.body();
          const disp = res.headers()["content-disposition"] || "";
          const match = disp.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
          const rawName = match?.[1]
            ? decodeURIComponent(match[1].replace(/"/g, ""))
            : basename(new URL(action.url).pathname) || "attachment.bin";
          const savedPath = join(
            this.downloadDir,
            `${Date.now()}-${safeFilename(rawName)}`,
          );
          const { writeFile } = await import("node:fs/promises");
          await writeFile(savedPath, body);
          const downloaded: DownloadedFile = {
            url: action.url,
            suggestedFilename: rawName,
            savedPath,
            bytes: body.byteLength,
          };
          return { ok: true, note: `已下载 ${rawName}`, downloaded };
        }
        const loc = this.locateTarget(action.ref, action.selector);
        const [dl] = await Promise.all([
          this.page.waitForEvent("download", { timeout: this.timeoutMs }),
          loc.click({ timeout: this.timeoutMs }),
        ]);
        const suggestedFilename = dl.suggestedFilename() || "attachment";
        const savedPath = join(
          this.downloadDir,
          `${Date.now()}-${safeFilename(suggestedFilename)}`,
        );
        await dl.saveAs(savedPath);
        const bytes = existsSync(savedPath) ? statSync(savedPath).size : 0;
        const downloaded: DownloadedFile = {
          url: dl.url(),
          suggestedFilename,
          savedPath,
          bytes,
        };
        return {
          ok: true,
          note: `已通过浏览器下载 ${suggestedFilename}`,
          downloaded,
        };
      }

      case "wait": {
        await this.page.waitForTimeout(action.ms);
        return { ok: true, note: `等待 ${action.ms}ms` };
      }

      case "back": {
        await this.page
          .goBack({ waitUntil: "domcontentloaded", timeout: this.timeoutMs })
          .catch(() => {});
        return { ok: true, note: `返回到 ${this.page.url()}` };
      }

      case "done":
      case "needs_human":
        return { ok: true };
    }
  }

  async screenshot(path?: string): Promise<Buffer> {
    if (path) {
      return this.page.screenshot({ path, type: "png", fullPage: false });
    }
    return this.page.screenshot({ type: "png", fullPage: false });
  }

  async saveStorageState(path: string): Promise<void> {
    await this.context.storageState({ path });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

export class PlaywrightBrowserDriver implements BrowserDriver {
  readonly name = "playwright";

  async open(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const avail = browserAvailability();
    const executablePath = options.executablePath || avail.executablePath;
    if (!executablePath) {
      throw Error(avail.reason || "未找到可用的 Chromium 浏览器");
    }
    // 默认无头运行：完全在后台控制浏览器，绝不占用用户鼠标或焦点。
    const headless = options.headless ?? true;
    const browser = await chromium.launch({
      headless,
      executablePath,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const context = await browser.newContext({
      ...(options.storageStatePath && existsSync(options.storageStatePath)
        ? { storageState: options.storageStatePath }
        : {}),
      viewport: options.viewport || DEFAULT_VIEWPORT,
      userAgent: options.userAgent || DEFAULT_UA,
      acceptDownloads: true,
      locale: "zh-CN",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return new PlaywrightBrowserSession(browser, context, page, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      downloadDir: options.downloadDir || join(process.cwd(), "downloads"),
    });
  }
}
