/**
 * 可选的轻量人机协同卡点（Human-in-the-Loop Gates）：
 * 仅在显式开启 --interactive-gates（或 quality.interactiveGates=true）且处于交互式终端时触发，
 * 无头/批处理/测试环境完全跳过、零阻塞。
 * 1. 选题确认卡点（Concept Gate）：展示 3 个候选与评审建议，30 秒拍板或微调方向；
 * 2. 一手素材卡点（Asset Gate）：制作前可选挂载本地真实资料（截图/CSV/实验记录/草稿）作为 user 证据。
 */
import * as p from "@clack/prompts";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Store } from "../core/store.js";
import type { Idea } from "./shared.js";
import type { Choice } from "./concepts.js";
import { readSource } from "../competition/sources.js";

export function interactiveAvailable(enabled: boolean | undefined): boolean {
  return !!enabled && !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** 选题确认卡点：默认接受评审推荐方案，支持一键切换候选或补充个人具体想法。 */
export async function runConceptGate(
  ideas: Idea[],
  choice: Choice,
): Promise<{ ideas: Idea[]; choice: Choice }> {
  if (!ideas.length) return { ideas, choice };
  p.note(
    ideas
      .map(
        (idea, idx) =>
          `[${idx + 1}]${idx + 1 === choice.selected ? "（评委推荐）" : ""} ${idea.title}\n    对象：${idea.audience}\n    问题：${idea.problem}\n    机制：${idea.mechanism}`,
      )
      .join("\n\n") + `\n\n评审理由：${choice.analysis}`,
    "人机协同卡点 1/2：选题确认",
  );
  const picked = await p.select({
    message: "选择进入制作的方案（直接回车采纳推荐）",
    initialValue: choice.selected,
    options: ideas.map((idea, idx) => ({
      value: idx + 1,
      label: `${idx + 1}. ${idea.title}`,
      hint: idx + 1 === choice.selected ? "评委推荐" : undefined,
    })),
  });
  if (p.isCancel(picked)) return { ideas, choice };

  const tweak = await p.text({
    message: "可选：补充一句个人想法、已有原型或想突出的角度（留空直接回车继续）",
    placeholder: "例如：结合我做过的边缘目标检测项目，重点突出低功耗推理对比",
    defaultValue: "",
  });
  const nextIdeas = ideas.map((x) => ({ ...x }));
  const nextChoice: Choice = { ...choice, selected: Number(picked) };
  if (!p.isCancel(tweak) && String(tweak).trim()) {
    const note = String(tweak).trim();
    const target = nextIdeas[nextChoice.selected - 1]!;
    target.mechanism = `${target.mechanism}；用户定向补充：${note}`;
    nextChoice.analysis = `${nextChoice.analysis}；已结合用户补充方向：${note}`;
  }
  return { ideas: nextIdeas, choice: nextChoice };
}

/** 一手素材注入卡点：支持在制作开始前挂载本地 txt/md/docx/pdf/csv 资料为 user 证据。 */
export async function runAssetGate(
  store: Store,
  competitionId: string,
): Promise<number> {
  const raw = await p.text({
    message: "人机协同卡点 2/2：如有真实一手资料（实验数据/草稿/说明文件路径，多个用逗号分隔），请粘贴路径；无则直接回车跳过",
    placeholder: "例如：D:\\notes\\experiment.md, D:\\data\\metrics.txt",
    defaultValue: "",
  });
  if (p.isCancel(raw) || !String(raw).trim()) return 0;
  const paths = String(raw)
    .split(/[,，\r\n]+/)
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  let imported = 0;
  for (const file of paths) {
    try {
      const full = resolve(file);
      const text = (await readSource(full)).trim();
      if (!text) continue;
      store.putEvidence({
        id: randomUUID(),
        competitionId,
        url: pathToFileURL(full).href,
        title: `用户提供的资料：${basename(full)}`,
        text,
        fetchedAt: new Date().toISOString(),
        kind: "user",
      });
      imported++;
    } catch (e) {
      p.log.warn(`跳过无法读取的素材 ${file}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (imported) p.log.success(`已导入 ${imported} 份真实用户资料，将直接用于本次制作`);
  return imported;
}
