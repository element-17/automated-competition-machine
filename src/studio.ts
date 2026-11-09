import { loadConfig, type AppConfig } from "./core/config.js";
import { Store } from "./core/store.js";
import { OfficialGateway } from "./core/gateway.js";
import type { ModelGateway } from "./core/types.js";
import { researchGraph } from "./workflows/workflow.js";
import { autonomousGraph } from "./workflows/autonomous.js";

/**
 * LangGraph Studio（`npm run studio`）的图入口。各图需要按状态里的 competitionId 读取
 * 数据库中已发现的赛事，所以默认沿用 CLI 的数据目录，调试时才能真正跑起来。
 * 检查点由 Studio 自己的存储接管，不写 data/checkpoints.sqlite。需要隔离数据时设置
 * COMPETE_DATA_DIR 指向另一个目录，并在那里先建好赛事记录。
 */
function context(): { cfg: AppConfig; store: Store; gateway: ModelGateway } {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir);
  return { cfg, store, gateway: new OfficialGateway(cfg, store) };
}

export async function autonomous() {
  const { cfg, store, gateway } = context();
  return autonomousGraph(cfg, store, gateway).graph;
}
export async function research() {
  const { cfg, store, gateway } = context();
  return researchGraph(cfg, store, gateway).graph;
}
