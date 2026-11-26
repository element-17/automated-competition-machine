import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { draftSubmissionEmail } from "./submission-parser.js";
import type {
  DeliveryChannel,
  DeliveryContext,
  DeliveryPlan,
  DeliveryReceipt,
  DeliveryRequest,
  EmailDeliveryConfig,
} from "./types.js";

const EMAIL_VALID_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailTransportFactory = (
  cfg: EmailDeliveryConfig,
  password: string,
) => Transporter;

function defaultTransportFactory(
  cfg: EmailDeliveryConfig,
  password: string,
): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port ?? 465,
    secure: cfg.secure ?? (cfg.port ?? 465) === 465,
    auth: {
      user: cfg.user,
      pass: password,
    },
  });
}

function selectAttachments(
  files: string[],
  bundleZipPath: string | undefined,
  maxMb: number,
): { chosen: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const valid = files.filter((f) => existsSync(f) && statSync(f).isFile());
  const totalBytes = valid.reduce((sum, f) => sum + statSync(f).size, 0);
  const limitBytes = maxMb * 1024 * 1024;
  if (totalBytes <= limitBytes) {
    return { chosen: valid, warnings };
  }
  if (bundleZipPath && existsSync(bundleZipPath)) {
    const zipBytes = statSync(bundleZipPath).size;
    if (zipBytes <= limitBytes) {
      warnings.push(
        `原始附件总大小 ${(totalBytes / 1024 / 1024).toFixed(1)} MB 超过上限 ${maxMb} MB，已自动切换为最终提交压缩包（${(zipBytes / 1024 / 1024).toFixed(1)} MB）`,
      );
      return { chosen: [bundleZipPath], warnings };
    }
  }
  warnings.push(
    `附件总大小 ${(totalBytes / 1024 / 1024).toFixed(1)} MB 超过建议上限 ${maxMb} MB，部分邮箱可能拒收，建议改用网盘链接或浏览器上传`,
  );
  return { chosen: valid, warnings };
}

/**
 * 邮箱交付通道：基于开源社区标准的 nodemailer 实现 SMTP 发信。
 * - 密钥/授权码只从环境变量读取（不落盘 config.json）
 * - 支持 dryRun 演练：生成真实 RFC-822 `.eml` 预览文件而不发送
 */
export class EmailDeliveryChannel implements DeliveryChannel {
  readonly id = "email" as const;
  readonly label = "邮箱交付（SMTP / nodemailer）";

  constructor(
    private readonly transportFactory: EmailTransportFactory = defaultTransportFactory,
  ) {}

  async validate(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const to = request.target.address?.trim() || "";
    if (!to || !EMAIL_VALID_RE.test(to)) {
      errors.push("缺少有效的收件邮箱地址（target.address）");
    }
    const existingFiles = request.files.filter((f) => existsSync(f));
    if (!existingFiles.length) {
      errors.push("没有可附带的有效交付文件");
    }
    if (!request.dryRun) {
      const cfg = context.email;
      if (!cfg?.host) errors.push("未配置邮箱 SMTP 服务器（delivery.email.host）");
      if (!cfg?.user) errors.push("未配置发件邮箱账号（delivery.email.user）");
      const envName = cfg?.passwordEnv || "SMTP_PASS";
      if (!process.env[envName]) {
        errors.push(`未配置邮箱授权码环境变量 ${envName}（请写入 .env）`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  async prepare(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<DeliveryPlan> {
    const maxMb = context.email?.maxAttachmentMb ?? 25;
    const { chosen, warnings } = selectAttachments(
      request.files,
      request.bundleZipPath,
      maxMb,
    );
    const drafted = draftSubmissionEmail({
      competitionTitle: request.competitionTitle,
      files: chosen,
      profile: request.profile,
    });
    const subject = request.target.subject?.trim() || drafted.subject;
    const body = request.target.body?.trim() || drafted.body;
    return {
      channel: this.id,
      summary: `准备向 ${request.target.address || "(未指定)"} 发送 ${chosen.length} 个附件`,
      recipient: request.target.address?.trim() || "",
      files: chosen,
      subject,
      bodyPreview: body,
      warnings,
    };
  }

  async deliver(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const check = await this.validate(request, context);
    if (!check.ok) {
      return {
        id,
        jobId: request.jobId,
        competitionId: request.competitionId,
        channel: this.id,
        status: "failed",
        target: request.target.address || "",
        files: request.files,
        summary: `邮箱交付校验未通过：${check.errors.join("；")}`,
        error: check.errors.join("；"),
        createdAt,
      };
    }

    const plan = await this.prepare(request, context);
    const deliveriesDir = join(context.dataDir, "jobs", request.jobId, "deliveries");
    await mkdir(deliveriesDir, { recursive: true });

    const from =
      context.email?.from ||
      context.email?.user ||
      "competition-assistant@localhost";
    const mailOptions = {
      from,
      to: plan.recipient,
      subject: plan.subject!,
      text: plan.bodyPreview!,
      attachments: plan.files.map((p) => ({
        filename: basename(p),
        path: p,
      })),
    };

    if (request.dryRun) {
      const previewTransport = nodemailer.createTransport({
        streamTransport: true,
        newline: "unix",
        buffer: true,
      });
      const info = await previewTransport.sendMail(mailOptions);
      const previewPath = join(deliveriesDir, `${id}.eml`);
      await writeFile(previewPath, info.message as Buffer);
      return {
        id,
        jobId: request.jobId,
        competitionId: request.competitionId,
        channel: this.id,
        status: "dry_run",
        target: plan.recipient,
        files: plan.files,
        previewPath,
        summary: `已生成邮件演练预览（未发送）：收件人 ${plan.recipient}，主题「${plan.subject}」，附件 ${plan.files.length} 个`,
        createdAt,
      };
    }

    try {
      const cfg = context.email!;
      const password = process.env[cfg.passwordEnv || "SMTP_PASS"] || "";
      const transporter = this.transportFactory(cfg, password);
      const info = await transporter.sendMail(mailOptions);
      return {
        id,
        jobId: request.jobId,
        competitionId: request.competitionId,
        channel: this.id,
        status: "delivered",
        target: plan.recipient,
        files: plan.files,
        messageId: info.messageId,
        summary: `邮件已发送至 ${plan.recipient}（Message-ID: ${info.messageId}），附件 ${plan.files.length} 个`,
        createdAt,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        id,
        jobId: request.jobId,
        competitionId: request.competitionId,
        channel: this.id,
        status: "failed",
        target: plan.recipient,
        files: plan.files,
        summary: `SMTP 发送失败：${msg}`,
        error: msg,
        createdAt,
      };
    }
  }
}
