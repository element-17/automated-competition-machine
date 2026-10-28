import { OpenCode } from '@opencode/client';
import type { AppConfig } from './config.js';
import type { ModelGateway, ModelRole } from './types.js';
import type { Store } from './store.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class OpenCodeGateway implements ModelGateway {
  private client: ReturnType<typeof OpenCode.make>;
  constructor(private cfg:AppConfig, private store?:Store, private jobId?:string) { this.client=OpenCode.make({baseUrl:cfg.opencodeUrl, headers: authHeaders()}); }
  async generate(role:ModelRole,prompt:string):Promise<string> {
    const model=role==='writer'?this.cfg.writer:this.cfg.reviewer;
    if(role==='writer' && model.providerID!=='google') throw Error('写作模型必须是 Gemini');
    if(this.jobId && this.store) this.store.consumeCall(this.jobId);
    try { const result=await this.client.generate.text({model,prompt},{signal:AbortSignal.timeout(180_000)}); if(!result.text?.trim()) throw Error('模型返回空内容'); return result.text; }
    catch(e) { throw Error(`${role==='writer'?'Gemini 写作':'第二模型'}调用失败：${e instanceof Error?e.message:String(e)}；不会切换其他模型`); }
  }
  async search(query:string) { const result=await this.client.websearch.query({query,providerID:this.cfg.searchProvider},{signal:AbortSignal.timeout(45_000)}); return result.data.results.map(r=>({url:r.url,title:r.title||r.url,snippet:r.content||''})); }
  async generateImage(prompt:string){if(this.jobId&&this.store)this.store.consumeCall(this.jobId);try{const result=await this.client.generate.image({model:this.cfg.image,prompt,n:1},{signal:AbortSignal.timeout(180_000)});const image=result.images[0];if(!image||!/^image\/(png|jpeg|webp)$/.test(image.mime))throw Error('图片模型未返回支持的图片');const data=Buffer.from(image.data,'base64');if(!data.length||data.length>20_000_000)throw Error('图片为空或超过 20 MB');return {data,mime:image.mime};}catch(e){throw Error(`图片模型调用失败：${e instanceof Error?e.message:String(e)}`);}}
  async buildProject(workspace:string,prompt:string):Promise<void>{
    if(this.jobId&&this.store)this.store.reserveCalls(this.jobId,8);
    await mkdir(join(workspace,'.opencode','agents'),{recursive:true});
    await writeFile(join(workspace,'.opencode','agents','competition-builder.md'),'---\ndescription: Build a self-contained competition prototype\nmode: primary\nsteps: 8\n---\n实现用户要求的源代码，所有面向用户的文字只读取已有 copy.js。不得改写 copy.js 或添加文字素材。\n','utf8');
    const session=await this.client.session.create({agent:'competition-builder',model:this.cfg.reviewer,location:{directory:workspace},permissions:[{action:'*',resource:'*',effect:'deny'},{action:'read',resource:'*',effect:'allow'},{action:'glob',resource:'*',effect:'allow'},{action:'grep',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'allow'},{action:'edit',resource:'copy.js',effect:'deny'},{action:'edit',resource:'*/copy.js',effect:'deny'},{action:'external_directory',resource:'*',effect:'deny'},{action:'shell',resource:'*',effect:'deny'},{action:'execute',resource:'*',effect:'deny'}]},{signal:AbortSignal.timeout(30_000)});
    await this.client.session.prompt({sessionID:session.id,text:prompt},{signal:AbortSignal.timeout(30_000)});
    try{await this.client.session.wait({sessionID:session.id},{signal:AbortSignal.timeout(240_000)});}catch(e){await this.client.session.interrupt({sessionID:session.id}).catch(()=>{});throw e;}
    const state=await this.client.session.get({sessionID:session.id},{signal:AbortSignal.timeout(30_000)});if(state.outcome!=='succeeded')throw Error(`代码 Agent 未成功完成：${state.outcome||'未知状态'}`);
  }
}

export function authHeaders():Record<string,string> { if(process.env.OPENCODE_PASSWORD) return {authorization:`Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64')}`}; if(process.env.OPENCODE_TOKEN) return {authorization:`Bearer ${process.env.OPENCODE_TOKEN}`}; return {}; }

export function parseJSON(raw:string):unknown { let s=raw.trim(); if(s.startsWith('```')) s=s.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''); try{return JSON.parse(s);}catch{throw Error('模型返回的结构化数据不是有效 JSON；原始内容未被当作事实保存');} }
