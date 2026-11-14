/**
 * 真实模型端到端（第二类：长文写作 + 版面渲染）。
 * 用真实模型、真实渲染、真实评审；赛事记录用一个明确的征稿要求构造。
 */
import { loadConfig } from "./dist/core/config.js";
import { Store } from "./dist/core/store.js";
import { OfficialGateway } from "./dist/core/gateway.js";
import { runOrchestration } from "./dist/workflows/orchestrator.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const brief = {
  title: "测试用征稿：生态主题散文创作",
  edition: "2026",
  eligibility: "在校本科生",
  deadline: "2026-12-31",
  ai_rules: null,
  scoring: "思想性、艺术性、语言表达",
  deliverables: [
    {
      type: "散文作品",
      quantity: null,
      formats: ["docx"],
      limits: ["正文不少于3000字", "稿末注明作者姓名、学校、联系电话"],
      naming: null,
      attachments: [],
      submission: "电子版发送至邮箱",
      official_template: null,
    },
  ],
  requires_idea: false,
  missing: [],
  citations: [],
  research: { past_winners: [], past_works: [], judging: [], missing: [] },
};
const id = store.addCompetition("https://example.edu.cn/essay", brief.title);
store.setBrief(id, brief);
// 让格式核实走"公告已明确 docx"的路径：写一条可逐字核对的引用
store.putEvidence({
  id: crypto.randomUUID(),
  competitionId: id,
  url: "https://example.edu.cn/essay",
  title: "征稿要求",
  text: "应征作品请以 Word 文档（docx）提交，正文不少于3000字，稿末注明作者姓名、学校、联系电话。",
  fetchedAt: new Date().toISOString(),
  kind: "official",
});
const job = store.createJob(id, "automatic", {}, cfg.maxCalls);
const gateway = new OfficialGateway(cfg, job);
const t0 = Date.now();
try {
  const r = await runOrchestration(cfg, store, gateway, {
    jobId: job,
    competitionId: id,
    idea: null,
  });
  console.log("\n=== SUCCESS", Math.round((Date.now() - t0) / 1000), "s");
  for (const d of r.deliverables) {
    console.log(d.status, "|", d.title || d.type, "|", d.artifactPaths.join(", "));
    if (d.checks) console.log("   checks:", d.checks.map((c) => `${c.id}=${c.status}`).join(" "));
  }
  console.log("outputs:", r.outputs.slice(0, 4));
  store.finishJob(job, "completed", null, { outputs: r.outputs, gaps: r.gaps });
} catch (e) {
  console.log("\n=== FAILED", Math.round((Date.now() - t0) / 1000), "s");
  console.log(e.message.slice(0, 3000));
  store.finishJob(job, "failed", e.message.slice(0, 2000), null);
} finally {
  store.close();
}
