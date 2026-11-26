import type { BrowserDriver, BrowserModelAdapter } from "../browser/types.js";

export type DeliveryChannelId = "email" | "browser" | (string & {});

export interface EmailDeliveryConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  /** SMTP 密码或授权码所在的环境变量名（如 SMTP_PASS），密钥不写入 config.json。 */
  passwordEnv?: string;
  maxAttachmentMb?: number;
}

export interface DeliveryTarget {
  channel: DeliveryChannelId;
  /** 邮箱交付的目标收件地址。 */
  address?: string;
  /** 浏览器交付的目标官网/报名提交地址。 */
  url?: string;
  /** 邮箱交付的主题与正文（留空时由系统按赛事规则与用户资料自动草拟）。 */
  subject?: string;
  body?: string;
  /** 浏览器交付使用的已保存登录会话名（留空时按域名自动匹配）。 */
  browserProfile?: string;
  /** 附给浏览器交互代理的补充说明（如所选赛道/组别）。 */
  instructions?: string;
}

export interface DeliveryRequest {
  jobId: string;
  competitionId: string;
  competitionTitle: string;
  files: string[];
  target: DeliveryTarget;
  profile?: Record<string, unknown>;
  /** 为 true 时仅演练与生成预览（邮件生成 .eml、浏览器检查页面并截图），不实际发送/提交。 */
  dryRun?: boolean;
  /** 浏览器交付默认在最终“提交”按钮前暂停等待人工确认；仅显式传 false 时才自动点击提交。 */
  stopBeforeSubmit?: boolean;
  /** 邮件交付超过体积阈值时优先改用打包 ZIP 文件。 */
  bundleZipPath?: string;
}

export interface DeliveryPlan {
  channel: DeliveryChannelId;
  summary: string;
  recipient: string;
  files: string[];
  subject?: string;
  bodyPreview?: string;
  warnings: string[];
}

export type DeliveryStatus = "dry_run" | "delivered" | "needs_human" | "failed";

export interface DeliveryReceipt {
  id: string;
  jobId: string;
  competitionId: string;
  channel: DeliveryChannelId;
  status: DeliveryStatus;
  target: string;
  files: string[];
  summary: string;
  messageId?: string;
  finalUrl?: string;
  previewPath?: string;
  screenshots?: string[];
  humanReason?: string;
  error?: string;
  createdAt: string;
}

export interface DeliveryContext {
  dataDir: string;
  email?: EmailDeliveryConfig;
  browserDriver?: BrowserDriver;
  browserModel?: BrowserModelAdapter;
  browserMaxSteps?: number;
  browserUseVision?: boolean;
  browserHeadless?: boolean;
}

/** 交付通道插件契约：新增通道（如 Webhook / 教务 API / 网盘）只需实现此接口并注册。 */
export interface DeliveryChannel {
  readonly id: DeliveryChannelId;
  readonly label: string;
  validate(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<{ ok: boolean; errors: string[] }>;
  prepare(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<DeliveryPlan>;
  deliver(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt>;
}
