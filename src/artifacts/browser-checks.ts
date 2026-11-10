import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { join, extname } from "node:path";
import JSZip from "jszip";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { z } from "zod";
import { atomicWriteJson } from "../workflows/task-receipts.js";
import { assertArtifactResources } from "./resource-checks.js";

const selector = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (s) => !s.includes(">>") && !/^(?:internal|_react|_vue|xpath)=/.test(s),
    "仅使用 CSS 选择器",
  );
const Step = z
  .object({
    action: z.enum(["click", "fill", "select", "check"]),
    selector,
    value: z.string().max(1000).optional(),
  })
  .superRefine((s, c) => {
    if (["fill", "select"].includes(s.action) && s.value === undefined)
      c.addIssue({ code: "custom", message: "输入操作必须有 value" });
  });
const Expect = z
  .object({
    selector,
    text: z.string().min(1).max(1000).optional(),
    visible: z.boolean().optional(),
    value: z.string().max(1000).optional(),
  })
  .refine(
    (e) =>
      e.text !== undefined || e.visible !== undefined || e.value !== undefined,
    "断言必须包含可观察结果",
  );
export const BrowserSuite = z.object({
  cases: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        criterion: z.number().int().min(0).max(11),
        steps: z.array(Step).min(1).max(6),
        expect: z.array(Expect).min(1).max(6),
      }),
    )
    .max(12),
});
export type BrowserSuite = z.infer<typeof BrowserSuite>;
const Status = z.enum(["passed", "failed", "unverified"]);
export const BrowserReport = z.object({
  version: z.literal(1),
  status: Status,
  artifactPath: z.string(),
  artifactSha256: z.string(),
  testedAt: z.string(),
  checks: z.array(
    z.object({ id: z.string(), status: Status, details: z.array(z.string()) }),
  ),
  cases: z.array(
    z.object({
      name: z.string(),
      criterion: z.number(),
      status: Status,
      details: z.array(z.string()),
    }),
  ),
  screenshots: z.array(z.string()),
  issues: z.array(z.string()),
  reportPath: z.string(),
});
export type BrowserReport = z.infer<typeof BrowserReport>;

/** 浏览器使用单独配置目录，不读取用户浏览器或登录状态。 */
export function browserAvailability(): {
  available: boolean;
  executablePath?: string;
  reason?: string;
} {
  const explicit = process.env.COMPETE_BROWSER_EXECUTABLE;
  const candidates = explicit
    ? [explicit]
    : [
        chromium.executablePath(),
        ...(process.platform === "win32"
          ? [
              join(
                process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
                "Microsoft/Edge/Application/msedge.exe",
              ),
              join(
                process.env.ProgramFiles || "C:/Program Files",
                "Google/Chrome/Application/chrome.exe",
              ),
            ]
          : []),
      ];
  const executablePath = candidates.find((p) => existsSync(p));
  return executablePath
    ? { available: true, executablePath }
    : {
        available: false,
        reason:
          "未找到 Chromium；运行 npx playwright install chromium，或设置 COMPETE_BROWSER_EXECUTABLE",
      };
}

