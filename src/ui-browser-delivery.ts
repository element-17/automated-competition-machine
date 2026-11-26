import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  browserSettings,
  deliverySettings,
  loadConfig,
  saveBrowserConfig,
  saveDeliveryConfig,
  type AppConfig,
} from "./core/config.js";
import { saveEnvKey } from "./agents/models.js";
import { OfficialGateway } from "./core/gateway.js";
import type { Store } from "./core/store.js";
import {
  BrowserSessionStore,
  openInteractiveLogin,
  createGatewayBrowserAdapter,
} from "./browser/index.js";
import {
  exploreCompetitionWithBrowser,
  fetchDocumentWithBrowser,
  ingestDownloadedAttachments,
} from "./competition/browser-fetcher.js";
import { normalizeUrl } from "./competition/sources.js";
import {
  createDefaultDeliveryRegistry,
  detectSubmissionTargets,
  resolveJobDeliverableFiles,
} from "./delivery/index.js";

const cancelled = (v: unknown): v is symbol => p.isCancel(v);
const httpUrl = (v?: string) => {
  try {
    const u = new URL((v || "").trim());
    return ["http:", "https:"].includes(u.protocol)
      ? undefined
      : "请输入以 http:// 或 https:// 开头的网址";
  } catch {
    return "网址格式无效";
  }
};

