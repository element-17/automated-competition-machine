import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelGateway } from './types.js';

export const VisualBrief=z.object({image_prompt:z.string().min(1),caption:z.string().default(''),caption_x:z.number().min(0).max(1).default(0.08),caption_y:z.number().min(0).max(1).default(0.85),caption_size:z.number().min(0.015).max(0.15).default(0.045),caption_color:z.string().regex(/^[0-9A-Fa-f]{6}$/).default('FFFFFF')});
export type VisualBrief=z.infer<typeof VisualBrief>;
const escape=(x:string)=>x.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export async function makeVisual(gateway:ModelGateway,brief:VisualBrief,format:'png'|'jpg',folder:string){if(!gateway.generateImage)throw Error('没有配置图片生成模型');const result=await gateway.generateImage(`${brief.image_prompt}\nRender no text, lettering, numbers, watermark, or logos; text will be added separately.`);const image=sharp(result.data);const info=await image.metadata();if(!info.width||!info.height||info.width<512||info.height<512)throw Error('生成的图片尺寸过小或格式无效');let pipeline=image;if(brief.caption){const svg=`<svg width="${info.width}" height="${info.height}" xmlns="http://www.w3.org/2000/svg"><text x="${Math.round(info.width*brief.caption_x)}" y="${Math.round(info.height*brief.caption_y)}" fill="#${brief.caption_color}" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="${Math.round(info.width*brief.caption_size)}">${escape(brief.caption)}</text></svg>`;pipeline=pipeline.composite([{input:Buffer.from(svg)}]);}await mkdir(folder,{recursive:true});const out=join(folder,`submission.${format}`);await writeFile(out,await (format==='png'?pipeline.png():pipeline.jpeg({quality:92})).toBuffer());return out;}
