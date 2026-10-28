import { z } from 'zod';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs') as new () => any;
const PDFDocument = createRequire(import.meta.url)('pdfkit') as typeof import('pdfkit');

const color = z.string().regex(/^[0-9A-Fa-f]{6}$/);
export const Element = z.object({ type:z.enum(['text','rect','ellipse','line']).default('text'), text:z.string().max(2000).default(''), x:z.number().min(0), y:z.number().min(0), w:z.number().positive(), h:z.number().positive(), fontSize:z.number().min(8).max(72).default(24), color:color.default('202832'), fill:color.optional(), bold:z.boolean().default(false) }).superRefine((e,ctx)=>{if(e.type==='text'&&!e.text.trim())ctx.addIssue({code:'custom',message:'文本元素不能为空'});});
export const Slide = z.object({ background:color.default('FFFFFF'), elements:z.array(Element).min(1).max(30) });
export const Work = z.object({ kind:z.enum(['text','slides']), title:z.string().min(1), text:z.string().optional(), slides:z.array(Slide).max(40).optional(), sources:z.array(z.string()).default([]) }).superRefine((x,ctx)=>{if(x.kind==='text'&&!x.text?.trim())ctx.addIssue({code:'custom',message:'文字作品为空'});if(x.kind==='slides'&&!x.slides?.length)ctx.addIssue({code:'custom',message:'PPT 没有幻灯片'});});
export type Work=z.infer<typeof Work>;
export function validateWork(work:Work):string[] { const issues:string[]=[]; if(work.kind==='slides') for(const [i,slide] of (work.slides||[]).entries()){ for(const [j,e] of slide.elements.entries()){ if(e.x+e.w>13.3334||e.y+e.h>7.5)issues.push(`第 ${i+1} 页第 ${j+1} 个元素越界`); if(e.type==='text'){const approxChars=Math.max(1,Math.floor((e.w*72)/(e.fontSize*0.9)))*Math.max(1,Math.floor((e.h*72)/(e.fontSize*1.25))); if(e.text.length>approxChars*1.4)issues.push(`第 ${i+1} 页第 ${j+1} 个文本框可能溢出`);for(let k=0;k<j;k++){const other=slide.elements[k];if(other?.type!=='text')continue;const w=Math.max(0,Math.min(e.x+e.w,other.x+other.w)-Math.max(e.x,other.x));const h=Math.max(0,Math.min(e.y+e.h,other.y+other.h)-Math.max(e.y,other.y));if(w*h>Math.min(e.w*e.h,other.w*other.h)*0.05)issues.push(`第 ${i+1} 页第 ${k+1} 与 ${j+1} 个文本框重叠`);}} } } return issues; }
export async function renderWork(work:Work, format:string, folder:string):Promise<string> {
  await mkdir(folder,{recursive:true}); const ext=format.toLowerCase().replace(/^\./,'');
  const allowed=work.kind==='slides'?['pptx']:['txt','md','docx','pdf']; if(!allowed.includes(ext)) throw Error(`当前无法制作 ${work.kind}/${ext}，已保留研究和方案；需要相应制作适配器`);
  const issues=validateWork(work); if(issues.length)throw Error(`作品自动检查未通过：${issues.join('；')}`);
  const out=join(folder,`submission.${ext}`);
  if(ext==='pptx') { const ppt=new PptxGenJS(); ppt.layout='LAYOUT_WIDE'; ppt.author='Competition CLI'; ppt.subject='Competition entry';
    for(const slide of work.slides!){const page=ppt.addSlide();page.background={color:slide.background};for(const e of slide.elements){if(e.type==='text')page.addText(e.text,{x:e.x,y:e.y,w:e.w,h:e.h,fontFace:'Microsoft YaHei',fontSize:e.fontSize,color:e.color,bold:e.bold,margin:0,breakLine:false,fit:'shrink'});else page.addShape(ppt.ShapeType[e.type],{x:e.x,y:e.y,w:e.w,h:e.h,line:{color:e.color},...(e.fill?{fill:{color:e.fill}}:{})});}}
    await ppt.writeFile({fileName:out}); const archive=await JSZip.loadAsync(await readFile(out)); const count=Object.keys(archive.files).filter(x=>/^ppt\/slides\/slide\d+\.xml$/.test(x)).length; if(count!==work.slides!.length)throw Error('PPT 页数校验失败');
  } else if(ext==='pdf'){
    const font=[process.env.COMPETE_PDF_FONT,'C:\\Windows\\Fonts\\simhei.ttf','/usr/share/fonts/truetype/arphic/ukai.ttc','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(x=>x&&existsSync(x));
    if(!font)throw Error('没有可用的 PDF 字体，请通过 COMPETE_PDF_FONT 设置字体路径');
    if(/[^\x00-\x7F]/.test(work.text!)&&font.includes('DejaVuSans'))throw Error('PDF 需要中文字体，请通过 COMPETE_PDF_FONT 指定可嵌入的中文 TTF 字体');
    await new Promise<void>((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margins:{top:54,bottom:54,left:54,right:54}});const stream=createWriteStream(out);stream.on('finish',resolve);stream.on('error',reject);doc.on('error',reject);try{doc.pipe(stream);doc.font(font).fontSize(12).text(work.text!,{lineGap:4});doc.end();}catch(e){stream.destroy();reject(e);}});
  } else if(ext==='docx'){const doc=new Document({sections:[{children:work.text!.split(/\r?\n/).map(line=>new Paragraph(line))}]});await writeFile(out,await Packer.toBuffer(doc));}
  else await writeFile(out,work.text!,'utf8'); return out;
}
