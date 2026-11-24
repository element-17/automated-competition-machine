import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import sharp from "sharp";
import {
  Work,
  parseTypographyRules,
  renderWork,
  validateWork,
} from "../dist/artifacts/artifacts.js";
import { renderChartPng, renderMermaidPng } from "../dist/artifacts/diagrams.js";
import { countPdfImages, renderers } from "../dist/artifacts/doc-render.js";
import { checkLayout } from "../dist/artifacts/layout-check.js";
import {
  formatArtifactMetadata,
  measureArtifact,
  requiredDocumentImages,
} from "../dist/artifacts/delivery-checks.js";
import {
  assertSafeSimulationCode,
  detectPython,
  needsSimulation,
  runSimulationScript,
} from "../dist/artifacts/simulation.js";
import { contrastRatio } from "../dist/artifacts/slide-templates.js";
import { modelWarnings } from "../dist/agents/models.js";
import { promptOf } from "../dist/agents/prompts.js";
import { assessWinnability } from "../dist/competition/winnability.js";
import { screenQueue } from "../dist/competition/screening.js";
import { readSource } from "../dist/competition/sources.js";
import {
  applyProfile,
  coveredByProfile,
  profileEntries,
  profileNote,
} from "../dist/core/profile.js";
import { Store } from "../dist/core/store.js";
import { detectAiCliches } from "../dist/workflows/judge-rubric.js";
import { Plan, planProblems, runOrchestration } from "../dist/workflows/orchestrator.js";

const exec = promisify(execFile);

function reviewJSON(prompt, verdict) {
  const raw =
    prompt.match(/本次负责的标准：(\[[^\n]*\])。JSON/)?.[1] ||
    prompt.match(/同时核验这些视觉标准：(\[[^\n]*\])。/)?.[1];
  const expected = raw ? JSON.parse(raw) : [];
  return JSON.stringify({
    ...verdict,
    criteria: expected.map(({ criterion, requirement }) => ({
      criterion,
      status: verdict.pass === false || verdict.issues?.length ? "failed" : "passed",
      evidence: `测试核验：${requirement}`,
    })),
  });
}

test("DOCX 富排版：表格转 w:tbl、公式无残留 $、支持有序列表与真实嵌入图片/Mermaid/Chart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rich-docx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imgPath = join(dir, "hero.png");
  await writeFile(
    imgPath,
    await sharp({ create: { width: 640, height: 400, channels: 3, background: "#1B4F72" } })
      .png()
      .toBuffer(),
  );
  const typo = parseTypographyRules([
    "标题黑体二号，正文宋体小四、1.5倍行距、段前段后0、页边距2.54cm",
  ]);
  assert.equal(typo.bodyFont, "宋体");
  assert.equal(typo.bodySizePt, 12);
  assert.equal(typo.lineSpacing, 1.5);

  const md = [
    "作者：程磊",
    "学校：东北师范大学",
    "",
    "## 1. 核心公式与参数表",
    "距离分辨率满足 $\\Delta R = c / (2B) \\approx 0.30\\ \\text{m}$，功耗 $\\le 4.5\\ \\text{W}$，中心频率 $f_c = 6.5\\ \\text{GHz}$。",
    "",
    "| 模块 | 型号 | 成本（元） |",
    "| --- | --- | --- |",
    "| 主控 | STM32H7 | 48 |",
    "| 雷达 | IR-UWB | 260 |",
    "",
    "1. 完成硬件装配与标定",
    "2. 执行数值仿真边界验证",
    "",
    "![核心结构渲染图](hero)",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[数据采集] --> B[边缘推理] -->|预警| C[终端提示]",
    "```",
    "",
    "```chart",
    JSON.stringify({
      type: "bar",
      title: "方案能耗对比",
      yLabel: "功率(W)",
      unit: "W",
      labels: ["传统方案", "本系统"],
      series: [{ name: "平均功耗", values: [12.5, 4.2] }],
    }),
    "```",
  ].join("\n");

  const work = Work.parse({ kind: "text", title: "智能边缘调度技术方案", text: md, typography: typo });
  const out = await renderWork(work, "docx", dir, "proposal", { hero: imgPath });
  const zip = await JSZip.loadAsync(await readFile(out));
  const docXml = await zip.file("word/document.xml").async("string");
  assert.match(docXml, /<w:tbl\b/, "生成真实 Word 表格");
  assert.ok((docXml.match(/<w:drawing\b/g) || []).length >= 3, "嵌入 3 张图（主图+Mermaid+Chart）");

  const extracted = await readSource(out);
  assert.doesNotMatch(extracted, /\|---\|/, "不残留 Markdown 表格分隔符");
  assert.doesNotMatch(extracted, /\$/, "不残留原始 LaTeX 美元符");
  assert.doesNotMatch(extracted, /\\le|\\approx|\\Delta/, "不残留原始 LaTeX 命令");
  assert.match(extracted, /ΔR/);
  assert.match(extracted, /≤/);

  const metric = await measureArtifact(out);
  assert.equal(metric.tableCount, 1);
  assert.ok((metric.imageCount || 0) >= 3);
  assert.equal(metric.typography?.bodyFont, "宋体");
  assert.equal(metric.typography?.bodySizePt, 12);
  assert.match(formatArtifactMetadata([metric]), /实测嵌入图片数=[3-9]/);
});

