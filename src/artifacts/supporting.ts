import { isJobControlError } from "../core/job-control.js";
import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import type { Store } from "../core/store.js";
import type { Brief, ModelGateway } from "../core/types.js";
import { modelLabel } from "../agents/models.js";
import {
  Guard,
  Idea,
  record,
  type DeliverableResult,
  type DeliverableStatus,
} from "../workflows/shared.js";

/** 无法制作最终格式时的兜底：写作 Agent 写制作脚本/方案；模型不可用时写本地说明。 */
function deterministicSupportingText(input: {
  competitionTitle: string;
  type: string;
  formats: string[];
  reason: string;
  idea: z.infer<typeof Idea> | null;
  brief?: Brief;
}) {
  const { competitionTitle, type, formats, reason, idea, brief } = input;
  const kind = /翻译|译文|translation/i.test(type)
    ? "translation"
    : /视频|短片|动画|微课|video|animation/i.test(type)
      ? "video"
      : /海报|平面|视觉|美术|摄影|poster|visual/i.test(type)
        ? "visual"
        : /软件|程序|网页|网站|游戏|app|software|game/i.test(type)
          ? "software"
          : /硬件|物联网|装置|机器人|hardware|iot/i.test(type)
            ? "hardware"
            : /音乐|音频|歌曲|配音|music|audio/i.test(type)
              ? "audio"
              : /数据|数据集|大数据|dataset/i.test(type)
                ? "data"
                : /论文|征文|报告|方案|文稿|proposal|paper|report/i.test(type)
                  ? "writing"
                  : "general";
  const ideaText = idea
    ? `**选题：** ${idea.title}\n\n**目标对象：** ${idea.audience}\n\n**要解决的问题：** ${idea.problem}\n\n**拟采用的方法：** ${idea.mechanism}\n\n**验证方式：** ${idea.verification}`
    : "尚无经过确认的作品选题；请先依据比赛要求选定对象、问题和方法。";
  const details: Record<string, string> = {
    translation:
      "## 翻译准备稿\n\n比赛指定原文尚未取得，不能编造译文。下表可在取得原文后逐段填写：\n\n| 段落 | 原文 | 译文 | 术语/疑问 |\n| --- | --- | --- | --- |\n| 1 | 待提供 | 待翻译 | 待核对 |\n\n取得原文后按比赛指定语种、字数和格式完成翻译，并逐段校对。",
    video:
      "## 视频作品脚本与分镜草案\n\n**核心表达：** 用一个真实、具体的场景呈现问题，再展示方案如何回应；具体事实与人物须由参赛者核实或自行拍摄。\n\n| 镜头 | 画面/动作 | 旁白/字幕 | 时长 | 需补充的真实材料 |\n| --- | --- | --- | --- | --- |\n| 1 开场 | 展示目标场景与问题 | 用一句话提出问题 | 5–10 秒 | 真实场景素材 |\n| 2 解释 | 用图示解释问题原因 | 说明依据与限制 | 10–20 秒 | 可核验来源 |\n| 3 展示 | 演示方案的关键步骤 | 讲清使用者如何操作 | 20–40 秒 | 可运行原型/拍摄 |\n| 4 收尾 | 展示预期验证方式 | 不声称尚未取得的效果 | 5–10 秒 | 后续验证计划 |\n\n本文件是脚本材料，尚未生成视频文件。",
    visual:
      "## 视觉作品文案与构图稿\n\n**主标题：** 根据选题拟定，提交前检查与同赛道作品的差异。\n\n**副标题：** 用一句话说明作品解决的问题，不加入未经证实的数据。\n\n**构图：** 主视觉表现目标场景；把问题、方法和结果验证路径分成三个清晰的信息区；重要文字保持高对比并预留安全边距。\n\n**素材清单：** 记录每张图片、字体、图标的来源和许可；没有授权的素材需替换。\n\n本文件是版式与文案草案，尚未生成指定图片或印刷文件。",
    software:
      "## 软件作品需求与页面草案\n\n**核心使用流程：** 进入首页 → 选择目标任务 → 提交真实输入 → 查看解释与结果 → 导出或继续操作。\n\n**页面：** 1. 首页与问题说明；2. 核心操作表单；3. 结果及依据；4. 空状态、错误状态和帮助说明。\n\n**数据边界：** 未接入真实数据前使用明确标注的演示数据，不展示伪造的调查、用户数或成效。\n\n**验收清单：** 关键流程可以操作；输入校验清楚；空状态和错误状态可理解；资源来源可追溯；在目标设备上测试。\n\n本文件是软件制作材料，尚未生成或运行软件原型。",
    hardware:
      "## 硬件/物联网设计材料\n\n**系统组成：** 输入或传感模块 → 控制模块 → 通信/处理模块 → 输出或执行模块。具体器件、接口与参数须由团队按功能和预算选型。\n\n**物料清单（待核实）：** 器件名称 | 型号 | 数量 | 单价来源 | 采购链接 |\n\n**验证计划：** 先单模块通电与接口测试，再进行系统联调；记录电源、环境、安全和故障保护要求。不得把未采购、未测试的硬件描述成已实现。\n\n本文件是设计说明，尚未生成实体装置或实测结果。",
    audio:
      "## 音频/音乐创作稿\n\n**主题与情绪：** 从选题中提炼一个清楚的听众视角，避免把未经核实的事实写进歌词或旁白。\n\n**结构草案：** 引子 → 主题段 → 变化段 → 收束；每段标注目标时长、情绪、声音层次和需要录制的素材。\n\n**制作清单：** 完成原创文本/旋律；确认采样、伴奏和音色授权；录制人声或乐器；混音后检查响度、噪声和提交编码。\n\n本文件是创作与制作说明，尚未生成音频文件。",
    data: "## 数据作品方案\n\n**数据字典（待定）：** 字段名 | 含义 | 类型 | 来源 | 授权/隐私处理 |\n\n**处理流程：** 明确问题与样本范围 → 收集合规数据 → 清洗并记录规则 → 进行分析/可视化 → 报告限制。\n\n在获得真实、合规的数据前不生成虚构观测值或结论。若仅需展示格式，可单独制作并标记合成示例数据。\n\n本文件是数据制作方案，尚未生成数据集或分析结果。",
    writing:
      "## 作品正文草案\n\n### 摘要\n围绕上述问题提出一个可检验的方案。当前材料没有证明方案已实施或取得成效，因此本文将其作为设计/研究提案，不陈述虚构结果。\n\n### 问题与背景\n明确目标对象、具体场景、现有做法及其不足，并为事实补充可核验的公开来源或团队实际调查。\n\n### 方案与论证\n描述方案的关键机制、实施步骤、所需资源和适用条件；解释它如何回应问题，并与已有方案区分。\n\n### 验证计划\n预先确定可观察指标、数据来源、比较基线和失败条件。实际完成前不填写实验结果。\n\n### 局限与下一步\n列出尚待验证的假设、数据和实施条件；确认比赛格式后再整理成正式交付件。",
    general:
      "## 作品制作说明\n\n把交付物拆成可评审的三个部分：问题与目标对象、方案的核心内容、证明作品有效或完整的验证材料。每一项事实都应关联来源或真实记录；没有证据的内容标为假设。\n\n### 作品内容\n围绕选题形成一个具体、可检查的最小成果，说明输入、过程、输出和使用场景。\n\n### 需要团队补充\n真实作者信息、现场/实验材料、授权素材、指定设备或官方模板字段。\n\n### 下一步\n核实官方格式后，把本材料转成对应作品，并按赛事要求测试和导出。",
  };
  const facts = brief
    ? `\n\n**已知交付要求：** ${JSON.stringify(brief.deliverables)}\n\n**已记录规则缺口：** ${brief.missing.join("；") || "暂无"}`
    : "";
  return `# ${competitionTitle}｜${type} 辅助作品包\n\n> 状态：辅助材料/草稿，不是官方格式的最终投稿件。\n> \n> 需求格式：${formats.join("、") || "公告未明确"}。原因：${reason}\n\n## 选题与设计基础\n\n${ideaText}\n\n${details[kind]}${facts}\n\n## 来源与真实性\n\n本包不声称已完成未提供的调查、实验、拍摄、硬件测试或正式翻译。已有来源应在最终作品中逐条核对；素材、数据和个人信息须由参赛者补充并确认授权。\n`;
}

