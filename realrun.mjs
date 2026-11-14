/** 真实模型端到端：用配置里的模型跑完整编排，不注入任何桩。 */
import { loadConfig } from "./dist/core/config.js";
import { Store } from "./dist/core/store.js";
import { OfficialGateway } from "./dist/core/gateway.js";
import { runOrchestration } from "./dist/workflows/orchestrator.js";

const competitionId = process.argv[2];
const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const job = store.createJob(competitionId, "automatic", {}, cfg.maxCalls);
const gateway = new OfficialGateway(cfg, job);
const started = Date.now();
try {
  const r = await runOrchestration(cfg, store, gateway, {
    jobId: job,
    competitionId,
    idea: null,
  });
  console.log("\n=== SUCCESS in", Math.round((Date.now() - started) / 1000), "s");
  for (const d of r.deliverables)
    console.log(d.status, "|", d.title || d.type, "|", d.artifactPaths.join(", "));
  console.log("final outputs:");
  for (const o of r.outputs.slice(0, 6)) console.log("  ", o);
  if (r.gaps.length) console.log("gaps:", r.gaps.slice(0, 8));
  store.finishJob(job, "completed", null, { outputs: r.outputs, gaps: r.gaps });
} catch (e) {
  console.log("\n=== FAILED after", Math.round((Date.now() - started) / 1000), "s");
  console.log(e.message);
  store.finishJob(job, "failed", e.message.slice(0, 2000), null);
} finally {
  store.close();
}
