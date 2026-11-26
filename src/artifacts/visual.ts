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

export type ImageSpec = {
  orientation?: "portrait" | "landscape" | "square";
  width?: number;
  height?: number;
  dpi?: number;
  maxBytes?: number;
};

/** 从赛事交付要求与任务说明中解析通用印刷/画幅规格（A3/A4、纵横构图、DPI、体积上限）。 */
export function parseImageSpec(texts: string[]): ImageSpec {
  const joined = texts.filter(Boolean).join(" ");
  const spec: ImageSpec = {};
  if (/纵向|竖版|竖向|竖幅|portrait/i.test(joined)) spec.orientation = "portrait";
  else if (/横向|横版|横幅|landscape/i.test(joined)) spec.orientation = "landscape";
  else if (/正方形|方图|1\s*[:：]\s*1/.test(joined)) spec.orientation = "square";

  const dpiMatch = /(\d{2,3})\s*dpi/i.exec(joined);
  if (dpiMatch) {
    const d = Number(dpiMatch[1]);
    if (d >= 72 && d <= 600) spec.dpi = d;
  }

  const pxMatch = /(\d{3,4})\s*[×xX*]\s*(\d{3,4})\s*(?:px|像素)/i.exec(joined);
  if (pxMatch) {
    const a = Number(pxMatch[1]), b = Number(pxMatch[2]);
    if (a >= 512 && b >= 512 && a <= 8000 && b <= 8000) {
      spec.width = a;
      spec.height = b;
      if (!spec.orientation) spec.orientation = b > a ? "portrait" : a > b ? "landscape" : "square";
    }
  } else if (/\bA3\b|297\s*[×x*]\s*420|420\s*[×x*]\s*297/i.test(joined)) {
    const dpi = spec.dpi || 300;
    spec.dpi = dpi;
    const shortSide = Math.round((297 / 25.4) * dpi);
    const longSide = Math.round((420 / 25.4) * dpi);
    const portrait = spec.orientation !== "landscape";
    spec.orientation ||= "portrait";
    spec.width = portrait ? shortSide : longSide;
    spec.height = portrait ? longSide : shortSide;
  } else if (/\bA4\b|210\s*[×x*]\s*297|297\s*[×x*]\s*210/i.test(joined)) {
    const dpi = spec.dpi || 300;
    spec.dpi = dpi;
    const shortSide = Math.round((210 / 25.4) * dpi);
    const longSide = Math.round((297 / 25.4) * dpi);
    const portrait = spec.orientation !== "landscape";
    spec.orientation ||= "portrait";
    spec.width = portrait ? shortSide : longSide;
    spec.height = portrait ? longSide : shortSide;
  }

  const sizeMatch = /(?:不超过|不大于|小于|以内|≤|<=)\s*(\d+(?:\.\d+)?)\s*(?:MB|M\b)/i.exec(joined);
  if (sizeMatch) {
    const mb = Number(sizeMatch[1]);
    if (mb > 0 && mb <= 100) spec.maxBytes = Math.floor(mb * 1024 * 1024 * 0.95);
  }
  return spec;
}

