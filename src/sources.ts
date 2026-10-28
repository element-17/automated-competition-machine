import { load } from 'cheerio';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Evidence, ModelGateway } from './types.js';
import type { Store } from './store.js';
const require=createRequire(import.meta.url);
const pdfParse=require('pdf-parse') as (b:Buffer)=>Promise<{text:string}>;

export function normalizeUrl(input:string):string { const u=new URL(input); if(!['http:','https:'].includes(u.protocol)) throw Error('仅支持 HTTP(S) 来源'); u.hash=''; return u.toString(); }
export async function fetchDocument(input:string):Promise<{url:string,title:string,text:string,links:{url:string,title:string}[]}> {
  const url=normalizeUrl(input); const res=await fetch(url,{signal:AbortSignal.timeout(30_000),headers:{'user-agent':'CompetitionResearchBot/1.0 (public research; contact site administrator for access issues)'}});
  if(!res.ok) throw Error(`来源不可访问 (${res.status}): ${url}`);
  const bytes=Buffer.from(await res.arrayBuffer()); if(bytes.length>15_000_000) throw Error('来源超过 15 MB，需手动下载并处理');
  const contentType=res.headers.get('content-type')||''; const finalUrl=normalizeUrl(res.url);
  if(contentType.includes('pdf') || finalUrl.toLowerCase().split('?')[0]?.endsWith('.pdf')) { const pdf=await pdfParse(bytes); if(!pdf.text.trim()) throw Error('PDF 无可提取文本；扫描件需 OCR'); return {url:finalUrl,title:finalUrl,text:pdf.text.slice(0,120_000),links:[]}; }
  if(!contentType.includes('html') && !contentType.includes('text') && !contentType.includes('xml')) throw Error(`暂不支持此来源类型：${contentType || 'unknown'}`);
  const declared=contentType.match(/charset\s*=\s*['"]?([^;'"\s]+)/i)?.[1] || bytes.subarray(0,4096).toString('ascii').match(/charset\s*=\s*['"]?([^;'"\s/>]+)/i)?.[1] || 'utf-8'; let html:string; try{html=new TextDecoder(declared).decode(bytes);}catch{html=bytes.toString('utf8');} const $=load(html); $('script,style,noscript,nav,footer').remove();
  const title=$('title').first().text().trim()||$('h1').first().text().trim()||finalUrl;
  const links:{url:string,title:string}[]=[]; $('a[href]').each((_,a)=>{ try {const href=$(a).attr('href'); if(!href)return; const link=normalizeUrl(new URL(href,finalUrl).toString()); const text=$(a).text().replace(/\s+/g,' ').trim(); if(text && !links.some(x=>x.url===link)) links.push({url:link,title:text});}catch{} });
  const text=$('body').text().replace(/\s+/g,' ').trim(); if(!text) throw Error('网页没有可提取的正文，可能需要浏览器或登录');
  return {url:finalUrl,title,text:text.slice(0,120_000),links};
}
export async function readSource(path:string):Promise<string> { const ext=extname(path).toLowerCase(); const data=await readFile(path); if(data.length>15_000_000) throw Error('输入文件超过 15 MB'); if(['.txt','.md'].includes(ext)) return data.toString('utf8'); if(ext==='.pdf') return (await pdfParse(data)).text; if(ext==='.docx') { const mammoth=await import('mammoth'); return (await mammoth.extractRawText({buffer:data})).value; } throw Error(`暂不支持原文格式 ${ext}；可使用 txt、md、docx、pdf`); }
export async function saveSource(store:Store,id:string,url:string,kind:string):Promise<Evidence> { const doc=await fetchDocument(url); const e={id:randomUUID(),competitionId:id,url:doc.url,title:doc.title,text:doc.text,fetchedAt:new Date().toISOString(),kind}; store.putEvidence(e); return e; }
export async function searchLogged(store:Store,gateway:ModelGateway,id:string|null,query:string) { try {const results=await gateway.search(query); store.search(id,query,results); return results;}catch(e){ store.search(id,query,[],e instanceof Error?e.message:String(e)); return []; } }
