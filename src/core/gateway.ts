import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executionSettings, searchSettings, type AppConfig, type SearchSettings } from './config.js';
import type { ModelGateway, ModelRole, SearchOptions, SearchResult } from './types.js';
import { promptOf, type AgentName } from '../agents/prompts.js';
import { apiKey, resolveAgent, runtimeProtocols, protocolLabels, type ResolvedAgent } from '../agents/models.js';
import { runtimeReady } from '../agents/runtimes.js';
import { runAgentTask, type Drivers } from '../agents/agents.js';
import type { Store } from './store.js';
import { saveJobProgress, type JobProgress } from './job-progress.js';
import { assertJobCanRun } from './job-control.js';

/** 解析模型结构化输出；失败时保留模型原文，便于定位模型到底返回了什么。 */
export function parseJSON(raw:string):unknown {let s=raw.trim();if(s.startsWith('```'))s=s.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(s);}catch{const shown=s.length>12000?`${s.slice(0,12000)}\n…（原始返回过长，已截断；完整内容长度 ${s.length} 字符）`:s;throw Error(`模型返回的结构化数据不是有效 JSON；原始内容如下（未被当作事实保存）：\n--- 模型原始返回开始 ---\n${shown}\n--- 模型原始返回结束 ---`);}}
const agentNames:Record<AgentName,string>={writer:'写作',reviewer:'评审',planner:'调度规划',screener:'搜索结果评估',research:'研究',coder:'编码',image:'图片'};
export type GatewayProgress={agent:AgentName;model:string;provider:string;action:string;raw?:string;stage?:string;taskId?:string;round?:number;maxRounds?:number;elapsedSeconds?:number;budget?:{used:number;limit:number}};

