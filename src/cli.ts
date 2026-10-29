#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { OfficialGateway } from './gateway.js';
import { fetchDocument, normalizeUrl, searchLogged } from './sources.js';
import { runJob } from './workflow.js';
import { discoverCompetitions, runAutomatic } from './autonomous.js';
import { processQueue } from './queue.js';

const program=new Command();
program.name('compete').description('高校竞赛发现、研究和作品制作 CLI').version('0.1.0').option('-c, --config <path>','配置文件路径');
function context(){const cfg=loadConfig(program.opts().config); const store=new Store(cfg.dataDir); return {cfg,store,gateway:new OfficialGateway(cfg,store)};}
function print(x:unknown){console.log(JSON.stringify(x,null,2));}
program.command('doctor').description('检查模型和搜索配置').action(()=>{const {cfg,store}=context();try{const report={dataDir:cfg.dataDir,writer:cfg.writer,reviewer:cfg.reviewer,coder:cfg.coder,credentials:{gemini:!!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||process.env.GOOGLE_GENERATIVE_AI_API_KEY),reviewer:cfg.reviewer.providerID==='deepseek'?!!process.env.DEEPSEEK_API_KEY:!!process.env.ANTHROPIC_API_KEY,codex:!!process.env.OPENAI_API_KEY,search:cfg.search.provider==='brave'?!!process.env.BRAVE_SEARCH_API_KEY:!!cfg.search.url},search:cfg.search,researchAgent:cfg.researchAgent,note:'仅检查配置存在，不验证密钥、模型权限、网络或配额；不会输出密钥'};print(report);if(!report.credentials.gemini||!report.credentials.reviewer||!report.credentials.search)process.exitCode=1;}finally{store.close();}});
program.command('scan').description('发现或导入公开赛事公告').option('-q, --query <query>','搜索关键词').option('-u, --url <url>','导入赛事公告 URL').action(async(opts)=>{
  const {cfg,store,gateway}=context(); try{
    if(opts.url){const d=await fetchDocument(opts.url);const id=store.addCompetition(normalizeUrl(opts.url),d.title);const enqueued=store.enqueue(id);print({id,title:d.title,url:normalizeUrl(opts.url),enqueued}); return;}
    const year=new Date().getFullYear(); const queries=opts.query?[opts.query]:[`${year} 大学生 竞赛 征集作品 通知`,`${year} 高校 翻译大赛 征稿 通知`,`${year} 大学生 创新设计大赛 征集作品 通知`]; const found=[];
    let enqueued=0;for(const q of queries){ const rs=await searchLogged(store,gateway,null,q); for(const r of rs){try{const url=normalizeUrl(r.url);const id=store.addCompetition(url,r.title);if(store.enqueue(id))enqueued++;found.push({id,title:r.title,url,query:q});}catch{}} }
    for(const url of cfg.sources){try{const page=await fetchDocument(url); for(const x of page.links.filter(x=>/竞赛|大赛|征集|报名|作品/.test(x.title)).slice(0,20)){const id=store.addCompetition(x.url,x.title);if(store.enqueue(id))enqueued++;found.push({id,title:x.title,url:x.url,query:`来源:${url}`});}}catch(e){console.error(`来源读取失败 ${url}: ${e instanceof Error?e.message:String(e)}`);}}
    print({found,enqueued}); if(!found.length){console.error('没有找到结果；检查搜索服务，或使用 scan --url 导入官方公告。');process.exitCode=1;}
  }finally{store.close();}
});
program.command('list').description('列出已发现赛事').action(()=>{const {store}=context();try{print(store.list());}finally{store.close();}});
program.command('show').description('查看赛事、规则、证据及检索日志').argument('<competition-id>').action((id)=>{const {store}=context();try{print({competition:store.competition(id),evidence:store.evidence(id).map(({text,...x})=>({...x,excerpt:text.slice(0,500)})),searches:store.searches(id)});}finally{store.close();}});
program.command('research').description('研究赛事规则与往届公开作品').argument('<competition-id>').option('--budget <calls>','最多模型调用次数',Number).action(async(id,opts)=>{
  const {cfg,store}=context();try{store.competition(id); const job=store.createJob(id,'research',{},opts.budget??cfg.maxCalls); console.log(`任务 ID: ${job}`); const result=await runJob(cfg,store,new OfficialGateway(cfg,store,job),job); print({jobId:job,outputPath:result.outputPath});}finally{store.close();}
});
program.command('produce').description('制作翻译或报告作品').argument('<competition-id>').option('--type <type>','作品类型：translation、report；唯一可识别时自动选择').requiredOption('--source <path>','原文或材料文件路径').option('--target <language>','翻译目标语言').option('--instructions <text>','报告撰写要求').requiredOption('--format <format>','输出格式：txt、md、docx').option('--budget <calls>','最多模型调用次数',Number).action(async(id,opts)=>{
  const {cfg,store}=context();try{const c=store.competition(id);if(!c.brief) throw Error('请先执行 research，核对比赛交付要求');const types=new Set<string>();for(const d of c.brief.deliverables){if(/translation|翻译|译文|译稿/i.test(d.type))types.add('translation');if(/report|document|proposal|报告|文档|文稿|方案书|申报书/i.test(d.type))types.add('report');}const type=opts.type||(types.size===1?[...types][0]:null);if(!type)throw Error('无法唯一确定已支持的交付类型，请使用 --type 指定；不支持的类型请人工处理');if(!['translation','report'].includes(type))throw Error(`暂不支持作品类型：${type}；赛事档案已保留`); const job=store.createJob(id,type,{sourcePath:opts.source,targetLanguage:opts.target||'',instructions:opts.instructions||'',format:opts.format.toLowerCase()},opts.budget??cfg.maxCalls); console.log(`任务 ID: ${job}`); const result=await runJob(cfg,store,new OfficialGateway(cfg,store,job),job); print({jobId:job,outputPath:result.outputPath});}finally{store.close();}
});
program.command('status').description('查看任务及已保存产物').argument('<job-id>').action(id=>{const {store}=context();try{print({job:store.job(id),artifacts:store.artifacts(id)});}finally{store.close();}});
program.command('queue').description('查看持久化赛事处理队列').action(()=>{const {store}=context();try{print(store.queue());}finally{store.close();}});
program.command('enqueue').description('将已有赛事加入队列').argument('[competition-id]').option('--all','加入所有已发现赛事').option('--redo','重新加入已完成或失败的赛事').action((id,opts)=>{const {store}=context();try{if(!id&&!opts.all)throw Error('请指定赛事 ID 或 --all');if(id&&opts.all)throw Error('赛事 ID 和 --all 不能同时使用');const ids=id?[id]:store.list().map(x=>x.id as string);let enqueued=0;for(const item of ids)if(store.enqueue(item,!!opts.redo))enqueued++;print({enqueued});}finally{store.close();}});
program.command('retry').description('将失败的队列项重新加入等待队列').argument('[competition-id]','不指定时重试所有失败项').action(id=>{const {store}=context();try{print({requeued:store.retryQueue(id)});}finally{store.close();}});
async function workQueue(cfg:ReturnType<typeof loadConfig>,store:Store,opts:{limit:number;budget:number}) {
 if(!Number.isInteger(opts.limit)||opts.limit<1||!Number.isInteger(opts.budget)||opts.budget<1)throw Error('limit 和 budget 必须为正整数');
 if(!store.queue().some((x:any)=>x.state==='queued'||x.state==='processing'))return [];
 if(!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||process.env.GOOGLE_GENERATIVE_AI_API_KEY)||!(cfg.reviewer.providerID==='deepseek'?process.env.DEEPSEEK_API_KEY:process.env.ANTHROPIC_API_KEY))throw Error(`赛事队列已保存，但模型不可用：请配置 GEMINI_API_KEY 和 ${cfg.reviewer.providerID==='deepseek'?'DEEPSEEK_API_KEY':'ANTHROPIC_API_KEY'}`);
 return processQueue(store,{limit:opts.limit,budget:opts.budget,onStart:task=>console.log(`${task.resume?'恢复':'开始'} ${store.competition(task.competitionId).title}；任务 ${task.jobId}`),onError:(task,error)=>console.error(`任务 ${task.jobId} 未完成：${error}`),run:task=>runAutomatic(cfg,store,new OfficialGateway(cfg,store,task.jobId),task.jobId,task.resume)});
}
program.command('work').description('按顺序处理已持久化的赛事队列').option('--limit <number>','本次最多处理的赛事数',Number,3).option('--budget <calls>','每场赛事最多模型调用次数',Number,30).action(async(opts)=>{const {cfg,store}=context();try{const processed=await workQueue(cfg,store,opts);print({processed});if(processed.some(x=>x.error))process.exitCode=1;}finally{store.close();}});
program.command('resume').description('从持久检查点恢复失败任务').argument('<job-id>').option('--budget <calls>','调整总模型调用次数上限',Number).action(async(id,opts)=>{
  const {cfg,store}=context();try{const job=store.job(id);const queued=store.queue().find((x:any)=>x.jobId===id) as {state:string;competitionId:string}|undefined;if(queued&&queued.state!=='completed')throw Error(`此任务属于赛事队列，请使用 retry ${queued.competitionId} 后运行 work --budget <次数>；处理中任务请等待`);if(opts.budget!==undefined)store.setBudget(id,opts.budget);const gateway=new OfficialGateway(cfg,store,id); const result=job.kind==='automatic'?await runAutomatic(cfg,store,gateway,id,true):await runJob(cfg,store,gateway,id,true);print({jobId:id,result});}finally{store.close();}
});
program.command('auto').description('自动发现赛事、追查往届作品、比较方案并制作可支持的交付物').option('-q, --query <query>','限定搜索方向；不指定时覆盖多种赛事').option('-u, --url <url>','直接处理指定公告；不指定时自动发现').option('--limit <number>','本次最多处理的赛事数',Number,3).option('--budget <calls>','每场赛事最多模型调用次数',Number,30).option('--redo','重新处理已完成的赛事').action(async(opts)=>{
 const {cfg,store}=context();try{if(!Number.isInteger(opts.limit)||opts.limit<1||!Number.isInteger(opts.budget)||opts.budget<1)throw Error('limit 和 budget 必须为正整数');const discoveryGateway=new OfficialGateway(cfg,store);let ids:string[];
 if(opts.url){const page=await fetchDocument(opts.url);ids=[store.addCompetition(normalizeUrl(opts.url),page.title)];}else ids=await discoverCompetitions(store,discoveryGateway,opts.query,cfg.sources);
 let added=0;for(const id of ids)if(store.enqueue(id,!!opts.redo))added++;const queued=store.queue().filter((x:any)=>x.state==='queued'||x.state==='processing').length;console.log(`发现 ${ids.length} 个赛事候选，新入队 ${added} 个；队列中 ${queued} 个等待或正在处理，本次最多处理 ${opts.limit} 个。候选并不保证仍可报名。`);if(!queued){print({discovered:ids.length,enqueued:added,processed:[],note:ids.length?'已处理过所有候选；使用 --redo 可重新处理':'未发现赛事；请检查搜索服务或稍后重试'});if(!ids.length)process.exitCode=1;return;}
 const results=await workQueue(cfg,store,opts);print({discovered:ids.length,enqueued:added,processed:results});if(results.some(x=>x.error))process.exitCode=1;
 }finally{store.close();}
});
program.parseAsync().catch(e=>{console.error(`错误：${e instanceof Error?e.message:String(e)}`);process.exitCode=1;});