export async function makeVisual(
  gateway: ModelGateway,
  brief: VisualBrief,
  format: "png" | "jpg",
  folder: string,
  spec?: ImageSpec,
) {
  if (!gateway.generateImage) throw Error("没有配置图片生成模型");
  const result = await gateway.generateImage(
    `${brief.image_prompt}\nRender no text, lettering, numbers, watermark, or logos; text will be added separately.`,
    spec?.orientation ? { orientation: spec.orientation } : undefined,
  );
  const rawImage = sharp(result.data);
  const rawInfo = await rawImage.metadata();
  if (!rawInfo.width || !rawInfo.height || rawInfo.width < 512 || rawInfo.height < 512)
    throw Error("生成的图片尺寸过小或格式无效");

  // 若赛事明确规定了印刷画幅/像素（如 A3 纵向 300DPI = 3508×4961），按等比裁剪与高质量重采样对齐目标画幅。
  const hasTargetSize = !!(spec?.width && spec?.height);
  const targetW = hasTargetSize ? spec!.width! : rawInfo.width;
  const targetH = hasTargetSize ? spec!.height! : rawInfo.height;
  const captionTrimmed = brief.caption.trim();
  const estCaptionSize = captionTrimmed
    ? Math.round(
        Math.min(
          targetW * brief.caption_size,
          (targetW * 0.9) / Math.max(1, textWidth(brief.caption)),
        ),
      )
    : 0;
  const reservedBand =
    hasTargetSize && captionTrimmed && brief.caption_mode === "band"
      ? Math.round(estCaptionSize * 2.2)
      : 0;
  const artW = targetW;
  const artH = Math.max(256, targetH - reservedBand);

  const image = hasTargetSize
    ? sharp(
        await sharp(result.data)
          .resize(artW, artH, {
            fit: "cover",
            position: "centre",
            kernel: sharp.kernel.lanczos3,
          })
          .png()
          .toBuffer(),
      )
    : rawImage;
  const width = artW;
  const height = artH;
  let pipeline = image;
  if (captionTrimmed) {
    const size = Math.round(
      Math.min(
        width * brief.caption_size,
        (width * 0.9) / Math.max(1, textWidth(brief.caption)),
      ),
    );
    if (brief.caption_mode === "overlay") {
      if (size < 1) throw Error("图题字号过小，无法完整渲染；请缩短图题或调整字号");
      // Render outside the destination canvas first: clipping there would hide missing glyphs.
      // This generous measurement surface is not the fit decision; only actual alpha pixels are.
      const padding = Math.max(32, size * 4);
      const measureWidth = Math.ceil(padding * 2 + Math.max(width, [...brief.caption].length * size * 4));
      const measureHeight = padding * 2;
      if (measureWidth * measureHeight > 32_000_000)
        throw Error("图题测量画布过大，无法完整核验；请缩短图题或调整字号");
      const svg = `<svg width="${measureWidth}" height="${measureHeight}" xmlns="http://www.w3.org/2000/svg"><text x="${padding}" y="${padding}" fill="#${brief.caption_color}" font-family="${font}" font-size="${size}">${escape(brief.caption)}</text></svg>`;
      const { data, info: rendered } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let left = rendered.width, top = rendered.height, right = -1, bottom = -1;
      for (let y = 0; y < rendered.height; y++)
        for (let x = 0; x < rendered.width; x++)
          if (data[(y * rendered.width + x) * rendered.channels + rendered.channels - 1]) {
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
      if (right < left || bottom < top)
        throw Error("图题没有渲染出可见像素，无法完整核验；请调整图题或字体配置");
      if (left === 0 || top === 0 || right === rendered.width - 1 || bottom === rendered.height - 1)
        throw Error("图题超出测量画布，无法完整核验；请缩短图题或调整字号");
      const targetLeft = Math.round(width * brief.caption_x) + left - padding;
      const targetTop = Math.round(height * brief.caption_y) + top - padding;
      const captionWidth = right - left + 1, captionHeight = bottom - top + 1;
      if (targetLeft < 0 || targetTop < 0 || targetLeft + captionWidth > width || targetTop + captionHeight > height)
        throw Error("图题实际渲染边界超出画面；请调整 caption_x、caption_y、caption_size 或缩短图题");
      const caption = await sharp(data, { raw: rendered })
        .extract({ left, top, width: captionWidth, height: captionHeight }).png().toBuffer();
      pipeline = pipeline.composite([{ input: caption, left: targetLeft, top: targetTop }]);
    } else {
      const band = reservedBand || Math.round(size * 2.2);
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
  if (spec?.dpi) pipeline = pipeline.withMetadata({ density: spec.dpi });
  await mkdir(folder, { recursive: true });
  const out = join(folder, `submission.${format}`);
  let buf: Buffer;
  if (format === "png") {
    buf = await pipeline.png().toBuffer();
  } else {
    let quality = 92;
    buf = await pipeline.clone().jpeg({ quality }).toBuffer();
    while (spec?.maxBytes && buf.length > spec.maxBytes && quality > 68) {
      quality -= 6;
      buf = await pipeline.clone().jpeg({ quality }).toBuffer();
    }
  }
  await writeFile(out, buf);
  return out;
}