/** 按 Agent 配置的供应商协议调用模型；研究和编码交给所选运行时。 */
/** 按文件头判断图片类型。 */
const sniff=(b:Buffer)=>b[0]===0x89&&b[1]===0x50?'image/png':b[0]===0xff&&b[1]===0xd8?'image/jpeg':b.subarray(8,12).toString()==='WEBP'?'image/webp':'image/png';
export class OfficialGateway implements ModelGateway {
 private phase:JobProgress|undefined;
 constructor(private cfg:AppConfig,private store?:Store,private jobId?:string,private drivers:Drivers={},private onProgress?:(event:GatewayProgress)=>void){}
 get canSearch(){return this.cfg.search?.provider!=='sources';}
 private charge(count=1){if(this.jobId&&this.store){assertJobCanRun(this.store,this.jobId);this.store.reserveCalls(this.jobId,count);}}
 private agent(name:AgentName){return resolveAgent(this.cfg,name);}
 private key(a:ResolvedAgent){const key=apiKey(a.provider);if(a.provider.apiKeyEnv&&!key)throw Error(`缺少 ${a.provider.apiKeyEnv}`);return key||'none';}
 async reportProgress(event:JobProgress){
  this.phase=event;
  const agent:AgentName=event.stage==='planning'?'planner':event.stage==='review'?'reviewer':event.stage==='research'?'research':'writer';
  const a=this.agent(agent),job=this.jobId&&this.store?this.store.job(this.jobId):null;
  const enriched={...event,...(job?{budget:{used:job.calls,limit:job.maxCalls}}:{})};
  this.onProgress?.({agent,model:a.model,provider:a.provider.label,...enriched});
  if(this.jobId)await saveJobProgress(this.cfg.dataDir,this.jobId,enriched);
 }
 private async tracked<T>(a:ResolvedAgent,action:string,run:()=>Promise<T>):Promise<T>{
  const started=Date.now();let writes=Promise.resolve();
  const emit=(message:string)=>{
    const job=this.jobId&&this.store?this.store.job(this.jobId):null;
    const progress={...this.phase,stage:a.name,action:message,elapsedSeconds:Math.floor((Date.now()-started)/1000),...(job?{budget:{used:job.calls,limit:job.maxCalls}}:{})};
    this.onProgress?.({agent:a.name,model:a.model,provider:a.provider.label,...progress});
    if(this.jobId)writes=writes.then(()=>saveJobProgress(this.cfg.dataDir,this.jobId!,progress)).catch(()=>{});
  };
  emit(action);const timer=setInterval(()=>emit(`${action}；仍在执行`),15_000);timer.unref();
  try{const result=await run();emit(`${action}完成`);return result;}
  catch(e){emit(`${action}未完成，保留已有进度`);throw e;}
  finally{clearInterval(timer);await writes;}
 }
 /** role 只决定任务类型；模型、供应商和系统提示词都按 agent 读取，未指定时与 role 相同。 */
 async generate(role:ModelRole,prompt:string,agent:AgentName=role){
  this.charge();const a=this.agent(agent);try{const text=await this.tracked(a,'调用模型',()=>this.complete(a,promptOf(this.cfg,agent),prompt));if(!text.trim())throw Error(`${a.provider.label} 返回空内容`);this.onProgress?.({agent,model:a.model,provider:a.provider.label,action:'模型返回',raw:text});return text;}
  catch(e){throw Error(`${agentNames[agent]}模型（${a.provider.label}）调用失败：${e instanceof Error?e.message:String(e)}；不会切换其他模型`);}
 }
 private async complete(a:ResolvedAgent,system:string,prompt:string):Promise<string>{let last:unknown;for(let attempt=0;attempt<3;attempt++){try{return await this.completeOnce(a,system,prompt);}catch(e){last=e;if(!this.retryable(e)||attempt===2)throw e;await new Promise(r=>setTimeout(r,1000*2**attempt));}}throw last;}
 private retryable(error:unknown){const message=error instanceof Error?error.message:String(error);return /timeout|timed out|aborted|fetch failed|network|socket|ECONN|429|500|502|503|504|52[0-4]|overloaded|temporar|rate.?limit/i.test(message);}
 private async completeOnce(a:ResolvedAgent,system:string,prompt:string):Promise<string>{const key=this.key(a),signal=AbortSignal.timeout(executionSettings(this.cfg).requestTimeoutSeconds*1000),p=a.provider;
  if(p.protocol==='gemini'){const baseUrl=p.baseURL||process.env.COMPETE_GEMINI_BASE_URL;const response=await new GoogleGenAI({apiKey:key,...(baseUrl?{httpOptions:{baseUrl}}:{})}).models.generateContent({model:a.model,contents:prompt,config:{systemInstruction:system,abortSignal:signal}});return response.text||'';}
  if(p.protocol==='anthropic'){const deepseek=/(^|\.)deepseek\.com$/.test(p.baseURL?new URL(p.baseURL).hostname:'');const response=await new Anthropic({apiKey:key,maxRetries:0,...(p.baseURL?{baseURL:p.baseURL}:{})}).messages.create({model:a.model,max_tokens:8192,system,...(deepseek?{thinking:{type:'disabled' as const}}:{}),messages:[{role:'user',content:prompt}]},{signal});return response.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');}
  // 流式请求：长文生成时中转站（Cloudflare 等）在约 100 秒无数据后会返回 524；服务端不支持流式而直接返回 JSON 时照常解析。
  const base=(p.baseURL||'https://api.openai.com/v1').replace(/\/$/,'');const res=await fetch(`${base}/chat/completions`,{method:'POST',signal,headers:{'content-type':'application/json',accept:'text/event-stream, application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model:a.model,stream:true,messages:[{role:'system',content:system},{role:'user',content:prompt}]})});
  if(!res.ok){const json=await res.json().catch(()=>null) as any;throw Error(`HTTP ${res.status} ${json?.error?.message||''}`.trim());}
  if(!/text\/event-stream/i.test(res.headers.get('content-type')||'')){const json=await res.json().catch(()=>null) as any;const content=json?.choices?.[0]?.message?.content;return typeof content==='string'?content:'';}
  let text='',buffer='';const decoder=new TextDecoder();
  const line=(raw:string)=>{const l=raw.trim();if(!l.startsWith('data:'))return;const data=l.slice(5).trim();if(!data||data==='[DONE]')return;let chunk:any;try{chunk=JSON.parse(data);}catch{return;}if(chunk?.error)throw Error(`流式响应错误：${chunk.error.message||JSON.stringify(chunk.error).slice(0,300)}`);const delta=chunk?.choices?.[0]?.delta?.content??chunk?.choices?.[0]?.message?.content;if(typeof delta==='string')text+=delta;};
  for await(const part of res.body as unknown as AsyncIterable<Uint8Array>){buffer+=decoder.decode(part,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const l of lines)line(l);}
  line(buffer+decoder.decode());return text;}
 /** 未传 options 时只取一页且不限时间，供研究往届资料使用；赛事发现会传入配置的页数和时间范围。 */
 async search(queryText:string,options:SearchOptions={}){const search=searchSettings(this.cfg);if(search.provider==='sources')throw Error('来源列表模式未配置全网关键词搜索');const pages=options.pages??1,timeRange=options.timeRange??'any';const found:SearchResult[]=[];
  for(let page=1;page<=pages;page++){let batch:SearchResult[];try{batch=await this.searchPage(search,queryText,page,timeRange);}catch(e){if(page===1)throw e;break;}const fresh=batch.filter(x=>!found.some(y=>y.url===x.url));found.push(...fresh);if(!fresh.length)break;}
  return found;}
 private async searchPage(search:SearchSettings,queryText:string,page:number,timeRange:SearchOptions['timeRange']):Promise<SearchResult[]>{let url:URL;const headers:Record<string,string>={accept:'application/json'};
  if(search.provider==='brave'){if(!process.env.BRAVE_SEARCH_API_KEY)throw Error('缺少 BRAVE_SEARCH_API_KEY；也可配置 SearXNG');url=new URL(search.url||'https://api.search.brave.com/res/v1/web/search');url.searchParams.set('q',queryText);url.searchParams.set('count','20');if(page>1)url.searchParams.set('offset',String(Math.min(9,page-1)));const fresh={day:'pd',week:'pw',month:'pm',year:'py'} as Record<string,string>;if(timeRange&&fresh[timeRange])url.searchParams.set('freshness',fresh[timeRange]);headers['X-Subscription-Token']=process.env.BRAVE_SEARCH_API_KEY;}
  else{if(!search.url)throw Error('SearXNG 缺少 search.url');url=new URL('search',search.url.endsWith('/')?search.url:`${search.url}/`);url.searchParams.set('q',queryText);url.searchParams.set('format','json');url.searchParams.set('pageno',String(page));if(search.language)url.searchParams.set('language',search.language);if(timeRange&&timeRange!=='any')url.searchParams.set('time_range',timeRange);}
  const res=await fetch(url,{headers,signal:AbortSignal.timeout(45_000)});if(!res.ok)throw Error(search.provider==='searxng'&&res.status===403?'SearXNG 拒绝 JSON 请求 (403)；请在 settings.yml 的 search.formats 中加入 json':`搜索服务失败 (${res.status})`);const json=await res.json() as any;const results=search.provider==='brave'?json.web?.results:json.results;if(!Array.isArray(results))throw Error('搜索服务没有返回有效结果');
  if(!results.length&&page===1&&Array.isArray(json.unresponsive_engines)&&json.unresponsive_engines.length)throw Error(`SearXNG 引擎均无结果：${json.unresponsive_engines.map((x:unknown)=>Array.isArray(x)?x.join(' '):String(x)).join('；')}`);
  return results.filter((x:any)=>typeof x.url==='string').map((x:any)=>({url:x.url,title:String(x.title||x.url),snippet:String(x.description||x.content||'')}));}
 /** 把实际图片交给评审模型看图评审；用于图片作品和 PPT 中图片的视觉验收。 */
 async inspectImage(prompt:string,image:{data:Buffer;mime:string},agent:AgentName='reviewer'){
  this.charge();const a=this.agent(agent);const system=promptOf(this.cfg,agent);const b64=image.data.toString('base64');
  try{const text=await this.tracked(a,'查看图片并评审',async()=>{const key=this.key(a),signal=AbortSignal.timeout(executionSettings(this.cfg).requestTimeoutSeconds*1000),p=a.provider;
    if(p.protocol==='anthropic'){const deepseek=/(^|\.)deepseek\.com$/.test(p.baseURL?new URL(p.baseURL).hostname:'');const r=await new Anthropic({apiKey:key,maxRetries:0,...(p.baseURL?{baseURL:p.baseURL}:{})}).messages.create({model:a.model,max_tokens:4096,system,...(deepseek?{thinking:{type:'disabled' as const}}:{}),messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:image.mime as 'image/png',data:b64}},{type:'text',text:prompt}]}]},{signal});return r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');}
    if(p.protocol==='gemini'){const baseUrl=p.baseURL||process.env.COMPETE_GEMINI_BASE_URL;const r=await new GoogleGenAI({apiKey:key,...(baseUrl?{httpOptions:{baseUrl}}:{})}).models.generateContent({model:a.model,contents:[{role:'user',parts:[{inlineData:{mimeType:image.mime,data:b64}},{text:prompt}]}],config:{systemInstruction:system,abortSignal:signal}});return r.text||'';}
    const base=(p.baseURL||'https://api.openai.com/v1').replace(/\/$/,'');const res=await fetch(`${base}/chat/completions`,{method:'POST',signal,headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model:a.model,messages:[{role:'system',content:system},{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:`data:${image.mime};base64,${b64}`}}]}]})});
    const json=await res.json().catch(()=>null) as any;if(!res.ok)throw Error(`HTTP ${res.status} ${json?.error?.message||''}`.trim());const content=json?.choices?.[0]?.message?.content;return typeof content==='string'?content:'';});
   if(!text.trim())throw Error(`${a.provider.label} 返回空内容`);return text;}
  catch(e){throw Error(`${agentNames[agent]}模型（${a.provider.label}）看图调用失败：${e instanceof Error?e.message:String(e)}`);}
 }
 async generateImage(prompt:string){this.charge();const a=this.agent('image');this.onProgress?.({agent:'image',model:a.model,provider:a.provider.label,action:'生成图片'});try{const full=`${promptOf(this.cfg,'image')}\n\n${prompt}`;const signal=AbortSignal.timeout(executionSettings(this.cfg).requestTimeoutSeconds*1000);
  const image=a.provider.protocol==='openai'?await this.tracked(a,'生成图片',()=>this.openaiImage(a,full,signal)):a.provider.protocol==='gemini'?await this.tracked(a,'生成图片',()=>this.geminiImage(a,full,signal)):(()=>{throw Error('图片生成只支持 Gemini 协议或 OpenAI 兼容的 images/generations 接口');})();
  if(!image.data.length||image.data.length>20_000_000)throw Error('图片为空或超过 20 MB');return image;}catch(e){throw Error(`图片模型调用失败：${e instanceof Error?e.message:String(e)}`);}}
 private async geminiImage(a:ResolvedAgent,prompt:string,signal:AbortSignal){const baseUrl=a.provider.baseURL||process.env.COMPETE_GEMINI_BASE_URL;const response=await new GoogleGenAI({apiKey:this.key(a),...(baseUrl?{httpOptions:{baseUrl}}:{})}).models.generateContent({model:a.model,contents:prompt,config:{responseModalities:['TEXT','IMAGE'],abortSignal:signal}});const part=response.candidates?.flatMap(c=>c.content?.parts||[]).find(p=>p.inlineData?.data&&/^image\/(png|jpeg|webp)$/.test(p.inlineData.mimeType||''));if(!part?.inlineData?.data)throw Error('图片模型未返回图片');return {data:Buffer.from(part.inlineData.data,'base64'),mime:part.inlineData.mimeType!};}
 /** OpenAI 兼容的 images/generations（gpt-image 等）；返回 b64_json 或图片 URL。 */
 private async openaiImage(a:ResolvedAgent,prompt:string,signal:AbortSignal){const base=(a.provider.baseURL||'https://api.openai.com/v1').replace(/\/$/,'');
  const res=await fetch(`${base}/images/generations`,{method:'POST',signal,headers:{'content-type':'application/json',authorization:`Bearer ${this.key(a)}`},body:JSON.stringify({model:a.model,prompt,size:'1536x1024',n:1})});const json=await res.json().catch(()=>null) as any;if(!res.ok)throw Error(`HTTP ${res.status} ${json?.error?.message||''}`.trim());
  const item=json?.data?.[0];if(item?.b64_json){const data=Buffer.from(item.b64_json,'base64');return {data,mime:sniff(data)};}
  if(typeof item?.url==='string'){const img=await fetch(item.url,{signal});if(!img.ok)throw Error(`下载图片失败 (${img.status})`);const data=Buffer.from(await img.arrayBuffer());return {data,mime:sniff(data)};}
  throw Error('图片模型未返回图片');}
 private runnable(name:'research'|'coder'){const a=this.agent(name);if(a.runtime&&!runtimeProtocols[a.runtime].includes(a.provider.protocol))throw Error(`${agentNames[name]} Agent 的运行时 ${a.runtime} 不支持 ${protocolLabels[a.provider.protocol]}，请在 Agent 设置中调整`);this.key(a);return a;}
 private async runLongTask(a:ResolvedAgent,task:Parameters<typeof runAgentTask>[1]){
  const deadline=Date.now()+task.timeoutMs;let last:unknown;
  for(let attempt=0;attempt<3;attempt++){
    const remaining=deadline-Date.now();if(remaining<=0)throw Error('Agent 执行超时，进度已保留');
    if(attempt)this.charge(task.kind==='research'||a.runtime==='claude-code'?a.maxTurns:8);
    try{return await runAgentTask(a,{...task,timeoutMs:remaining},this.drivers);}
    catch(e){last=e;const message=e instanceof Error?e.message:String(e);if(attempt===2||!/network|socket|ECONN|暂时|临时|退出码/i.test(message))throw e;await new Promise(r=>setTimeout(r,Math.min(1500*2**attempt,Math.max(0,deadline-Date.now()))));}
  }throw last;
 }
 async investigate(prompt:string){if(!this.jobId)throw Error('研究 Agent 必须绑定任务');const a=this.runnable('research');this.onProgress?.({agent:'research',model:a.model,provider:a.provider.label,action:'运行研究 Agent（检索和核对网页）'});this.charge(a.maxTurns);const folder=join(this.cfg.dataDir,'jobs',this.jobId,'claude-research');await mkdir(folder,{recursive:true});
  return this.tracked(a,'研究运行时执行',()=>this.runLongTask(a,{kind:'research',cwd:folder,prompt,system:promptOf(this.cfg,'research'),statePath:join(folder,'session.txt'),eventsPath:join(folder,'events.jsonl'),timeoutMs:a.timeoutSeconds*1000}));}
 async buildProject(workspace:string,prompt:string){const a=this.runnable('coder');this.onProgress?.({agent:'coder',model:a.model,provider:a.provider.label,action:'运行编码 Agent（生成软件作品）'});this.charge(a.runtime==='claude-code'?a.maxTurns:8);const state={codex:'.codex-thread-id','claude-code':'.claude-session-id',opencode:'.opencode-session-id'}[a.runtime!];
  await this.tracked(a,'编码运行时执行',()=>this.runLongTask(a,{kind:'code',cwd:workspace,prompt,system:promptOf(this.cfg,'coder'),statePath:join(workspace,state),eventsPath:join(workspace,'.runtime-events.jsonl'),timeoutMs:a.timeoutSeconds*1000}));}
 async testAgent(name:AgentName):Promise<{agent:AgentName;model:string;provider:string;runtime?:string;detail:string}> {const a=this.agent(name);this.key(a);if(a.runtime){if(!runtimeProtocols[a.runtime].includes(a.provider.protocol))throw Error(`${name} 的运行时 ${a.runtime} 不支持 ${a.provider.protocol} 协议`);if(!runtimeReady(a.runtime))throw Error(`${name} 的运行时 ${a.runtime} 未下载`);return {agent:name,model:a.model,provider:a.provider.label,runtime:a.runtime,detail:'密钥、协议和运行时均可用（未启动实际任务）'};}await this.generate('reviewer','只回复 OK。',name);return {agent:name,model:a.model,provider:a.provider.label,detail:'模型已成功响应'};}
}