/** 只加载交付归档中的普通文件；不把 workspace 或宿主机目录暴露给页面。 */
async function artifactFiles(path: string) {
  const raw = await readFile(path);
  if (raw.length > 25_000_000) throw Error("网页交付文件超过 25 MB 验收限制");
  const hash = createHash("sha256").update(raw).digest("hex"),
    files = new Map<string, Buffer>();
  if (extname(path).toLowerCase() === ".html") files.set("index.html", raw);
  else if (extname(path).toLowerCase() === ".zip") {
    const zip = await JSZip.loadAsync(raw),
      entries = Object.values(zip.files);
    if (entries.length > 250) throw Error("归档条目超过 250 个");
    let total = 0;
    for (const file of entries) {
      const name =
        (file as typeof file & { unsafeOriginalName?: string })
          .unsafeOriginalName || file.name;
      if (
        name.includes("\\") ||
        name.startsWith("/") ||
        name.split("/").some((s) => s === ".." || s === ".") ||
        name.includes(":") ||
        name.includes("\0")
      )
        throw Error("归档包含不安全路径");
      if (file.dir) continue;
      if (
        typeof file.unixPermissions === "number" &&
        (file.unixPermissions & 0o170000) === 0o120000
      )
        throw Error("归档包含符号链接");
      const size = (
        file as unknown as { _data?: { uncompressedSize?: number } }
      )._data?.uncompressedSize;
      if (
        size === undefined ||
        size > 2_000_000 ||
        (total += size) > 25_000_000
      )
        throw Error("归档解压体积超过验收限制");
      files.set(name, await file.async("nodebuffer"));
    }
  } else throw Error("浏览器验收只支持 HTML 或 ZIP");
  if (!files.has("index.html")) throw Error("实际交付物缺少根目录 index.html");
  return { files, hash };
}
export async function softwareArtifactDigest(path: string): Promise<string> {
  const { files } = await artifactFiles(path);
  return `文件：${JSON.stringify([...files.keys()])}\n${[...files]
    .filter(([n]) => /\.(html|js|css|md)$/i.test(n))
    .slice(0, 16)
    .map(([n, b]) => `${n}:\n${b.toString("utf8").slice(0, 8000)}`)
    .join("\n")
    .slice(0, 50000)}`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
/** 声明式步骤由宿主程序解释，模型不能提交脚本、shell 或任意 URL。 */
export async function inspectSoftware(
  artifactPath: string,
  outputDir: string,
  suite?: BrowserSuite,
): Promise<BrowserReport> {
  await mkdir(outputDir, { recursive: true });
  const report: BrowserReport = {
    version: 1,
    status: "unverified",
    artifactPath,
    artifactSha256: "",
    testedAt: new Date().toISOString(),
    checks: [],
    cases: [],
    screenshots: [],
    issues: [],
    reportPath: join(outputDir, "browser-report.json"),
  };
  const save = async () => {
    report.issues = [...new Set(report.issues)].slice(0, 60);
    await atomicWriteJson(report.reportPath, report);
    return report;
  };
  let bundle: Awaited<ReturnType<typeof artifactFiles>>;
  try {
    bundle = await artifactFiles(artifactPath);
    report.artifactSha256 = bundle.hash;
    assertArtifactResources(bundle.files, extname(artifactPath).toLowerCase() === ".html" ? "html" : "zip");
    if (suite) suite = BrowserSuite.parse(suite);
  } catch (e) {
    report.status = "failed";
    report.issues.push(message(e));
    report.checks.push({
      id: "artifact",
      status: "failed",
      details: report.issues,
    });
    return save();
  }
  const available = browserAvailability();
  if (!available.available) {
    report.status = "failed";
    report.issues.push(
      `浏览器不可用，无法验收交互：${available.reason || "未找到可执行文件"}`,
    );
    report.checks.push({
      id: "browser",
      status: "failed",
      details: report.issues,
    });
    return save();
  }
  let browser: Browser | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    timedOut = false;
  const server = createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method || "")) {
      res.writeHead(405);
      res.end();
      return;
    }
    let name: string;
    try {
      name =
        decodeURIComponent(
          new URL(req.url || "/", "http://localhost").pathname,
        ).replace(/^\//, "") || "index.html";
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const content = bundle.files.get(name);
    if (!content) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type":
        mime[extname(name).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("无法启动本地验收服务器");
    const origin = `http://127.0.0.1:${address.port}`;
    const env = Object.fromEntries(
      [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "DISPLAY",
        "XAUTHORITY",
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
      ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
    );
    try {
      browser = await chromium.launch({
        executablePath: available.executablePath,
        headless: true,
        chromiumSandbox: true,
        timeout: 15_000,
        env,
        args: [
          "--disable-background-networking",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      });
    } catch (e) {
      report.status = "failed";
      report.issues.push(`浏览器无法启动：${message(e).slice(0, 1200)}`);
      report.checks.push({
        id: "browser",
        status: "failed",
        details: report.issues,
      });
      return await save();
    }
    timer = setTimeout(() => {
      timedOut = true;
      void browser?.close().catch(() => {});
    }, 90_000);
    timer.unref();
    async function pageFor(
      viewport: { width: number; height: number },
      issues: string[],
    ): Promise<{ context: BrowserContext; page: Page }> {
      const add = (s: string) => {
        if (issues.length < 30) issues.push(s.slice(0, 1000));
      };
      const context = await browser!.newContext({
        viewport,
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      context.setDefaultTimeout(2500);
      context.setDefaultNavigationTimeout(8000);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          add(`离线作品访问外部地址：${url.origin}${url.pathname}`);
          await route.abort();
        } else await route.continue();
      });
      await context.routeWebSocket("**/*", (ws) => {
        add("离线作品尝试 WebSocket 连接");
        ws.close();
      });
      context.on("page", (p) => {
        p.on("pageerror", (e) => add(`JavaScript 错误：${e.message}`));
        p.on("console", (m) => {
          if (m.type() === "error") add(`控制台：${m.text()}`);
        });
        p.on("response", (r) => {
          if (r.status() >= 400 && !r.url().endsWith("/favicon.ico"))
            add(`资源错误 ${r.status()}：${new URL(r.url()).pathname}`);
        });
        p.on("download", (d) => {
          add("验收步骤触发下载，需人工确认");
          void d.cancel();
        });
        p.on("popup", (popup) => {
          add("验收步骤打开新窗口，需人工确认");
          void popup.close();
        });
      });
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "load" });
      await page.waitForTimeout(200);
      return { context, page };
    }
    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 800 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      const issues: string[] = [];
      let context: BrowserContext | undefined;
      try {
        const opened = await pageFor(viewport, issues);
        context = opened.context;
        const page = opened.page;
        if (!(await page.locator("body").innerText()).trim())
          issues.push("页面没有可见正文");
        if (
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 2,
          )
        )
          issues.push(`${name} 视口存在水平溢出`);
        const screenshot = join(outputDir, `${name}.png`);
        await page.screenshot({ path: screenshot, timeout: 5000 });
        report.screenshots.push(screenshot);
      } catch (e) {
        issues.push(message(e));
      } finally {
        await context?.close();
      }
      report.checks.push({
        id: `browser-${name}`,
        status: issues.length ? "failed" : "passed",
        details: issues,
      });
      report.issues.push(...issues);
    }
    for (const [index, test] of (suite?.cases || []).entries()) {
      const issues: string[] = [];
      let context: BrowserContext | undefined, page: Page | undefined;
      try {
        const opened = await pageFor({ width: 1280, height: 800 }, issues);
        context = opened.context;
        page = opened.page;
        for (const step of test.steps) {
          const target = page.locator(`css=${step.selector}`);
          if (step.action === "click") await target.click();
          else if (step.action === "fill") await target.fill(step.value!);
          else if (step.action === "select")
            await target.selectOption(step.value!);
          else await target.check();
        }
        for (const assertion of test.expect) {
          const target = page.locator(`css=${assertion.selector}`);
          await target.waitFor({
            state: assertion.visible === false ? "hidden" : "visible",
          });
          if (assertion.text !== undefined) {
            try {
              await target
                .filter({ hasText: assertion.text })
                .waitFor({ state: "visible" });
            } catch {
              throw Error(
                `${assertion.selector} 未出现预期文字：${assertion.text}`,
              );
            }
          }
          if (assertion.value !== undefined) {
            try {
              await page.waitForFunction(
                ({ selector, value }) =>
                  (document.querySelector(selector) as HTMLInputElement | null)
                    ?.value === value,
                { selector: assertion.selector, value: assertion.value },
                { timeout: 2500 },
              );
            } catch {
              throw Error(`${assertion.selector} 的值与预期不符`);
            }
          }
        }
        await page.waitForTimeout(100);
        const screenshot = join(outputDir, `case-${index + 1}.png`);
        await page.screenshot({ path: screenshot, timeout: 5000 });
        report.screenshots.push(screenshot);
      } catch (e) {
        issues.push(message(e).slice(0, 1000));
        if (page) {
          try {
            const screenshot = join(outputDir, `case-${index + 1}-failed.png`);
            await page.screenshot({ path: screenshot, timeout: 3000 });
            report.screenshots.push(screenshot);
          } catch {
            /* 页面崩溃时保留已记录错误。 */
          }
        }
      } finally {
        await context?.close();
      }
      report.cases.push({
        name: test.name,
        criterion: test.criterion,
        status: issues.length ? "failed" : "passed",
        details: issues,
      });
      report.issues.push(...issues.map((s) => `${test.name}：${s}`));
    }
    // 没有交互用例或没有截图都不能算通过：页面能打开不能证明功能合格，也不能证明视觉可用。
    if (!report.cases.length)
      report.issues.push("尚无有效的关键操作用例；页面能打开不能证明功能合格");
    if (!report.screenshots.length)
      report.issues.push("没有取得任何页面截图，无法确认视觉效果");
    report.status = report.issues.length ? "failed" : "passed";
  } catch (e) {
    report.status = "failed";
    report.issues.push(
      timedOut ? "浏览器验收超过 90 秒，未完成的用例不能视为通过" : message(e),
    );
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return save();
}