test("防假图拦截：正文伪造不存在的图片链接被 validateWork 拒绝；空图集 PDF 被拦截", async (t) => {
  const fakeWork = Work.parse({
    kind: "text",
    title: "青绿三联图",
    text: "![第一幅成品](image_malachite_peaks.png)\n说明正文。",
  });
  const issues = validateWork(fakeWork, {});
  assert.match(issues.join(" "), /不存在的图片 image_malachite_peaks\.png/);

  assert.deepEqual(
    requiredDocumentImages(["文档内收录的最终版生成图片总数严格为3张"]),
    { minimum: 3, maximum: 3 },
  );
  assert.deepEqual(
    requiredDocumentImages(["AI生成图片作品（PDF整合文档）"]),
    { minimum: 1 },
  );

  // 渲染含真实图片的 PDF 并校验 countPdfImages 与 PDF 版面检查
  const dir = await mkdtemp(join(tmpdir(), "rich-pdf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imgPath = join(dir, "art.png");
  await writeFile(
    imgPath,
    await sharp({ create: { width: 512, height: 512, channels: 3, background: "#16A085" } })
      .png()
      .toBuffer(),
  );
  const pdfWork = Work.parse({
    kind: "text",
    title: "图文作品集",
    text: "## 第一幅\n![测试画作](art)\n完整创作阐述与结尾。",
    typography: { pdfLayout: "portfolio" },
  });
  const pdfPath = await renderWork(pdfWork, "pdf", dir, "album", { art: imgPath });
  assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), "%PDF-");
  const imgCount = await countPdfImages(pdfPath);
  assert.ok(imgCount >= 1, `PDF 应实际嵌入图片，当前=${imgCount}`);

  // planProblems 现已允许对 PDF 承诺 visual 标准
  const pdfPlan = Plan.parse({
    tasks: [
      {
        id: "album",
        deliverable: 0,
        title: "作品画册",
        kind: "document",
        format: "pdf",
        instructions: "输出图文 PDF",
        acceptance: ["版面美观清晰", "正文完整"],
        acceptanceChecks: [
          { criterion: 0, checks: ["visual"] },
          { criterion: 1, checks: ["content"] },
        ],
      },
    ],
  });
  assert.deepEqual(
    planProblems(
      pdfPlan,
      {
        title: "测试",
        edition: null,
        eligibility: null,
        deadline: null,
        ai_rules: null,
        scoring: null,
        deliverables: [{ type: "作品画册", quantity: null, formats: ["pdf"], limits: [], naming: null, attachments: [], submission: null, official_template: null }],
        requires_idea: false,
        missing: [],
        citations: [],
        research: { past_winners: [], past_works: [], judging: [], missing: [] },
      },
      false,
    ),
    [],
  );

  // checkLayout 可直接对 PDF 执行逐页视觉检查（不依赖 officecli）
  const origPdf = renderers.pdf;
  t.after(() => { renderers.pdf = origPdf; });
  const tinyPng = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  const pdfText = await readSource(pdfPath);
  renderers.pdf = async () => ({
    pages: 1,
    text: [pdfText],
    png: async () => tinyPng,
    dispose: async () => {},
  });
  const layout = await checkLayout(
    {
      inspectImage: async () => JSON.stringify({ issues: [], suggestions: [] }),
    },
    pdfPath,
  );
  assert.equal(layout.complete, true);
  assert.equal(layout.totalPages, 1);
  assert.equal(layout.textCoverage, "verified");
});

