#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { OfficialGateway } from './gateway.js';
import { fetchDocument, normalizeUrl, searchLogged } from './sources.js';
import { runJob } from './workflow.js';
import { discoverCompetitions, runAutomatic, isCompetitionCandidate } from './autonomous.js';
import { processQueue } from './queue.js';
import { startUI } from './ui.js';
import { screenQueue } from './screening.js';

const program=new Command();
program.name('compete').description('高校竞赛发现、研究和作品制作 CLI').version('0.1.0').option('-c, --config <path>','配置文件路径');
program.action(()=>process.stdin.isTTY&&process.stdout.isTTY?startUI(program.opts().config):program.outputHelp());
program.command('ui').description('打开交互式终端界面').action(()=>startUI(program.opts().config));
function context(){const cfg=loadConfig(program.opts().config); const store=new Store(cfg.dataDir); return {cfg,store,gateway:new OfficialGateway(cfg,store)};}
function print(x:unknown){console.log(JSON.stringify(x,null,2));}
program.command('doctor').description('检查模型和搜索配置').action(()=>{const {cfg,store}=context();try{const report={dataDir:cfg.dataDir,writer:cfg.writer,reviewer:cfg.reviewer,coder:cfg.coder,credentials:{gemini:!!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||process.env.GOOGLE_GENERATIVE_AI_API_KEY),reviewer:cfg.reviewer.providerID==='deepseek'?!!process.env.DEEPSEEK_API_KEY:!!process.env.ANTHROPIC_API_KEY,codex:!!process.env.OPENAI_API_KEY,search:cfg.search.provider==='sources'?cfg.sources.length>0:cfg.search.provider==='brave'?!!process.env.BRAVE_SEARCH_API_KEY:!!cfg.search.url},search:cfg.search,searchScope:cfg.search.provider==='sources'?'仅监测已配置来源，不支持全网关键词搜索':'关键词搜索',researchAgent:cfg.researchAgent,note:'仅检查配置存在，不验证密钥、模型权限、网络或配额；不会输出密钥'};print(report);if(!report.credentials.gemini||!report.credentials.reviewer||!report.credentials.search)process.exitCode=1;}finally{store.close();}});
program.command('scan').description('发现或导入公开赛事公告').option('-q, --query <query>','搜索关键词').option('-u, --url <url>','导入赛事公告 URL').action(async(opts)=>{
  const {cfg,store,gateway}=context(); try{
    if(opts.url){const d=await fetchDocument(opts.url);const id=store.addCompetition(normalizeUrl(opts.url),d.title);const enqueued=store.enqueue(id);print({id,title:d.title,url:normalizeUrl(opts.url),enqueued}); return;}
    if(opts.query&&cfg.search.provider==='sources')throw Error('当前仅监测来源列表，不支持关键词搜索；请配置 Brave 或 SearXNG');
    if(cfg.search.provider==='sources')console.error('当前仅扫描配置的高校来源列表，不支持全网关键词搜索。');
    const year=new Date().getFullYear(); const queries=opts.query?[opts.query]:[`${year} 大学生 竞赛 征集作品 通知`,`${year} 高校 翻译大赛 征稿 通知`,`${year} 大学生 创新设计大赛 征集作品 通知`]; const found=[];
    let enqueued=0;for(const q of queries){ const rs=await searchLogged(store,gateway,null,q); for(const r of rs){if(!isCompetitionCandidate(r.title))continue;try{const url=normalizeUrl(r.url);const id=store.addCompetition(url,r.title);if(store.enqueue(id))enqueued++;found.push({id,title:r.title,url,query:q});}catch{}} }
    for(const url of cfg.sources){try{const page=await fetchDocument(url); for(const x of page.links.filter(x=>isCompetitionCandidate(x.title)).slice(0,20)){const id=store.addCompetition(x.url,x.title);if(store.enqueue(id))enqueued++;found.push({id,title:x.title,url:x.url,query:`来源:${url}`});}}catch(e){console.error(`来源读取失败 ${url}: ${e instanceof Error?e.message:String(e)}`);}}
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
program.command('queue-history').description('查看赛事的审核历史').argument('<competition-id>').action(id=>{const {store}=context();try{store.competition(id);print(store.queueReviewHistory(id));}finally{store.close();}});
program.command('queue-add').description('手动添加公告到队列').argument('<url>').option('--title <title>','手动指定名称；不指定时读取公告').action(async(url,opts)=>{const {store}=context();try{const link=normalizeUrl(url);const title=opts.title?.trim()||(await fetchDocument(link)).title;if(!title)throw Error('赛事名称不能为空');const id=store.addCompetition(link,title);print({competitionId:id,enqueued:store.enqueue(id)});}finally{store.close();}});
program.command('queue-edit').description('修改队列中的赛事名称或公告地址').argument('<competition-id>').option('--title <title>','新名称').option('--url <url>','新公告地址').action((id,opts)=>{const {store}=context();try{if(opts.title===undefined&&opts.url===undefined)throw Error('请指定 --title 或 --url');const c=store.competition(id);store.updateQueue(id,opts.title??c.title,opts.url??c.url);print({competitionId:id,reviewStatus:'unreviewed'});}finally{store.close();}});
program.command('queue-delete').description('从队列移除赛事，保留赛事档案和任务产物').argument('<competition-id>').action(id=>{const {store}=context();try{store.deleteQueue(id);print({competitionId:id,removed:true});}finally{store.close();}});
program.command('queue-review').description('用评审模型审核队列，保留原文依据').argument('[competition-id]').option('--limit <number>','最多审核条数',Number,10).option('--force','重新审核已有结果').action(async(id,opts)=>{const {cfg,store,gateway}=context();try{const results=await screenQueue(cfg,store,gateway,{id,limit:opts.limit,force:!!opts.force,onStart:item=>console.error(`审核：${item.title}`)});print({results});}finally{store.close();}});
program.command('queue-decision').description('人工设置审核结果').argument('<competition-id>').argument('<decision>','valid、invalid 或 needs_review').requiredOption('--reason <reason>','人工判断理由').action((id,decision,opts)=>{const {store}=context();try{if(!['valid','invalid','needs_review'].includes(decision))throw Error('审核结果必须为 valid、invalid 或 needs_review');if(!opts.reason.trim())throw Error('请填写判断理由');store.setQueueReview(id,{decision,reason:opts.reason.trim(),reviewer:'manual'});print({competitionId:id,decision});}finally{store.close();}});
program.command('enqueue').description('将已有赛事加入队列').argument('[competition-id]').option('--all','加入所有已发现赛事').option('--redo','重新加入已完成或失败的赛事').action((id,opts)=>{const {store}=context();try{if(!id&&!opts.all)throw Error('请指定赛事 ID 或 --all');if(id&&opts.all)throw Error('赛事 ID 和 --all 不能同时使用');const ids=id?[id]:store.list().map(x=>x.id as string);let enqueued=0;for(const item of ids)if(store.enqueue(item,!!opts.redo))enqueued++;print({enqueued});}finally{store.close();}});
program.command('retry').description('将失败的队列项重新加入等待队列').argument('[competition-id]','不指定时重试所有失败项').action(id=>{const {store}=context();try{print({requeued:store.retryQueue(id)});}finally{store.close();}});
async function workQueue(cfg:ReturnType<typeof loadConfig>,store:Store,opts:{limit:number;budget:number}) {
 if(!Number.isInteger(opts.limit)||opts.limit<1||!Number.isInteger(opts.budget)||opts.budget<1)throw Error('limit 和 budget 必须为正整数');
 if(!store.queue().some((x:any)=>x.state==='queued'||x.state==='processing'))return [];
 const reviewerKey=cfg.reviewer.providerID==='deepseek'?process.env.DEEPSEEK_API_KEY:process.env.ANTHROPIC_API_KEY;if(!reviewerKey)throw Error(`赛事队列已保存，但模型不可用：请配置 ${cfg.reviewer.providerID==='deepseek'?'DEEPSEEK_API_KEY':'ANTHROPIC_API_KEY'}`);
 const reviewed=await screenQueue(cfg,store,new OfficialGateway(cfg,store),{limit:opts.limit,onStart:item=>console.log(`审核：${item.title}`)});if(reviewed.length)console.log(`本次审核 ${reviewed.length} 场，只有审核通过的赛事会进入制作；其他结果可在队列查看。`);
 if(!store.queue().some((x:any)=>x.state==='queued'&&x.reviewStatus==='valid')){console.log('没有审核通过的待处理赛事；可继续审核或人工确认。');return [];}
 if(!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||process.env.GOOGLE_GENERATIVE_AI_API_KEY))throw Error('赛事队列已保存，但模型不可用：请配置 GEMINI_API_KEY');
 return processQueue(store,{limit:opts.limit,budget:opts.budget,onStart:task=>console.log(`${task.resume?'恢复':'开始'} ${store.competition(task.competitionId).title}；任务 ${task.jobId}`),onError:(task,error)=>console.error(`任务 ${task.jobId} 未完成：${error}`),run:task=>runAutomatic(cfg,store,new OfficialGateway(cfg,store,task.jobId),task.jobId,task.resume)});
}
program.command('work').description('按顺序处理已持久化的赛事队列').option('--limit <number>','本次最多处理的赛事数',Number,3).option('--budget <calls>','每场赛事最多模型调用次数',Number,30).action(async(opts)=>{const {cfg,store}=context();try{const processed=await workQueue(cfg,store,opts);print({processed});if(processed.some(x=>x.error))process.exitCode=1;}finally{store.close();}});
program.command('resume').description('从持久检查点恢复失败任务').argument('<job-id>').option('--budget <calls>','调整总模型调用次数上限',Number).action(async(id,opts)=>{
  const {cfg,store}=context();try{const job=store.job(id);const queued=store.queue().find((x:any)=>x.jobId===id) as {state:string;competitionId:string}|undefined;if(queued&&queued.state!=='completed')throw Error(`此任务属于赛事队列，请使用 retry ${queued.competitionId} 后运行 work --budget <次数>；处理中任务请等待`);if(opts.budget!==undefined)store.setBudget(id,opts.budget);const gateway=new OfficialGateway(cfg,store,id); const result=job.kind==='automatic'?await runAutomatic(cfg,store,gateway,id,true):await runJob(cfg,store,gateway,id,true);print({jobId:id,result});}finally{store.close();}
});
program.command('auto').description('自动发现赛事、追查往届作品、比较方案并制作可支持的交付物').option('-q, --query <query>','限定搜索方向；不指定时覆盖多种赛事').option('-u, --url <url>','直接处理指定公告；不指定时自动发现').option('--limit <number>','本次最多处理的赛事数',Number,3).option('--budget <calls>','每场赛事最多模型调用次数',Number,30).option('--redo','重新处理已完成的赛事').action(async(opts)=>{
 const {cfg,store}=context();try{if(opts.query&&cfg.search.provider==='sources'&&!opts.url)throw Error('当前仅监测来源列表，不支持关键词搜索；请配置 Brave 或 SearXNG');if(cfg.search.provider==='sources'&&!opts.url)console.error('当前仅扫描配置的高校来源列表，不支持全网关键词搜索。');if(!Number.isInteger(opts.limit)||opts.limit<1||!Number.isInteger(opts.budget)||opts.budget<1)throw Error('limit 和 budget 必须为正整数');const discoveryGateway=new OfficialGateway(cfg,store);let ids:string[];
 if(opts.url){const page=await fetchDocument(opts.url);ids=[store.addCompetition(normalizeUrl(opts.url),page.title)];}else ids=await discoverCompetitions(store,discoveryGateway,opts.query,cfg.sources);
 let added=0;for(const id of ids)if(store.enqueue(id,!!opts.redo))added++;const queued=store.queue().filter((x:any)=>x.state==='queued'||x.state==='processing').length;console.log(`发现 ${ids.length} 个赛事候选，新入队 ${added} 个；队列中 ${queued} 个等待或正在处理，本次最多处理 ${opts.limit} 个。候选并不保证仍可报名。`);if(!queued){print({discovered:ids.length,enqueued:added,processed:[],note:ids.length?'已处理过所有候选；使用 --redo 可重新处理':'未发现赛事；请检查搜索服务或稍后重试'});if(!ids.length)process.exitCode=1;return;}
 const results=await workQueue(cfg,store,opts);print({discovered:ids.length,enqueued:added,processed:results});if(results.some(x=>x.error))process.exitCode=1;
 }finally{store.close();}
});
program.parseAsync().catch(e=>{console.error(`错误：${e instanceof Error?e.message:String(e)}`);process.exitCode=1;});
