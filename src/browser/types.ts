import { z } from "zod";

/** 可交互元素快照项（类似 agent-browser / Browser-Use 的 @e1 引用，低 token 且精准）。 */
export interface InteractiveElement {
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
}

export interface PageLink {
  url: string;
  title: string;
}

export type HumanGateReason = "captcha" | "login" | "payment" | "confirm_submit";

export interface PageGate {
  reason: HumanGateReason;
  detail: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  ariaTree?: string;
  elements: InteractiveElement[];
  links: PageLink[];
  gate?: PageGate | null;
  screenshot?: { data: Buffer; mime: string };
}

export interface DownloadedFile {
  url: string;
  suggestedFilename: string;
  savedPath: string;
  bytes: number;
}

export const BrowserActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goto"),
    url: z.string().url(),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("click"),
    ref: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("fill"),
    ref: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    value: z.string(),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("select"),
    ref: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    value: z.string(),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("press"),
    key: z.string().min(1),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["down", "up"]).default("down"),
    amount: z.number().int().min(100).max(3000).default(700),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("upload"),
    ref: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    files: z.array(z.string().min(1)).min(1),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("download"),
    ref: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    url: z.string().url().optional(),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("wait"),
    ms: z.number().int().min(200).max(15000).default(1500),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("back"),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("done"),
    summary: z.string().min(1),
    data: z.unknown().optional(),
    thought: z.string().optional(),
  }),
  z.object({
    action: z.literal("needs_human"),
    reason: z.enum(["captcha", "login", "payment", "confirm_submit"]),
    message: z.string().min(1),
    thought: z.string().optional(),
  }),
]);

export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export interface BrowserSessionOptions {
  headless?: boolean;
  storageStatePath?: string;
  downloadDir?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  userAgent?: string;
  executablePath?: string;
}

/**
 * 浏览器会话抽象接口（解耦端口）：
 * 默认由内置 Playwright Headless 引擎实现（完全后台操作，不占用用户鼠标键盘），
 * 后续可无缝替换为 Stagehand / Playwright MCP / 远程 CDP 驱动。
 */
export interface BrowserSession {
  readonly driverName: string;
  goto(url: string): Promise<void>;
  snapshot(options?: {
    withScreenshot?: boolean;
    annotateMarks?: boolean;
    maxTextChars?: number;
    maxElements?: number;
  }): Promise<PageSnapshot>;
  execute(action: BrowserAction): Promise<{
    ok: boolean;
    note?: string;
    downloaded?: DownloadedFile;
  }>;
  screenshot(path?: string): Promise<Buffer>;
  saveStorageState(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  readonly name: string;
  open(options?: BrowserSessionOptions): Promise<BrowserSession>;
}

/** 模型决策适配器：与具体模型 SDK / Gateway 解耦，支持视觉多模态或纯文本 DOM 决策。 */
export interface BrowserModelAdapter {
  readonly supportsVision?: boolean;
  decide(
    prompt: string,
    screenshot?: { data: Buffer; mime: string },
  ): Promise<string>;
}

export interface BrowserStepTrace {
  step: number;
  url: string;
  title: string;
  action: BrowserAction;
  ok: boolean;
  note?: string;
  screenshotPath?: string;
  timestamp: string;
}

export interface BrowserAgentOptions {
  startUrl?: string;
  maxSteps?: number;
  useVision?: boolean;
  traceDir?: string;
  /** 为 true 时在点击“提交/确认提交/发送”类按钮前自动暂停并返回 needs_human(confirm_submit)。 */
  stopBeforeSubmit?: boolean;
  /** 允许上传的本地文件白名单（安全边界：防止模型读取任意宿主机路径）。 */
  allowedUploadFiles?: string[];
  onStep?: (trace: BrowserStepTrace) => void | Promise<void>;
}

export interface BrowserAgentResult {
  status: "completed" | "needs_human" | "failed";
  summary: string;
  finalUrl: string;
  data?: unknown;
  humanReason?: HumanGateReason;
  downloads: DownloadedFile[];
  visitedUrls: string[];
  screenshots: string[];
  steps: BrowserStepTrace[];
}