test("语义化 PPTX 母版引擎与程序化版面规则检查（字号/标题/字数/对比度）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "semantic-ppt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imgPath = join(dir, "arch.png");
  await writeFile(
    imgPath,
    (await renderMermaidPng("flowchart TD\nA[传感器] --> B[边缘MCU] --> C[告警]")).data,
  );
  const deck = Work.parse({
    kind: "slides",
    title: "边缘节能调度系统答辩",
    theme: "tech-dark",
    slides: [
      { layout: "cover", title: "边缘节能调度系统", subtitle: "峰谷电价协同优化", meta: ["程磊", "东北师范大学"] },
      { layout: "hero-stats", title: "核心仿真指标", metrics: [{ value: "23.4%", label: "综合节电率", detail: "24小时峰谷仿真" }, { value: "1.4年", label: "投资回收期", detail: "单机房测算" }] },
      { layout: "two-column", title: "痛点与突破", left: { heading: "现有痛点", points: ["夜间空转能耗高", "峰电冷机负载大"] }, right: { heading: "本方案突破", points: ["弹性作业移峰填谷", "液冷余热回收复用"] } },
      { layout: "architecture", title: "系统架构", mermaid: "flowchart LR\nA[作业队列] --> B[优化调度器] --> C[GPU节点]", bullets: ["低开销启发式求解", "支持 SLA 截止期硬约束"] },
      { layout: "table", title: "核心硬件 BOM 清单", table: { headers: ["部件", "规格", "单价(元)"], rows: [["边缘网关", "RK3588", "480"], ["功率采集", "RS485电表", "120"]] } },
      { layout: "chart", title: "分时段能耗对比", chart: { type: "line", title: "24小时负荷曲线", labels: ["0时", "6时", "12时", "18时"], series: [{ name: "基线", values: [30, 45, 95, 88] }, { name: "优化后", values: [58, 52, 62, 55] }] }, bullets: ["峰时峰值下降 34%"] },
      { layout: "image-text", title: "链路示意", imageRef: "arch", bullets: ["端到端延迟低于 50ms"] },
      { layout: "timeline", title: "实施与验证路线", steps: [{ phase: "M1", title: "仿真验证", detail: "完成电价边界测试" }, { phase: "M2", title: "机房试点", detail: "部署 4 机柜试运行" }] },
      { layout: "ending", title: "敬请各位评委批评指正", bullets: ["算法可复现", "成本可控", "节能显著"], meta: ["东北师范大学 · 程磊"] },
    ],
  });
  const out = await renderWork(deck, "pptx", dir, "deck", { arch: imgPath });
  const zip = await JSZip.loadAsync(await readFile(out));
  const slidesCount = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
  assert.equal(slidesCount, 9);
  assert.ok(Object.keys(zip.files).some((f) => /^ppt\/media\/.+\.(png|jpe?g)$/i.test(f)));

  // 自由布局程序化检查（A6）
  assert.ok(contrastRatio("FFFFFF", "1B4F72") > 7);
  assert.ok(contrastRatio("CCCCCC", "FFFFFF") < 2);
  const badFreeform = Work.parse({
    kind: "slides",
    title: "坏版面",
    slides: [
      {
        background: "FFFFFF",
        elements: [
          { type: "text", text: "小标题", x: 0.5, y: 0.3, w: 4, h: 0.6, fontSize: 18, color: "CCCCCC" },
          { type: "text", text: "一".repeat(230), x: 0.5, y: 1.2, w: 12, h: 5, fontSize: 12, color: "202832" },
        ],
      },
    ],
  });
  const errs = validateWork(badFreeform).join("；");
  assert.match(errs, /缺少标题级文本/);
  assert.match(errs, /文字过多/);
  assert.match(errs, /小于 14/);
  assert.match(errs, /对比度/);
});

