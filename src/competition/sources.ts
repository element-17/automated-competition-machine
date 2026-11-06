import { isJobControlError } from '../core/job-control.js';
import { load } from 'cheerio';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Evidence, ModelGateway, SearchOptions } from '../core/types.js';
import type { Store } from '../core/store.js';
async function pdfText(bytes:Buffer):Promise<string>{const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const task=pdfjs.getDocument({data:Uint8Array.from(bytes),useSystemFonts:true});const doc=await task.promise;try{const pages=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const content=await page.getTextContent();pages.push(content.items.map(x=>'str'in x?x.str:'').join(' '));}return pages.join('\n');}finally{await doc.destroy();}}

export function normalizeUrl(input:string):string { const u=new URL(input); if(!['http:','https:'].includes(u.protocol)) throw Error('仅支持 HTTP(S) 来源'); u.hash=''; return u.toString(); }
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function fetchWithRetry(url:string,init:RequestInit):Promise<Response>{let last:unknown;for(let attempt=0;attempt<3;attempt++){try{const response=await fetch(url,init);if(response.status>=500&&attempt<2){await wait(800*2**attempt);continue;}return response;}catch(e){last=e;if(attempt===2)throw e;await wait(800*2**attempt);}}throw last;}
export async function fetchDocument(input:string):Promise<{url:string,title:string,text:string,links:{url:string,title:string}[]}> {
  const url=normalizeUrl(input); const res=await fetchWithRetry(url,{signal:AbortSignal.timeout(30_000),headers:{'user-agent':'CompetitionResearchBot/1.0 (public research; contact site administrator for access issues)'}});
  if(!res.ok) throw Error(`来源不可访问 (${res.status}): ${url}`);
  const bytes=Buffer.from(await res.arrayBuffer()); if(bytes.length>15_000_000) throw Error('来源超过 15 MB，需手动下载并处理');
  const contentType=res.headers.get('content-type')||''; const finalUrl=normalizeUrl(res.url);
  if(contentType.includes('pdf') || finalUrl.toLowerCase().split('?')[0]?.endsWith('.pdf')) { const text=await pdfText(bytes); if(!text.trim()) throw Error('PDF 无可提取文本；扫描件需 OCR'); return {url:finalUrl,title:finalUrl,text:text.slice(0,120_000),links:[]}; }
  if(contentType.includes('wordprocessingml')||finalUrl.toLowerCase().split('?')[0]?.endsWith('.docx')) {const mammoth=await import('mammoth');const text=(await mammoth.extractRawText({buffer:bytes})).value;if(!text.trim())throw Error('DOCX 不含可提取文字');return {url:finalUrl,title:finalUrl,text:text.slice(0,120_000),links:[]};}
  if(contentType.includes('presentationml')||finalUrl.toLowerCase().split('?')[0]?.endsWith('.pptx')) {const JSZip=(await import('jszip')).default;const archive=await JSZip.loadAsync(bytes);const paths=Object.keys(archive.files).filter(x=>/^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));const text=(await Promise.all(paths.map(async p=>{const xml=await archive.files[p]!.async('string');const $=load(xml,{xmlMode:true});return $('a\\:t').toArray().map(x=>$(x).text()).join(' ');}))).join('\n');if(!text.trim())throw Error('PPTX 不含可提取文字');return {url:finalUrl,title:finalUrl,text:text.slice(0,120_000),links:[]};}
  if(!contentType.includes('html') && !contentType.includes('text') && !contentType.includes('xml')) throw Error(`暂不支持此来源类型：${contentType || 'unknown'}`);
  const declared=contentType.match(/charset\s*=\s*['"]?([^;'"\s]+)/i)?.[1] || bytes.subarray(0,4096).toString('ascii').match(/charset\s*=\s*['"]?([^;'"\s/>]+)/i)?.[1] || 'utf-8'; let html:string; try{html=new TextDecoder(declared).decode(bytes);}catch{html=bytes.toString('utf8');} const $=load(html); $('script,style,noscript,nav,footer').remove();
  const title=$('title').first().text().trim()||$('h1').first().text().trim()||finalUrl;
  const links:{url:string,title:string}[]=[]; $('a[href]').each((_,a)=>{ try {const href=$(a).attr('href'); if(!href)return; const link=normalizeUrl(new URL(href,finalUrl).toString()); const text=$(a).text().replace(/\s+/g,' ').trim(); if(text && !links.some(x=>x.url===link)) links.push({url:link,title:text});}catch{} });
  const text=$('body').text().replace(/\s+/g,' ').trim(); if(!text) throw Error('网页没有可提取的正文，可能需要浏览器或登录');
  return {url:finalUrl,title,text:text.slice(0,120_000),links};
}
export async function readSource(path:string):Promise<string> { const ext=extname(path).toLowerCase(); const data=await readFile(path); if(data.length>15_000_000) throw Error('输入文件超过 15 MB'); if(['.txt','.md'].includes(ext)) return data.toString('utf8'); if(ext==='.pdf') return pdfText(data); if(ext==='.docx') { const mammoth=await import('mammoth'); return (await mammoth.extractRawText({buffer:data})).value; } throw Error(`暂不支持原文格式 ${ext}；可使用 txt、md、docx、pdf`); }
export async function saveSource(store:Store,id:string,url:string,kind:string,titleHint?:string):Promise<Evidence> { try {const doc=await fetchDocument(url); const e={id:randomUUID(),competitionId:id,url:doc.url,title:doc.title===doc.url&&titleHint?titleHint:doc.title,text:doc.text,fetchedAt:new Date().toISOString(),kind}; store.putEvidence(e);store.sourceAttempt(id,url,kind); return e;}catch(e){store.sourceAttempt(id,url,kind,e instanceof Error?e.message:String(e));throw e;} }
/** 下载失败只记录来源尝试，不阻断同一赛事的其他来源和后续制作。 */
export async function saveSourceBestEffort(store:Store,id:string,url:string,kind:string,titleHint?:string):Promise<Evidence|null>{for(let attempt=0;attempt<2;attempt++){try{return await saveSource(store,id,url,kind,titleHint);}catch(e){if(attempt===1)console.error(`来源跳过（${url}）：${e instanceof Error?e.message:String(e)}`);else await wait(800*2**attempt);}}return null;}
export async function searchLogged(store:Store,gateway:ModelGateway,id:string|null,query:string,options?:SearchOptions) { if(gateway.canSearch===false){store.search(id,query,[],'来源列表模式未配置全网关键词搜索');return [];}try {const results=await (options?gateway.search(query,options):gateway.search(query)); store.search(id,query,results); return results;}catch(e){if(isJobControlError(e))throw e;const error=e instanceof Error?e.message:String(e);store.search(id,query,[],error);console.error(`搜索失败（${query}）：${error}`);return []; } }
