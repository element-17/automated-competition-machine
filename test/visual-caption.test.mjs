import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { makeVisual, VisualBrief } from "../dist/artifacts/visual.js";

const background = "#203040";
const font = "Noto Sans CJK SC, Microsoft YaHei, sans-serif";
const baseImage = () => sharp({ create: { width: 800, height: 600, channels: 3, background } }).png().toBuffer();
const brief = (changes = {}) => VisualBrief.parse({ image_prompt: "纯色", caption: "图题", caption_mode: "overlay", caption_x: 0.1, caption_y: 0.5, ...changes });

test("overlay 按真实像素边界拒绝横向裁字、右边界和顶部裁字", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caption-bounds-"));
  try {
    const base = await baseImage();
    const gateway = { generateImage: async () => ({ data: base, mime: "image/png" }) };
    for (const changes of [
      { caption: "一二三四五六七八九十一二三四五六七八九十", caption_x: 0.8, caption_size: 0.045 },
      { caption: "Visible", caption_x: 1 },
      { caption: "Visible", caption_y: 0 },
    ]) {
      await assert.rejects(makeVisual(gateway, brief(changes), "png", dir), /图题实际渲染边界超出画面.*调整/);
      await assert.rejects(access(join(dir, "submission.png")));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("合法 overlay 保持完整字形与指定坐标，像素等于直接 SVG 合成", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caption-pixels-"));
  try {
    const base = await baseImage();
    const gateway = { generateImage: async () => ({ data: base, mime: "image/png" }) };
    const input = brief({ caption: "Caption", caption_x: 0.2, caption_y: 0.5, caption_size: 0.045 });
    const output = await makeVisual(gateway, input, "png", dir);
    const svg = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg"><text x="160" y="300" fill="#FFFFFF" font-family="${font}" font-size="36">Caption</text></svg>`;
    const expected = await sharp(base).composite([{ input: Buffer.from(svg) }]).ensureAlpha().raw().toBuffer();
    const actual = await sharp(await readFile(output)).ensureAlpha().raw().toBuffer();
    assert.deepEqual(actual, expected);
    assert.notDeepEqual(actual, await sharp(base).ensureAlpha().raw().toBuffer(), "图题确实产生可见像素");
    assert.deepEqual([...actual.subarray(0, 4)], [32, 48, 64, 255], "远离图题的底图保持原样");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