test("数值仿真沙箱：安全拦截危险模块，真实执行纯数学建模并输出高清 PNG 图表", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sim-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => assertSafeSimulationCode("import subprocess\nsubprocess.run(['ls'])"), /安全检查/);
  assert.throws(() => assertSafeSimulationCode("import requests\nrequests.get('http://a')"), /安全检查/);
  assert.throws(() => assertSafeSimulationCode("fetch('https://example.com')"), /安全检查/);

  assert.equal(
    needsSimulation({ title: "中美青年创客大赛", scoring: "技术方案", deliverables: [{ type: "技术方案书", quantity: null, formats: ["docx"], limits: [], naming: null, attachments: [], submission: null, official_template: null }], edition: null, eligibility: null, deadline: null, ai_rules: null, requires_idea: true, missing: [], citations: [], research: { past_winners: [], past_works: [], judging: [], missing: [] } }, { title: "边缘调度" }),
    true,
  );
  assert.equal(
    needsSimulation({ title: "华语大学生诗歌大赛", scoring: "意象与情感", deliverables: [{ type: "诗歌作品", quantity: null, formats: ["docx"], limits: [], naming: null, attachments: [], submission: null, official_template: null }], edition: null, eligibility: null, deadline: null, ai_rules: null, requires_idea: true, missing: [], citations: [], research: { past_winners: [], past_works: [], judging: [], missing: [] } }, { title: "冬夜诗稿" }),
    false,
  );

  const hasPy = !!(await detectPython());
  const code = hasPy
    ? `import json, math
bom = [("边缘网关", 480), ("电表模组", 120), ("温湿度阵列", 85)]
total = sum(p for _, p in bom)
out = {
  "methodology": "基于 24 小时峰谷电价的离散负荷优化模型",
  "disclaimer": "本地 Python 数值仿真结果",
  "metrics": [{"name": "单节点BOM总成本", "value": total, "unit": "元", "basis": "物料清单求和"}],
  "tables": [{"title": "BOM明细", "headers": ["部件", "单价(元)"], "rows": [[n, str(p)] for n, p in bom]}],
  "charts": [{"type": "pie", "title": "BOM成本构成", "unit": "元", "labels": [n for n, _ in bom], "series": [{"name": "成本", "values": [p for _, p in bom]}]}]
}
print(json.dumps(out, ensure_ascii=False))`
    : `const bom = [["边缘网关", 480], ["电表模组", 120], ["温湿度阵列", 85]];
const total = bom.reduce((s, x) => s + x[1], 0);
console.log(JSON.stringify({
  methodology: "基于 24 小时峰谷电价的离散负荷优化模型",
  disclaimer: "本地 Node 数值仿真结果",
  metrics: [{ name: "单节点BOM总成本", value: total, unit: "元", basis: "物料清单求和" }],
  tables: [{ title: "BOM明细", headers: ["部件", "单价(元)"], rows: bom.map(([n, p]) => [n, String(p)]) }],
  charts: [{ type: "pie", title: "BOM成本构成", unit: "元", labels: bom.map(x => x[0]), series: [{ name: "成本", values: bom.map(x => x[1]) }] }]
}));`;
  const sim = await runSimulationScript(
    { language: hasPy ? "python" : "javascript", purpose: "核算 BOM 与构成", code },
    dir,
  );
  assert.equal(sim.output.metrics[0].value, 685);
  assert.equal(sim.charts.length, 1);
  assert.equal((await readFile(sim.charts[0].path)).subarray(1, 4).toString(), "PNG");
});

