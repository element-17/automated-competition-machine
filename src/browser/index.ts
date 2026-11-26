import type { ModelGateway } from "../core/types.js";
import type { AgentName } from "../agents/prompts.js";
import type { BrowserModelAdapter } from "./types.js";

export * from "./types.js";
export * from "./session-store.js";
export * from "./playwright-driver.js";
export * from "./agent.js";

/**
 * 轻量适配器：将项目内现有的 ModelGateway 桥接为解耦的 BrowserModelAdapter。
 * 有视觉能力时优先携带截图决策，否则退回纯文本 @eN DOM 引用决策，兼容轻量与旗舰模型。
 */
export function createGatewayBrowserAdapter(
  gateway: ModelGateway,
  options: { agent?: AgentName; preferVision?: boolean } = {},
): BrowserModelAdapter {
  const agent = options.agent ?? "reviewer";
  const supportsVision = Boolean(
    (options.preferVision ?? true) && gateway.inspectImage,
  );
  return {
    supportsVision,
    async decide(prompt, screenshot) {
      if (screenshot && supportsVision && gateway.inspectImage) {
        return gateway.inspectImage(prompt, screenshot, agent);
      }
      return gateway.generate("reviewer", prompt, agent);
    },
  };
}
