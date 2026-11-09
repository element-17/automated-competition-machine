import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ModelGateway } from "../core/types.js";

/** caption_mode=band（默认）：文字放在画面下方的独立色带里，不会遮挡画面内容；overlay：按坐标叠加在画面上。 */
export const VisualBrief = z.object({
  image_prompt: z.string().min(1),
  caption: z.string().default(""),
  caption_mode: z.enum(["band", "overlay"]).default("band"),
  caption_x: z.number().min(0).max(1).default(0.08),
  caption_y: z.number().min(0).max(1).default(0.85),
  caption_size: z.number().min(0.015).max(0.15).default(0.045),
  caption_color: z
    .string()
    .regex(/^[0-9A-Fa-f]{6}$/)
    .default("FFFFFF"),
  band_color: z
    .string()
    .regex(/^[0-9A-Fa-f]{6}$/)
    .default("202832"),
});
export type VisualBrief = z.infer<typeof VisualBrief>;
const escape = (x: string) =>
  x
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
/** 中文按 1 个字宽、其他字符按半个字宽估算，保证文字不超出画面宽度。 */
const textWidth = (x: string) =>
  [...x].reduce((n, c) => n + (/[⺀-鿿＀-￯]/.test(c) ? 1 : 0.55), 0);
const font = "Noto Sans CJK SC, Microsoft YaHei, sans-serif";

export async function makeVisual(
  gateway: ModelGateway,
  brief: VisualBrief,
  format: "png" | "jpg",
  folder: string,
) {
  if (!gateway.generateImage) throw Error("没有配置图片生成模型");
  const result = await gateway.generateImage(
    `${brief.image_prompt}\nRender no text, lettering, numbers, watermark, or logos; text will be added separately.`,
  );
  const image = sharp(result.data);
  const info = await image.metadata();
  if (!info.width || !info.height || info.width < 512 || info.height < 512)
    throw Error("生成的图片尺寸过小或格式无效");
  const { width, height } = info;
  let pipeline = image;
  if (brief.caption.trim()) {
    const size = Math.round(
      Math.min(
        width * brief.caption_size,
        (width * 0.9) / Math.max(1, textWidth(brief.caption)),
      ),
    );
    if (brief.caption_mode === "overlay") {
      const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="${Math.round(width * brief.caption_x)}" y="${Math.round(height * brief.caption_y)}" fill="#${brief.caption_color}" font-family="${font}" font-size="${size}">${escape(brief.caption)}</text></svg>`;
      pipeline = pipeline.composite([{ input: Buffer.from(svg) }]);
    } else {
      const band = Math.round(size * 2.2);
      const svg = `<svg width="${width}" height="${band}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${band}" fill="#${brief.band_color}"/><text x="${Math.round(width / 2)}" y="${Math.round(band / 2)}" fill="#${brief.caption_color}" font-family="${font}" font-size="${size}" text-anchor="middle" dominant-baseline="central">${escape(brief.caption)}</text></svg>`;
      const base = await image.toBuffer();
      pipeline = sharp({
        create: {
          width,
          height: height + band,
          channels: 3,
          background: `#${brief.band_color}`,
        },
      }).composite([
        { input: base, top: 0, left: 0 },
        { input: Buffer.from(svg), top: height, left: 0 },
      ]);
    }
  }
  await mkdir(folder, { recursive: true });
  const out = join(folder, `submission.${format}`);
  await writeFile(
    out,
    await (
      format === "png" ? pipeline.png() : pipeline.jpeg({ quality: 92 })
    ).toBuffer(),
  );
  return out;
}