test("两级评委打分卡与定向冲奖精修：低分触发精修并单调择优，跨文档传递 Project Spec", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rubric-polish-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.ok(detectAiCliches("随着人口老龄化进程的全面加速，养老问题日益严峻。").length >= 1);

  const compId = store.addCompetition("https://example.edu.cn/rubric", "创新报告赛");
  store.setBrief(compId, {
    title: "创新报告赛",
    edition: "2026",
    eligibility: null,
    deadline: null,
    ai_rules: null,
    scoring: "创新性、深度、可验证性",
    deliverables: [
      { type: "主方案报告", quantity: null, formats: ["txt"], limits: [], naming: null, attachments: [], submission: null, official_template: null },
      { type: "摘要说明", quantity: null, formats: ["txt"], limits: [], naming: null, attachments: [], submission: null, official_template: null },
    ],
    requires_idea: true,
    missing: [],
    citations: [],
    research: { past_winners: [], past_works: [], judging: [], missing: [] },
  });
  const jobId = store.createJob(compId, "automatic", {}, 40);
  const cfg = {
    dataDir: dir,
    execution: { productionRounds: 3, plannerRounds: 2 },
    quality: { rubricScoring: true, minScore: 84, polishRounds: 1, simulation: false, interactiveGates: false },
    writer: { providerID: "google", id: "gemini-pro" },
    reviewer: { providerID: "anthropic", id: "claude-sonnet" },
    maxCalls: 40,
    sources: [],
    profile: {},
  };

  let mainWrites = 0;
  let polishPromptSeen = "";
  let secondaryPromptSeen = "";
  const gateway = {
    search: async () => [],
    inspectImage: async (p) => reviewJSON(p, { issues: [], suggestions: [] }),
    generate: async (_role, prompt) => {
      if (prompt.includes("拆解成可以实际制作的文件任务")) {
        return JSON.stringify({
          tasks: [
            { id: "main-doc", deliverable: 0, title: "主方案报告", kind: "document", format: "txt", instructions: "写完整主方案", acceptance: ["内容完整"] },
            { id: "summary-doc", deliverable: 1, title: "作品声明摘要", kind: "document", format: "txt", instructions: "写一致的摘要", acceptance: ["内容完整"] },
          ],
          packages: [],
          notes: [],
        });
      }
      if (prompt.includes("直接创作")) {
        if (prompt.includes("任务：主方案报告")) {
          mainWrites++;
          if (mainWrites === 2) polishPromptSeen = prompt;
          return JSON.stringify({
            kind: "text",
            title: "边缘算力调度",
            text: mainWrites === 1
              ? "随着人工智能技术的快速发展，机房能耗较高。单机柜额定功率 8.5kW，BOM成本 685元。"
              : "## 核心机制\n直接切入高校 GPU 机房夜间空转约束：单机柜额定功率 8.5kW，BOM成本 685元，峰谷转移后节电率达 23.4%。",
            sources: [],
          });
        }
        secondaryPromptSeen = prompt;
        return JSON.stringify({
          kind: "text",
          title: "作品声明摘要",
          text: "与主方案保持一致：单机柜额定功率 8.5kW，BOM成本 685元，节电率 23.4%。",
          sources: [],
        });
      }
      if (prompt.includes("任务：作品验收")) {
        if (prompt.includes("任务：主方案报告")) {
          return reviewJSON(prompt, {
            issues: [],
            suggestions: ["去掉开头套话"],
            scorecard:
              mainWrites === 1
                ? { novelty: 15, depth: 14, evidence: 15, craft: 13, presentation: 15, weakest: [{ dimension: "craft", score: 13, upgrade: "删除开头套话并补充量化机制" }], summary: "底线合格但有 AI 腔" }
                : { novelty: 18, depth: 18, evidence: 18, craft: 17, presentation: 17, weakest: [], summary: "达到冲奖水准" },
          });
        }
        return reviewJSON(prompt, {
          issues: [],
          scorecard: { novelty: 17, depth: 17, evidence: 17, craft: 17, presentation: 17, weakest: [], summary: "一致完整" },
        });
      }
      throw Error("unexpected prompt: " + prompt.slice(0, 80));
    },
  };

  const out = await runOrchestration(cfg, store, gateway, {
    jobId,
    competitionId: compId,
    idea: { title: "边缘算力调度", audience: "高校机房", problem: "能耗高", mechanism: "峰谷调度", verification: "仿真", evidence_urls: [] },
  });
  assert.equal(mainWrites, 2, "72分低于84目标分，应触发1轮冲奖定向精修");
  assert.match(polishPromptSeen, /冲奖定向精修/);
  assert.match(polishPromptSeen, /去 AI 味精修/);
  assert.equal(out.deliverables[0].review.scorecard.total, 88);
  assert.match(secondaryPromptSeen, /跨交付物单一事实源/);
  assert.match(secondaryPromptSeen, /685元/, "下游副产物自动收到主文档的关键参数");
});