/** 交互式 TUI：内置后台浏览器（登录态管理、动态站点导入、Computer-Use 代理交互）。 */
export async function browserMenu(
  cfg: AppConfig,
  store: Store,
  configPath?: string,
): Promise<AppConfig> {
  const sessionStore = new BrowserSessionStore(cfg.dataDir);
  while (true) {
    const bCfg = browserSettings(cfg);
    const profiles = sessionStore.list();
    const choice = await p.select({
      message: `内置浏览器工具（后台无头模式，不占用鼠标｜已存会话 ${profiles.length} 个）`,
      options: [
        {
          value: "login",
          label: "登录赛事官网并保存会话",
          hint: "弹出窗口人工登录/扫码，保存 Cookie 供后续后台复用",
        },
        {
          value: "import",
          label: "用内置浏览器导入动态/需登录赛事并下载附件",
          hint: "自动渲染 SPA 页面、提取规则与下载附件",
        },
        {
          value: "agent",
          label: "运行浏览器交互代理（Computer-Use）",
          hint: "让模型在后台自主点击、翻页、查找赛事或下载附件",
        },
        {
          value: "sessions",
          label: "管理已保存登录会话",
          hint: profiles.length
            ? profiles.map((x) => x.name).slice(0, 4).join("、")
            : "暂无已存会话",
        },
        {
          value: "settings",
          label: "内置浏览器开关设置",
          hint: `${bCfg.enabled ? "已启用" : "已关闭"} | 自动回退:${bCfg.autoFallback ? "开" : "关"} | 附件抓取:${bCfg.downloadAttachments ? "开" : "关"}`,
        },
        { value: "back", label: "返回主菜单" },
      ],
    });
    if (cancelled(choice) || choice === "back") return cfg;

    try {
      if (choice === "login") {
        const url = await p.text({
          message: "输入需要登录的赛事官网或报名系统地址",
          placeholder: "https://...",
          validate: httpUrl,
        });
        if (cancelled(url)) continue;
        const profile = await p.text({
          message: "会话名称（留空则自动按域名保存）",
          defaultValue: "",
          placeholder: "例如 saikr.com 或 cy.ncss.cn",
        });
        if (cancelled(profile)) continue;
        const res = await openInteractiveLogin(sessionStore, url.trim(), {
          profile: profile.trim() || undefined,
          waitForUser: async ({ profileName }) => {
            await p.confirm({
              message: `已在浏览器打开页面，请完成登录（会话：${profileName}）。登录完成后选择“是”保存登录态`,
              initialValue: true,
            });
          },
        });
        p.log.success(
          `登录态已保存：${res.profileName} -> ${res.storagePath}（当前页：${res.finalUrl}）`,
        );
      } else if (choice === "import") {
        const url = await p.text({
          message: "输入要抓取的赛事公告或官网地址",
          placeholder: "https://...",
          validate: httpUrl,
        });
        if (cancelled(url)) continue;
        const spin = p.spinner();
        spin.start("正在通过内置无头浏览器渲染页面并检查附件（不占用鼠标）…");
        const doc = await fetchDocumentWithBrowser(url.trim(), {
          dataDir: cfg.dataDir,
          downloadAttachments: true,
        });
        spin.stop(`页面渲染完成：${doc.title}`);
        const compId = store.addCompetition(normalizeUrl(doc.url), doc.title);
        store.enqueue(compId);
        if (doc.downloads.length) {
          await ingestDownloadedAttachments(store, compId, doc.downloads);
        }
        p.log.success(
          `已导入并入队：${doc.title}（ID: ${compId}，正文 ${doc.text.length} 字，下载附件 ${doc.downloads.length} 个）`,
        );
      } else if (choice === "agent") {
        const url = await p.text({
          message: "输入起始网址",
          placeholder: "https://...",
          validate: httpUrl,
        });
        if (cancelled(url)) continue;
        const goal = await p.text({
          message: "输入要让浏览器代理完成的任务目标",
          placeholder:
            "例如：找到 2026 年竞赛通知与参赛指南，并下载所有比赛规则与模板附件",
          validate: (v) => (v?.trim() ? undefined : "目标不能为空"),
        });
        if (cancelled(goal)) continue;
        const gateway = new OfficialGateway(cfg, store);
        const spin = p.spinner();
        spin.start("后台浏览器代理正在自主交互（不影响你使用电脑）…");
        const res = await exploreCompetitionWithBrowser(
          gateway,
          url.trim(),
          goal.trim(),
          {
            dataDir: cfg.dataDir,
            maxSteps: bCfg.maxSteps,
            useVision: bCfg.useVision,
            headless: bCfg.headless,
            onStep: (step, note) => spin.message(`第 ${step} 步：${note}`),
          },
        );
        spin.stop(`代理结束（状态：${res.status}）`);
        p.note(
          [
            `结果：${res.summary}`,
            `最终页：${res.finalUrl}`,
            `执行步数：${res.steps.length}，下载附件：${res.downloads.length}`,
            ...(res.downloads.length
              ? res.downloads.map((d) => `  - ${d.suggestedFilename} (${d.savedPath})`)
              : []),
          ].join("\n"),
          "浏览器交互代理报告",
        );
      } else if (choice === "sessions") {
        if (!profiles.length) {
          p.log.info("还没有保存任何浏览器登录会话。");
          continue;
        }
        const target = await p.select({
          message: "选择要删除的会话（按 Esc 返回）",
          options: [
            ...profiles.map((x) => ({
              value: x.name,
              label: x.name,
              hint: `${(x.sizeBytes / 1024).toFixed(1)} KB · 更新于 ${x.updatedAt.slice(0, 19)}`,
            })),
            { value: "__back", label: "返回" },
          ],
        });
        if (cancelled(target) || target === "__back") continue;
        const ok = await p.confirm({
          message: `确认删除登录会话「${target}」？`,
          initialValue: false,
        });
        if (!cancelled(ok) && ok) {
          sessionStore.remove(target);
          p.log.success(`已删除会话 ${target}`);
        }
      } else if (choice === "settings") {
        const enabled = await p.confirm({
          message: "启用内置后台浏览器？",
          initialValue: bCfg.enabled,
        });
        if (cancelled(enabled)) continue;
        const autoFallback = await p.confirm({
          message: "静态抓包失败/遇到动态 SPA 官网时自动切换无头浏览器？",
          initialValue: bCfg.autoFallback,
        });
        if (cancelled(autoFallback)) continue;
        const downloadAttachments = await p.confirm({
          message: "研究赛事时自动用浏览器下载比赛附件并入库？",
          initialValue: bCfg.downloadAttachments,
        });
        if (cancelled(downloadAttachments)) continue;
        const useVision = await p.confirm({
          message: "浏览器代理优先使用视觉截图 + @e 标注决策？（纯文本模型会自动回退 DOM）",
          initialValue: bCfg.useVision,
        });
        if (cancelled(useVision)) continue;
        saveBrowserConfig(configPath, {
          ...bCfg,
          enabled,
          autoFallback,
          downloadAttachments,
          useVision,
        });
        cfg = loadConfig(configPath);
        p.log.success("内置浏览器配置已保存。");
      }
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
}

/** 交互式 TUI：作品交付中心（邮箱 SMTP 交付、浏览器填表上传交付、历史回执）。 */
export async function deliveryMenu(
  cfg: AppConfig,
  store: Store,
  configPath?: string,
): Promise<AppConfig> {
  const registry = createDefaultDeliveryRegistry();
  while (true) {
    const dCfg = deliverySettings(cfg);
    const emailReady = Boolean(
      dCfg.email.host &&
        dCfg.email.user &&
        process.env[dCfg.email.passwordEnv || "SMTP_PASS"],
    );
    const choice = await p.select({
      message: "作品交付中心（邮箱交付 / 浏览器自动上传）",
      options: [
        {
          value: "deliver",
          label: "交付一个已完成任务的作品",
          hint: "自动识别投稿邮箱或官网地址，支持先演练再发送",
        },
        {
          value: "email_setup",
          label: "配置发件邮箱（SMTP）",
          hint: emailReady
            ? pc.green(`已配置 ${dCfg.email.user}`)
            : pc.yellow("未配置（QQ/163/Outlook/校园邮箱均可）"),
        },
        {
          value: "history",
          label: "查看历史交付回执",
          hint: "邮件 Message-ID、演练 .eml、浏览器截图记录",
        },
        { value: "back", label: "返回主菜单" },
      ],
    });
    if (cancelled(choice) || choice === "back") return cfg;

    try {
      if (choice === "email_setup") {
        const host = await p.text({
          message: "SMTP 服务器地址",
          initialValue: dCfg.email.host || "smtp.qq.com",
          placeholder: "如 smtp.qq.com / smtp.163.com / smtp.office365.com",
          validate: (v) => (v?.trim() ? undefined : "不能为空"),
        });
        if (cancelled(host)) continue;
        const portStr = await p.text({
          message: "SMTP 端口（SSL 通常为 465，STARTTLS 为 587）",
          initialValue: String(dCfg.email.port || 465),
          validate: (v) =>
            /^\d+$/.test((v || "").trim()) ? undefined : "请输入整数端口",
        });
        if (cancelled(portStr)) continue;
        const port = Number(portStr.trim());
        const user = await p.text({
          message: "发件邮箱账号",
          initialValue: dCfg.email.user || cfg.profile?.email || "",
          validate: (v) =>
            v?.includes("@") ? undefined : "请输入有效邮箱地址",
        });
        if (cancelled(user)) continue;
        const envName = dCfg.email.passwordEnv || "SMTP_PASS";
        const pass = await p.password({
          message: `输入邮箱 SMTP 授权码/密码（将安全写入 .env 的 ${envName}；留空保持不变）`,
        });
        if (cancelled(pass)) continue;
        if (pass && pass.trim()) {
          saveEnvKey(envName, pass.trim());
        }
        saveDeliveryConfig(configPath, {
          ...dCfg,
          email: {
            ...dCfg.email,
            host: host.trim(),
            port,
            secure: port === 465,
            user: user.trim(),
            from: user.trim(),
            passwordEnv: envName,
          },
        });
        cfg = loadConfig(configPath);
        p.log.success("发件邮箱 SMTP 配置已保存（授权码存于 .env，未写入 config.json）。");
      } else if (choice === "history") {
        const rows = store.deliveries();
        if (!rows.length) {
          p.log.info("尚无交付记录。");
          continue;
        }
        p.note(
          rows
            .slice(0, 15)
            .map(
              (r: any) =>
                `[${String(r.createdAt).slice(0, 19)}] ${r.channel} | ${r.status} | ${r.target}\n  ${r.summary}`,
            )
            .join("\n\n"),
          `最近交付记录（共 ${rows.length} 条）`,
        );
      } else if (choice === "deliver") {
        const recent = store.db
          .prepare(
            "SELECT j.id,j.state,j.competition_id,c.title FROM jobs j JOIN competitions c ON c.id=j.competition_id ORDER BY j.updated_at DESC LIMIT 25",
          )
          .all() as {
          id: string;
          state: string;
          competition_id: string;
          title: string;
        }[];
        if (!recent.length) {
          p.log.info("还没有可交付的任务，请先完成至少一场赛事制作。");
          continue;
        }
        const jobId = await p.select({
          message: "选择要交付的任务",
          options: recent.map((j) => ({
            value: j.id,
            label: `${j.title.slice(0, 36)} (${j.state})`,
            hint: j.id.slice(0, 8),
          })),
        });
        if (cancelled(jobId)) continue;

        const job = store.job(jobId);
        const comp = store.competition(job.competitionId);
        const jobDir = join(cfg.dataDir, "jobs", jobId);
        const outputs = Array.isArray(job.result?.outputs)
          ? (job.result.outputs as string[])
          : [];
        const resolved = resolveJobDeliverableFiles(jobDir, outputs);
        if (!resolved.files.length) {
          p.log.warn(`在 ${jobDir} 下未找到可交付的作品文件。`);
          continue;
        }

        const detected = detectSubmissionTargets(
          comp.brief,
          comp.url,
          store.evidence(comp.id),
        );
        if (detected.length) {
          p.note(
            detected
              .map(
                (d, i) =>
                  `${i + 1}. [${d.channel}] ${d.target}（${d.reason}）`,
              )
              .join("\n"),
            "自动识别到的赛事交付通道",
          );
        }

        const channel = await p.select({
          message: "选择交付方式",
          initialValue: detected[0]?.channel || "email",
          options: [
            { value: "email", label: "邮箱交付（SMTP）" },
            { value: "browser", label: "浏览器交付（后台无头填表上传）" },
          ],
        });
        if (cancelled(channel)) continue;

        const defaultTarget =
          detected.find((d) => d.channel === channel)?.target || "";
        const targetAddr = await p.text({
          message:
            channel === "email"
              ? "收件邮箱地址"
              : "在线提交官网/表单网址",
          initialValue: defaultTarget,
          validate: (v) =>
            channel === "email"
              ? v?.includes("@")
                ? undefined
                : "请输入有效邮箱"
              : httpUrl(v),
        });
        if (cancelled(targetAddr)) continue;

        const mode = await p.select({
          message: "选择执行模式",
          initialValue: "dry_run",
          options: [
            {
              value: "dry_run",
              label: "先演练预览（推荐）",
              hint:
                channel === "email"
                  ? "生成 .eml 邮件预览，不真正发信"
                  : "无头打开提交页并截预览图，不改动表单",
            },
            ...(channel === "browser"
              ? [
                  {
                    value: "fill_only",
                    label: "自动填表与上传附件，提交前暂停确认（推荐）",
                    hint: "模型后台填完并截图后停止，不点最终提交按钮",
                  },
                ]
              : []),
            {
              value: "live",
              label:
                channel === "email"
                  ? "正式发送邮件"
                  : "自动填表、上传并直接提交",
              hint: "将真实对外交付作品",
            },
          ],
        });
        if (cancelled(mode)) continue;

        const bCfg = browserSettings(cfg);
        const gateway = new OfficialGateway(cfg, store, jobId);
        const req = {
          jobId,
          competitionId: comp.id,
          competitionTitle: comp.title,
          files: resolved.files.filter((f) => existsSync(f)),
          bundleZipPath: resolved.bundleZipPath,
          profile: cfg.profile as Record<string, unknown>,
          dryRun: mode === "dry_run",
          stopBeforeSubmit: mode !== "live",
          target:
            channel === "email"
              ? { channel: "email" as const, address: targetAddr.trim() }
              : { channel: "browser" as const, url: targetAddr.trim() },
        };

        const spin = p.spinner();
        spin.start(`正在执行 ${channel} 交付…`);
        const receipt = await registry.execute(req, {
          dataDir: cfg.dataDir,
          email: dCfg.email,
          browserModel: createGatewayBrowserAdapter(gateway, {
            agent: "reviewer",
            preferVision: bCfg.useVision,
          }),
          browserMaxSteps: bCfg.maxSteps,
          browserUseVision: bCfg.useVision,
          browserHeadless: bCfg.headless,
        });
        store.addDelivery(receipt);
        spin.stop(`交付完成（状态：${receipt.status}）`);
        p.note(
          [
            `状态：${receipt.status}`,
            `目标：${receipt.target}`,
            `摘要：${receipt.summary}`,
            receipt.messageId ? `Message-ID：${receipt.messageId}` : "",
            receipt.previewPath ? `预览文件：${receipt.previewPath}` : "",
            receipt.screenshots?.length
              ? `截图：\n${receipt.screenshots.map((s) => `  - ${s}`).join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "交付回执",
        );
      }
    } catch (e) {
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
}
