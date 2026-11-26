import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Brief, Evidence } from "../core/types.js";

export interface DetectedSubmissionTarget {
  channel: "email" | "browser";
  target: string;
  reason: string;
  subjectHint?: string;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>）)】，,。；;]+/g;

/**
 * 从赛事规则档案（brief）和抓取证据中自动识别交付渠道：
 * - 邮箱投稿（如 xxx@edu.cn）
 * - 官网/平台系统提交（如 报名系统、作品上传平台 URL）
 */
export function detectSubmissionTargets(
  brief: Brief | null | undefined,
  competitionUrl?: string,
  evidence: Evidence[] = [],
): DetectedSubmissionTarget[] {
  const found: DetectedSubmissionTarget[] = [];
  const seen = new Set<string>();

  const push = (item: DetectedSubmissionTarget) => {
    const key = `${item.channel}:${item.target.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(item);
  };

  const submissionTexts: string[] = [];
  for (const d of brief?.deliverables || []) {
    if (d.submission) submissionTexts.push(d.submission);
    if (d.naming) submissionTexts.push(d.naming);
  }
  const combinedBrief = submissionTexts.join("\n");

  // 1. 优先从规则档案的 submission 字段提取收件邮箱与主题要求
  const subjectMatch = combinedBrief.match(
    /(?:邮件主题|主题格式|标题格式|邮件标题)[：:\s]*([^\n。；;]{3,80})/,
  );
  const subjectHint = subjectMatch?.[1]?.trim();

  for (const email of combinedBrief.match(EMAIL_RE) || []) {
    push({
      channel: "email",
      target: email,
      reason: "来自赛事规则档案的提交邮箱",
      subjectHint,
    });
  }

  for (const url of combinedBrief.match(URL_RE) || []) {
    const cleaned = url.replace(/[.,;!?]+$/, "");
    push({
      channel: "browser",
      target: cleaned,
      reason: "来自赛事规则档案的在线提交网址",
    });
  }

  // 2. 若规则档案未提取出邮箱，在原始证据的“投稿/提交/邮箱”上下文中补充查找
  if (!found.some((x) => x.channel === "email")) {
    for (const ev of evidence) {
      const snippets = ev.text.match(/.{0,35}(?:投稿|提交|报送|发至|发送至|邮箱).{0,80}/g) || [];
      for (const s of snippets) {
        for (const email of s.match(EMAIL_RE) || []) {
          push({
            channel: "email",
            target: email,
            reason: `来自证据页《${ev.title.slice(0, 40)}》`,
            subjectHint,
          });
        }
      }
    }
  }

  // 3. 兜底：若赛事入口页本身存在，可作为浏览器交付起点（由模型定位登录/提交入口）
  if (competitionUrl && /^https?:\/\//i.test(competitionUrl)) {
    push({
      channel: "browser",
      target: competitionUrl,
      reason: "赛事官网入口（内置浏览器可自动定位报名与上传入口）",
    });
  }

  return found;
}

/** 自动解析某次任务的可提交交付文件（优先 final/ 目录及最终提交包 ZIP）。 */
export function resolveJobDeliverableFiles(
  jobDir: string,
  recordedOutputs: string[] = [],
): { files: string[]; bundleZipPath?: string } {
  const finalDir = join(jobDir, "final");
  const files: string[] = [];
  let bundleZipPath: string | undefined;

  if (existsSync(finalDir)) {
    for (const name of readdirSync(finalDir)) {
      const full = join(finalDir, name);
      if (statSync(full).isFile()) files.push(full);
    }
  }

  for (const out of recordedOutputs) {
    if (!existsSync(out) || !statSync(out).isFile()) continue;
    const base = basename(out);
    if (base.endsWith(".zip") && /提交包|bundle|submission/i.test(base)) {
      bundleZipPath = bundleZipPath || out;
      continue;
    }
    if (
      !files.includes(out) &&
      !base.endsWith(".json") &&
      !/需要你提供的资料\.md$/i.test(base)
    ) {
      files.push(out);
    }
  }

  // 若未在 outputs 中找到打包 ZIP，则在 jobDir 根目录检查常见提交包命名
  if (!bundleZipPath && existsSync(jobDir)) {
    for (const name of readdirSync(jobDir)) {
      if (name.endsWith(".zip") && /提交包|final|submission/i.test(name)) {
        const full = join(jobDir, name);
        if (statSync(full).isFile()) {
          bundleZipPath = full;
          break;
        }
      }
    }
  }

  if (!files.length && bundleZipPath) {
    files.push(bundleZipPath);
  }

  return { files, bundleZipPath };
}

/** 根据用户资料、赛事名与文件列表自动草拟规范中文投稿邮件主题和正文。 */
export function draftSubmissionEmail(input: {
  competitionTitle: string;
  files: string[];
  profile?: Record<string, unknown>;
  subjectHint?: string;
}): { subject: string; body: string } {
  const p = input.profile || {};
  const str = (k: string) =>
    typeof p[k] === "string" ? (p[k] as string).trim() : "";
  const school = str("school");
  const name = str("name");
  const team = str("teamName");
  const studentId = str("studentId");
  const phone = str("phone");
  const email = str("email");
  const advisor = str("advisor");

  const senderTag = [school, team || name].filter(Boolean).join("-");
  const subject = senderTag
    ? `【参赛作品提交】${input.competitionTitle}-${senderTag}`
    : `【参赛作品提交】${input.competitionTitle}`;

  const infoLines = [
    school ? `学校：${school}` : "",
    team ? `团队名称：${team}` : "",
    name ? `负责人/作者：${name}` : "",
    studentId ? `学号：${studentId}` : "",
    advisor ? `指导教师：${advisor}` : "",
    phone ? `联系电话：${phone}` : "",
    email ? `联系邮箱：${email}` : "",
  ].filter(Boolean);

  const fileLines = input.files.map((f, i) => `${i + 1}. ${basename(f)}`);

  const body = [
    `尊敬的${input.competitionTitle}组委会老师：`,
    "",
    `您好！现提交本团队/个人的参赛作品材料，详见附件清单：`,
    ...fileLines,
    "",
    ...(infoLines.length ? ["参赛者信息：", ...infoLines, ""] : []),
    ...(input.subjectHint ? [`（注：赛事主题格式参考：${input.subjectHint}）`, ""] : []),
    "感谢各位评委与组委会老师的辛勤审阅！如有材料需补充，敬请随时联系。",
    "",
    "此致",
    "敬礼！",
  ].join("\n");

  return { subject, body };
}
