import { OpenCode } from '@opencode/client';
import type { AppConfig } from './config.js';
import type { ModelGateway, ModelRole } from './types.js';
import type { Store } from './store.js';

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
}

export function authHeaders():Record<string,string> { if(process.env.OPENCODE_PASSWORD) return {authorization:`Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64')}`}; if(process.env.OPENCODE_TOKEN) return {authorization:`Bearer ${process.env.OPENCODE_TOKEN}`}; return {}; }

export function parseJSON(raw:string):unknown { let s=raw.trim(); if(s.startsWith('```')) s=s.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''); try{return JSON.parse(s);}catch{throw Error('模型返回的结构化数据不是有效 JSON；原始内容未被当作事实保存');} }