test("跨赛事防撞题记录、社交搜索默认关闭、可胜率前置拦截、扩展资料与同源模型提醒", async (t) => {
  // 1. 社交平台查询默认关闭（A5）
  assert.doesNotMatch(promptOf({ prompts: {}, search: { socialPlatforms: false } }, "research"), /xiaohongshu/);
  assert.match(promptOf({ prompts: {}, search: { socialPlatforms: true } }, "research"), /xiaohongshu/);

  // 2. 同源轻量模型提醒
  const warns = modelWarnings({
    providers: [{ id: "relay", label: "中转", protocol: "openai", baseURL: "https://example.com/v1" }],
    agents: {
      writer: { provider: "relay", model: "gemini-3.8-flash" },
      reviewer: { provider: "relay", model: "gemini-3.8-flash" },
      research: { enabled: false },
    },
  });
  assert.ok(warns.some((w) => w.includes("同源盲区")));
  assert.ok(warns.some((w) => w.includes("轻量型号")));
  assert.ok(warns.some((w) => w.includes("研究 Agent")));

  // 3. 扩展用户资料（A4）
  const profile = {
    name: "程磊",
    school: "东北师范大学",
    major: "智能科学与技术",
    grade: "2025级",
    className: "智科1班",
    idNumber: "220102200501011234",
    qq: "12345678",
    advisor: "张教授",
    advisorPhone: "13900001111",
    members: [{ name: "王五", studentId: "2025013181", major: "软件工程" }],
  };
  assert.match(profileNote(profile), /身份证号：220102200501011234/);
  assert.match(profileNote(profile), /指导教师电话：13900001111/);
  assert.match(profileNote(profile), /队员1：姓名=王五/);
  assert.equal(applyProfile("证件：【待补充：身份证号】，导师手机：【待补充：指导教师电话】", profile), "证件：220102200501011234，导师手机：13900001111");
  assert.equal(coveredByProfile("补充作者身份证号与年级", profile), true);
  assert.ok(profileEntries(profile).some((x) => x.label === "QQ" && x.value === "12345678"));

  // 4. 赛道可胜率与硬阻塞前置拦截（拦截封闭外部平台如都奔 AI）
  const blocked = assessWinnability(
    "2026年全国大学生AIGC·新媒体创作大赛",
    "所有图片须严格使用官方指定AI平台【都奔】生成并提交都奔平台作品ID。",
    profile,
  );
  assert.equal(blocked.tier, "blocked");
  assert.ok(blocked.hardBlockers.length >= 1);

  const high = assessWinnability(
    "2026年全国大学生计算机设计大赛（人工智能应用赛道）",
    "参赛作品需提交离线可运行软件原型、技术方案书与答辩PPT。",
    profile,
  );
  assert.equal(high.tier, "high");
  assert.ok(high.score >= 80);

  // 5. 跨赛事防撞题 SQLite 记忆 + screening 拦截封闭平台
  const dir = await mkdtemp(join(tmpdir(), "winnability-"));
  const store = new Store(dir);
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<title>AIGC大赛</title><p>报名截止2099年12月31日。须使用指定AI平台生成并提交平台作品ID。</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const c1 = store.addCompetition("https://example.org/c1", "比赛一");
  const c2 = store.addCompetition(`http://127.0.0.1:${server.address().port}/closed`, "封闭平台AIGC赛");
  store.recordConcept("job-1", c1, { title: "独居老人防跌装置", audience: "独居老人", problem: "夜间起夜防跌倒" });
  const hist = store.recentConcepts(c2);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].title, "独居老人防跌装置");
  assert.equal(store.recentConcepts(c1).length, 0);

  store.enqueue(c2);
  const screened = await screenQueue(
    { reviewer: { providerID: "deepseek", id: "test" }, profile },
    store,
    {
      search: async () => [],
      generate: async () =>
        JSON.stringify({
          decision: "valid",
          reason: "时间有效",
          deadline: "2099-12-31",
          source_url: `http://127.0.0.1:${server.address().port}/closed`,
          quote: "报名截止2099年12月31日",
        }),
    },
    { limit: 1 },
  );
  assert.equal(screened[0].decision, "needs_review", "封闭平台硬阻塞应在队列审核阶段提前拦截");
  assert.match(screened[0].reason, /前置可行性拦截/);
});

test("固定样本评测脚本 --dry-run 可离线校验全部 5 份标杆样本", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/bench.mjs", "--dry-run"], {
    cwd: process.cwd(),
    timeout: 30_000,
    windowsHide: true,
  });
  assert.match(stdout, /essay/);
  assert.match(stdout, /tech-proposal/);
  assert.match(stdout, /pitch-deck/);
  assert.match(stdout, /poster/);
  assert.match(stdout, /registration-form/);
});
