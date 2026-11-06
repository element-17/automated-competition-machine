import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { agents, type AgentName } from './prompts.js';

/** 调用模型的接口协议。openai 指 Chat Completions 兼容接口。 */
export const protocols=['gemini','anthropic','openai'] as const;
export type Protocol=typeof protocols[number];
export const protocolLabels:Record<Protocol,string>={gemini:'Gemini API',anthropic:'Anthropic Messages',openai:'OpenAI 兼容（Chat Completions）'};

export const Provider=z.object({
 id:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/,'供应商 ID 只能用小写字母、数字、- 和 _'),
 label:z.string().min(1),
 protocol:z.enum(protocols),
 baseURL:z.string().url().optional(),
 apiKeyEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/,'环境变量名只能用大写字母、数字和 _').optional(),
});
export type Provider=z.infer<typeof Provider>;
/** 内置供应商可以在配置中用同一 id 覆盖，但不能删除。 */
export const builtinProviders:Provider[]=[
 {id:'google',label:'Google Gemini',protocol:'gemini',apiKeyEnv:'GEMINI_API_KEY'},
 {id:'anthropic',label:'Anthropic Claude',protocol:'anthropic',apiKeyEnv:'ANTHROPIC_API_KEY'},
 {id:'deepseek',label:'DeepSeek',protocol:'anthropic',baseURL:'https://api.deepseek.com/anthropic',apiKeyEnv:'DEEPSEEK_API_KEY'},
 {id:'openai',label:'OpenAI',protocol:'openai',apiKeyEnv:'OPENAI_API_KEY'},
];
const keyAliases:Record<string,string[]>={GEMINI_API_KEY:['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY']};

/** 研究和编码 Agent 需要能读写文件、访问网页的运行时；其余 Agent 直接调用模型接口。 */
export const runtimeNames=['claude-code','codex','opencode'] as const;
export type RuntimeName=typeof runtimeNames[number];
export const agentRuntimes:Partial<Record<AgentName,readonly RuntimeName[]>>={research:['claude-code','opencode'],coder:['codex','claude-code','opencode']};
/** 运行时可以连接的协议；Codex 需要支持 Responses API 的 OpenAI 兼容服务。 */
export const runtimeProtocols:Record<RuntimeName,readonly Protocol[]>={'claude-code':['anthropic'],codex:['openai'],opencode:['anthropic','openai','gemini']};

export const AgentSettings=z.object({
 provider:z.string().optional(),model:z.string().min(1).optional(),runtime:z.enum(runtimeNames).optional(),
 enabled:z.boolean().optional(),maxTurns:z.number().int().min(1).max(100).optional(),maxBudgetUsd:z.number().positive().optional(),timeoutSeconds:z.number().int().min(30).max(3600).optional(),
});
export type AgentSettings=z.infer<typeof AgentSettings>;
type Legacy={providerID?:string;id?:string};
export type ModelConfig={providers?:Provider[];agents?:Partial<Record<AgentName,AgentSettings>>;writer?:Legacy;reviewer?:Legacy;image?:Legacy;coder?:{id?:string};researchAgent?:{enabled?:boolean;maxTurns?:number;maxBudgetUsd?:number}};
export type ResolvedAgent={name:AgentName;provider:Provider;model:string;runtime?:RuntimeName;enabled:boolean;maxTurns:number;maxBudgetUsd:number;timeoutSeconds:number;inherited:boolean};