export async function createSupportingArtifact(
  cfg: AppConfig,
  store: Store,
  gateway: ModelGateway,
  input: {
    jobId: string;
    competitionTitle: string;
    type: string;
    formats: string[];
    reason: string;
    idea: z.infer<typeof Idea> | null;
    brief?: Brief;
    key?: string;
  },
): Promise<DeliverableResult> {
  const { jobId, competitionTitle, type, formats, reason, idea, brief, key } =
    input;
  const safeType = type.replace(/[\\/:*?"<>|]/g, "_").slice(0, 48) || "project";
  const prompt = `${Guard}\n请为这项比赛交付一份有实质内容的作品辅助材料，针对指定作品类型进行创作，不要只输出TODO清单。若类型是视频/动画，写完整脚本和分镜；视觉作品写作品文案与构图说明；软件/游戏写页面/功能与使用流程；硬件写系统方案和待核实器件清单；数据作品写字段设计与分析计划；翻译缺原文时只写翻译准备材料，绝不能虚构原文或译文；其他类型写可继续加工的完整正文或作品内容。不得编造实验、采访、数据、作者身份、素材授权或来源。只返回 Markdown 正文。方案、脚本和参数直接、肯定地写，不要防御性写作；只有用户才能提供的真实资料（素材、数据、照片、个人信息等）集中列在文末“需要你提供的资料”一节。\n比赛：${competitionTitle}\n作品类型：${type}\n要求格式：${formats.join(", ") || "未明确"}\n无法完成最终格式的原因：${reason}\n已选方案：${JSON.stringify(idea)}\n比赛档案：${JSON.stringify(brief || null)}`;
  let body = "";
  let generated = false;
  try {
    const value = await gateway.generate("writer", prompt, "writer");
    if (value.trim().length >= 80) {
      body = value.trim();
      generated = true;
    }
  } catch (e) {
    if (isJobControlError(e)) throw e;
  }
  if (!body)
    body = deterministicSupportingText({
      competitionTitle,
      type,
      formats,
      reason,
      idea,
      brief,
    });
  const model = generated ? modelLabel(cfg, "writer") : null;
  const output = await record(
    cfg,
    store,
    jobId,
    key === undefined
      ? "supporting-work-package.md"
      : `supporting-work-${key}-${safeType}.md`,
    `> 本文件是${generated ? "AI 生成的作品辅助草稿" : "本地生成的待制作说明"}，不能替代赛事要求的最终格式。\n> 阻塞原因：${reason}\n\n${body}`,
    model,
  );
  const status: DeliverableStatus = generated
    ? "supporting_material"
    : "blocked";
  return {
    type,
    requestedFormats: formats,
    status,
    artifactPaths: [output],
    gaps: [
      reason,
      ...(!generated
        ? ["模型未能生成作品正文；当前文件仅包含可执行的制作结构和待补信息"]
        : []),
    ],
  };
}
