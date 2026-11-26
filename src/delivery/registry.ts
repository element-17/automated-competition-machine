import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserDeliveryChannel } from "./browser-channel.js";
import { EmailDeliveryChannel } from "./email-channel.js";
import type {
  DeliveryChannel,
  DeliveryChannelId,
  DeliveryContext,
  DeliveryPlan,
  DeliveryReceipt,
  DeliveryRequest,
} from "./types.js";

/** 可插拔交付通道注册表：与核心业务解耦，支持按需注册新通道。 */
export class DeliveryRegistry {
  private readonly channels = new Map<DeliveryChannelId, DeliveryChannel>();

  register(channel: DeliveryChannel): this {
    this.channels.set(channel.id, channel);
    return this;
  }

  get(id: DeliveryChannelId): DeliveryChannel {
    const ch = this.channels.get(id);
    if (!ch) {
      throw Error(
        `不支持的交付通道「${id}」；已注册：${[...this.channels.keys()].join("、")}`,
      );
    }
    return ch;
  }

  list(): DeliveryChannel[] {
    return [...this.channels.values()];
  }

  async prepare(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<DeliveryPlan> {
    return this.get(request.target.channel).prepare(request, context);
  }

  async execute(
    request: DeliveryRequest,
    context: DeliveryContext,
  ): Promise<DeliveryReceipt> {
    const channel = this.get(request.target.channel);
    const receipt = await channel.deliver(request, context);
    const dir = join(context.dataDir, "jobs", request.jobId, "deliveries");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${receipt.id}.json`),
      JSON.stringify(receipt, null, 2) + "\n",
      "utf8",
    );
    return receipt;
  }
}

export function createDefaultDeliveryRegistry(): DeliveryRegistry {
  return new DeliveryRegistry()
    .register(new EmailDeliveryChannel())
    .register(new BrowserDeliveryChannel());
}
