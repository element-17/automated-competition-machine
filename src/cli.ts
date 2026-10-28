#!/usr/bin/env node
import { Command } from 'commander';
import { OpenCode } from '@opencode/client';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { OpenCodeGateway, authHeaders } from './opencode.js';
import { fetchDocument, normalizeUrl, searchLogged } from './sources.js';
import { runJob } from './workflow.js';

const program=new Command();
program.name('compete').description('高校竞赛发现、研究和作品制作 CLI').version('0.1.0').option('-c, --config <path>','配置文件路径');
function context(){const cfg=loadConfig(program.opts().config); const store=new Store(cfg.dataDir); return {cfg,store,gateway:new OpenCodeGateway(cfg,store)};}
function print(x:unknown){console.log(JSON.stringify(x,null,2));}
program.command('doctor').description('检查配置、OpenCode 和模型可用性').action(async()=>{
  const {cfg,store}=context(); const client=OpenCode.make({baseUrl:cfg.opencodeUrl,headers:authHeaders()});
  const report:Record<string,unknown>={dataDir:cfg.dataDir,opencode:cfg.opencodeUrl,writer:cfg.writer,reviewer:cfg.reviewer,server:'不可连接',models:'未检查',note:'仅检查模型目录，不验证凭据有效性或配额；不会输出密钥'};
  try {await client.server.info({signal:AbortSignal.timeout(5000)}); report.server='已连接'; const models=await client.model.list(undefined,{signal:AbortSignal.timeout(10000)}); const availability={writer:models.data.some(x=>x.id===cfg.writer.id && x.providerID===cfg.writer.providerID),reviewer:models.data.some(x=>x.id===cfg.reviewer.id && x.providerID===cfg.reviewer.providerID)}; report.models=availability; if(!availability.writer||!availability.reviewer) process.exitCode=1;}catch(e){report.error=e instanceof Error?e.message:String(e); process.exitCode=1;} finally{store.close();} print(report);
});
program.command('scan').description('发现或导入公开赛事公告').option('-q, --query <query>','搜索关键词').option('-u, --url <url>','导入赛事公告 URL').action(async(opts)=>{
  const {cfg,store,gateway}=context(); try{
    if(opts.url){const d=await fetchDocument(opts.url); print({id:store.addCompetition(normalizeUrl(opts.url),d.title),title:d.title,url:normalizeUrl(opts.url)}); return;}
    const year=new Date().getFullYear(); const queries=opts.query?[opts.query]:[`${year} 大学生 竞赛 征集作品 通知`,`${year} 高校 翻译大赛 征稿 通知`,`${year} 大学生 创新设计大赛 征集作品 通知`]; const found=[];
    for(const q of queries){ const rs=await searchLogged(store,gateway,null,q); for(const r of rs){try{const url=normalizeUrl(r.url); found.push({id:store.addCompetition(url,r.title),title:r.title,url,query:q});}catch{}} }
    for(const url of cfg.sources){try{const page=await fetchDocument(url); for(const x of page.links.filter(x=>/竞赛|大赛|征集|报名|作品/.test(x.title)).slice(0,20)){found.push({id:store.addCompetition(x.url,x.title),title:x.title,url:x.url,query:`来源:${url}`});}}catch(e){console.error(`来源读取失败 ${url}: ${e instanceof Error?e.message:String(e)}`);}}
    print(found); if(!found.length){console.error('没有找到结果；检查 OpenCode 搜索服务，或使用 scan --url 导入官方公告。');process.exitCode=1;}
  }finally{store.close();}
});
program.command('list').description('列出已发现赛事').action(()=>{const {store}=context();try{print(store.list());}finally{store.close();}});
program.command('show').description('查看赛事、规则、证据及检索日志').argument('<competition-id>').action((id)=>{const {store}=context();try{print({competition:store.competition(id),evidence:store.evidence(id).map(({text,...x})=>({...x,excerpt:text.slice(0,500)})),searches:store.searches(id)});}finally{store.close();}});
program.command('research').description('研究赛事规则与往届公开作品').argument('<competition-id>').option('--budget <calls>','最多模型调用次数',Number).action(async(id,opts)=>{
  const {cfg,store}=context();try{store.competition(id); const job=store.createJob(id,'research',{},opts.budget??cfg.maxCalls); console.log(`任务 ID: ${job}`); const result=await runJob(cfg,store,new OpenCodeGateway(cfg,store,job),job); print({jobId:job,outputPath:result.outputPath});}finally{store.close();}
});
program.command('produce').description('制作翻译或报告作品').argument('<competition-id>').option('--type <type>','作品类型：translation、report；唯一可识别时自动选择').requiredOption('--source <path>','原文或材料文件路径').option('--target <language>','翻译目标语言').option('--instructions <text>','报告撰写要求').requiredOption('--format <format>','输出格式：txt、md、docx').option('--budget <calls>','最多模型调用次数',Number).action(async(id,opts)=>{
  const {cfg,store}=context();try{const c=store.competition(id);if(!c.brief) throw Error('请先执行 research，核对比赛交付要求');const types=new Set<string>();for(const d of c.brief.deliverables){if(/translation|翻译|译文|译稿/i.test(d.type))types.add('translation');if(/report|document|proposal|报告|文档|文稿|方案书|申报书/i.test(d.type))types.add('report');}const type=opts.type||(types.size===1?[...types][0]:null);if(!type)throw Error('无法唯一确定已支持的交付类型，请使用 --type 指定；不支持的类型请人工处理');if(!['translation','report'].includes(type))throw Error(`暂不支持作品类型：${type}；赛事档案已保留`); const job=store.createJob(id,type,{sourcePath:opts.source,targetLanguage:opts.target||'',instructions:opts.instructions||'',format:opts.format.toLowerCase()},opts.budget??cfg.maxCalls); console.log(`任务 ID: ${job}`); const result=await runJob(cfg,store,new OpenCodeGateway(cfg,store,job),job); print({jobId:job,outputPath:result.outputPath});}finally{store.close();}
});
program.command('status').description('查看任务及已保存产物').argument('<job-id>').action(id=>{const {store}=context();try{print({job:store.job(id),artifacts:store.artifacts(id)});}finally{store.close();}});
program.command('resume').description('从持久检查点恢复失败任务').argument('<job-id>').option('--budget <calls>','调整总模型调用次数上限',Number).action(async(id,opts)=>{
  const {cfg,store}=context();try{if(opts.budget!==undefined)store.setBudget(id,opts.budget); const result=await runJob(cfg,store,new OpenCodeGateway(cfg,store,id),id,true); print({jobId:id,outputPath:result.outputPath});}finally{store.close();}
});
program.parseAsync().catch(e=>{console.error(`错误：${e instanceof Error?e.message:String(e)}`);process.exitCode=1;});