export function providers(cfg:ModelConfig):Provider[]{const custom=cfg.providers||[];return [...builtinProviders.map(b=>custom.find(c=>c.id===b.id)||b),...custom.filter(c=>!builtinProviders.some(b=>b.id===c.id))];}
export const findProvider=(cfg:ModelConfig,id:string)=>providers(cfg).find(p=>p.id===id);
/** 各 Agent 的显式设置；旧版 writer/reviewer/image/coder/researchAgent 字段在这里转换。研究和初筛未设置供应商时沿用评审。 */
export function explicitAgents(cfg:ModelConfig):Partial<Record<AgentName,AgentSettings>>{
 const out:Partial<Record<AgentName,AgentSettings>>={};const legacy=(x?:Legacy)=>x?.providerID||x?.id?{...(x.providerID?{provider:x.providerID}:{}),...(x.id?{model:x.id}:{})}:undefined;
 const w=legacy(cfg.writer),r=legacy(cfg.reviewer),i=legacy(cfg.image);if(w)out.writer=w;if(r)out.reviewer=r;if(i)out.image=i;if(cfg.coder?.id)out.coder={provider:'openai',model:cfg.coder.id};
 if(cfg.researchAgent)out.research={...(cfg.researchAgent.enabled!==undefined?{enabled:cfg.researchAgent.enabled}:{}),...(cfg.researchAgent.maxTurns?{maxTurns:cfg.researchAgent.maxTurns}:{}),...(cfg.researchAgent.maxBudgetUsd?{maxBudgetUsd:cfg.researchAgent.maxBudgetUsd}:{})};
 for(const [name,value] of Object.entries(cfg.agents||{}))out[name as AgentName]={...out[name as AgentName],...value};return out;
}
const fallback=():Record<AgentName,{provider:string;model:string}>=>({writer:{provider:'google',model:process.env.GEMINI_MODEL||'gemini-2.5-pro'},reviewer:{provider:'anthropic',model:process.env.CLAUDE_MODEL||'claude-sonnet-4-5'},screener:{provider:'',model:''},planner:{provider:'',model:''},research:{provider:'google',model:process.env.GEMINI_RESEARCH_MODEL||process.env.GEMINI_MODEL||'gemini-2.5-flash'},coder:{provider:'openai',model:process.env.CODEX_MODEL||'gpt-5.4'},image:{provider:'google',model:'gemini-2.5-flash-image'}});
export function resolveAgent(cfg:ModelConfig,name:AgentName):ResolvedAgent{
 const set=explicitAgents(cfg),own=set[name]||{},base=fallback();let provider=own.provider,model=own.model,inherited=false;
 // 研究默认使用独立的 Gemini 研究模型；旧版 researchAgent 配置仍保持兼容并沿用评审模型。
 const legacyResearch=!cfg.agents||!cfg.agents.research||(!cfg.agents.research.provider&&(!!cfg.reviewer||!!cfg.agents.reviewer));
 if((name==='screener'||name==='planner'||(name==='research'&&(cfg.researchAgent||legacyResearch)))&&!provider){const reviewer=resolveAgent(cfg,'reviewer');provider=reviewer.provider.id;model=model||reviewer.model;inherited=true;}
 provider=provider||base[name].provider;model=model||base[name].model;const p=findProvider(cfg,provider);if(!p)throw Error(`${name} 使用的供应商 ${provider} 不存在`);
 const runtime=agentRuntimes[name]?own.runtime||(name==='research'?(p.protocol==='anthropic'?'claude-code':'opencode'):'codex'):undefined;
 return {name,provider:p,model,...(runtime?{runtime}:{}),enabled:own.enabled??true,maxTurns:own.maxTurns??(name==='coder'?20:name==='research'?8:4),maxBudgetUsd:own.maxBudgetUsd??1,timeoutSeconds:own.timeoutSeconds??(runtime?1200:300),inherited};
}
export const modelLabel=(cfg:ModelConfig,name:AgentName)=>{const a=resolveAgent(cfg,name);return `${a.provider.id}/${a.model}`;};
/** 检查所有 Agent 的供应商存在且协议与运行时匹配，返回问题列表。 */
export function modelProblems(cfg:ModelConfig):string[]{const out:string[]=[];for(const name of agents){let a:ResolvedAgent;try{a=resolveAgent(cfg,name);}catch(e){out.push(e instanceof Error?e.message:String(e));continue;}if(!a.enabled)continue;
 if(a.runtime&&!runtimeProtocols[a.runtime].includes(a.provider.protocol))out.push(`${name} 的运行时 ${a.runtime} 不支持 ${a.provider.label} 的 ${protocolLabels[a.provider.protocol]} 协议`);
 if(name==='image'&&a.provider.protocol==='anthropic')out.push('图片生成只支持 Gemini 协议或 OpenAI 兼容（images/generations）的供应商');}return out;}

export const keyNames=(p:Provider)=>p.apiKeyEnv?keyAliases[p.apiKeyEnv]||[p.apiKeyEnv]:[];
export const apiKey=(p:Provider)=>{for(const k of keyNames(p))if(process.env[k])return process.env[k];return undefined;};
/** 不需要密钥的供应商（如本地服务）视为已配置。 */
export const hasKey=(p:Provider)=>!p.apiKeyEnv||!!apiKey(p);
export const agentReady=(cfg:ModelConfig,name:AgentName)=>{try{return hasKey(resolveAgent(cfg,name).provider);}catch{return false;}};

export const envPath=()=>fileURLToPath(new URL('../../.env',import.meta.url));
/** 把密钥写入项目 .env（已被 Git 忽略）并更新当前进程；不在配置文件中保存密钥。 */
export function saveEnvKey(name:string,value:string,file=envPath()){
 if(!/^[A-Z][A-Z0-9_]*$/.test(name))throw Error('环境变量名无效');if(/[\r\n"]/.test(value))throw Error('密钥不能包含换行或双引号');
 const line=`${name}=${/[\s#']/.test(value)?`"${value}"`:value}`;const lines=existsSync(file)?readFileSync(file,'utf8').split(/\r?\n/):[];const i=lines.findIndex(l=>l.replace(/^export\s+/,'').startsWith(`${name}=`));
 while(lines.length&&lines.at(-1)==='')lines.pop();if(i>=0)lines[i]=line;else lines.push(line);writeFileSync(file,lines.join('\n')+'\n','utf8');process.env[name]=value;
}
