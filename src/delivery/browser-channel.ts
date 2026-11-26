import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BrowserSessionStore,
  PlaywrightBrowserDriver,
  runBrowserAgent,
} from "../browser/index.js";
import type {
  DeliveryChannel,
  DeliveryContext,
  DeliveryPlan,
  DeliveryReceipt,
  DeliveryRequest,
} from "./types.js";

/**
 * 浏览器交付通道：复用解耦的内置后台浏览器与 Computer-Use 代理。
 * - 自动加载该域名的已保存登录会话（browser-login）
 * - 后台运行，不占用用户鼠标键盘
 * - 默认开启 stopBeforeSubmit=true：自动填写表单、上传作品文件、保存核对截图后暂停等待人工确认；
 *   只有用户显式传 stopBeforeSubmit=false（--submit）时才点击最终提交按钮。
 */
export class BrowserDeliveryChannel implements DeliveryChannel {
  readonly id = "browser" as const;
  readonly label = "浏览器交付（内置无头浏览器自动填表上传）";

  async validate(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const url = request.target.url?.trim() || "";
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        errors.push("浏览器交付地址必须为 HTTP(S) URL");
      }
    } catch {
      errors.push("缺少有效的浏览器提交网址（target.url）");
    }
    const existingFiles = request.files.filter((f) => existsSync(f));
    if (!existingFiles.length) {
      errors.push("没有可上传的有效交付文件");
    }
    if (!request.dryRun && !context.browserModel) {
      errors.push("浏览器自动填表上传需要提供模型决策适配器（browserModel）");
    }
    return { ok: errors.length === 0, errors };
  }

  async prepare(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<DeliveryPlan> {
    const url = request.target.url?.trim() || "";
    const sessionStore = new BrowserSessionStore(context.dataDir);
    const hasSession = Boolean(
      sessionStore.resolveForUrl(url, request.target.browserProfile),
    );
    const warnings: string[] = [];
    if (!hasSession) {
      warnings.push(
        `尚未找到 ${url} 对应的已保存登录态；若网站需登录，请先运行 compete browser-login "${url}"`,
      );
    }
    if (request.stopBeforeSubmit !== false) {
      warnings.push(
        "当前处于安全确认模式（stopBeforeSubmit=true）：系统将填妥表单并上传文件后截图暂停，不自动点下最终提交按钮。",
      );
    }
    return {
      channel: this.id,
      summary: `通过内置后台浏览器访问 ${url} 并上传 ${request.files.length} 个交付文件`,
      recipient: url,
      files: request.files.filter((f) => existsSync(f)),
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
        target: request.target.url || "",
        files: request.files,
        summary: `浏览器交付校验未通过：${check.errors.join("；")}`,
        error: check.errors.join("；"),
        createdAt,
      };
    }

    const url = request.target.url!.trim();
    const validFiles = request.files.filter((f) => existsSync(f));
    const traceDir = join(
      context.dataDir,
      "jobs",
      request.jobId,
      "deliveries",
      id,
    );
    await mkdir(traceDir, { recursive: true });

    const driver = context.browserDriver || new PlaywrightBrowserDriver();
    const sessionStore = new BrowserSessionStore(context.dataDir);
    const storageStatePath = sessionStore.resolveForUrl(
      url,
      request.target.browserProfile,
    );

    const session = await driver.open({
      headless: context.browserHeadless ?? true,
      storageStatePath,
      downloadDir: join(traceDir, "downloads"),
    });

    try {
      if (request.dryRun) {
        await session.goto(url);
        const snap = await session.snapshot();
        const shotPath = join(traceDir, "dry-run-preview.png");
        await session.screenshot(shotPath).catch(() => {});
        if (snap.gate) {
          return {
            id,
            jobId: request.jobId,
            competitionId: request.competitionId,
            channel: this.id,
            status: "needs_human",
            target: url,
            finalUrl: snap.url,
            files: validFiles,
            screenshots: [shotPath],
            humanReason: snap.gate.reason,
            summary: `演练访问发现门禁（${snap.gate.reason}）：${snap.gate.detail}`,
            createdAt,
          };
        }
        const uploadInputs = snap.elements.filter((e) => e.type === "file").length;
        return {
          id,
          jobId: request.jobId,
          competitionId: request.competitionId,
          channel: this.id,
          status: "dry_run",
          target: url,
          finalUrl: snap.url,
          files: validFiles,
          previewPath: shotPath,
          screenshots: [shotPath],
          summary: `浏览器交付演练成功：已打开「${snap.title}」，识别到 ${snap.elements.length} 个交互元素（其中文件上传控件 ${uploadInputs} 个），未改动任何表单`,
          createdAt,
        };
      }

      const stopBeforeSubmit = request.stopBeforeSubmit !== false;
      const goal = [
        `在赛事官网提交参赛作品：《${request.competitionTitle}》。`,
        `1. 找到作品提交/上传入口并进入提交表单；`,
        `2. 严格依据以下参赛者真实资料填写表单字段（未提供的非必填项留空，绝不编造）：${JSON.stringify(request.profile || {})}`,
        `3. 将以下白名单交付文件上传到对应上传控件：${validFiles.map((f) => `${basename(f)} (${f})`).join("、")}`,
        request.target.instructions ? `补充说明：${request.target.instructions}` : "",
        stopBeforeSubmit
          ? `4. 填完表单并完成文件上传后，不要点击最终提交按钮，返回 needs_human(confirm_submit) 以便用户核对截图。`
          : `4. 核对表单信息与已上传文件无误后，点击提交按钮并等待回执页，返回 done 并记录提交编号/回执摘要。`,
      ]
        .filter(Boolean)
        .join("\n");

      const agentResult = await runBrowserAgent(
        session,
        context.browserModel!,
        goal,
        {
          startUrl: url,
          maxSteps: context.browserMaxSteps ?? 16,
          useVision: context.browserUseVision ?? true,
          traceDir,
          stopBeforeSubmit,
          allowedUploadFiles: validFiles,
        },
      );

      // 若页面刷新了会话 cookie，顺手回存到该站点 profile
      if (storageStatePath) {
        await session.saveStorageState(storageStatePath).catch(() => {});
      }

      return {
        id,
        jobId: request.jobId,
        competitionId: request.competitionId,
        channel: this.id,
        status:
          agentResult.status === "completed"
            ? "delivered"
            : agentResult.status === "needs_human"
              ? "needs_human"
              : "failed",
        target: url,
        finalUrl: agentResult.finalUrl,
        files: validFiles,
        screenshots: agentResult.screenshots,
        humanReason: agentResult.humanReason,
        summary: agentResult.summary,
        ...(agentResult.status === "failed" ? { error: agentResult.summary } : {}),
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
        target: url,
        files: validFiles,
        summary: `浏览器交付异常：${msg}`,
        error: msg,
        createdAt,
      };
    } finally {
      await session.close();
    }
  }
}
