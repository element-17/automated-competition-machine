import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../dist/core/store.js';
import { runJob } from '../dist/workflows/workflow.js';
import { Brief } from '../dist/core/types.js';
import { loadConfig } from '../dist/core/config.js';
import { readSource } from '../dist/competition/sources.js';

const baseBrief={title:'测试翻译竞赛',edition:'2026',eligibility:null,deadline:null,ai_rules:null,scoring:null,deliverables:[{type:'translation',quantity:null,formats:['txt'],limits:[],naming:null,attachments:[],submission:null,official_template:null}],requires_idea:false,missing:[]};
async function setup(){const dir=await mkdtemp(join(tmpdir(),'compete-')); return {dir,store:new Store(dir),cfg:{dataDir:dir,opencodeUrl:'http://127.0.0.1:4096',writer:{providerID:'google',id:'gemini-test'},reviewer:{providerID:'anthropic',id:'claude-test'},maxCalls:10,searchProvider:'tinyfish',sources:[],profile:{}}};}

test('翻译作品只调用写作 Agent 生成并导出，不调用审核 Agent 审稿',async()=>{
 const {dir,store,cfg}=await setup(); try{const id=store.addCompetition('https://example.org/rules','翻译赛'); store.setBrief(id,Brief.parse(baseBrief)); const source=join(dir,'original.txt'); await writeFile(source,'Hello, world!');
 const job=store.createJob(id,'translation',{sourcePath:source,targetLanguage:'中文',format:'txt'},10); const calls=[];
 const gateway={search:async()=>[],generate:async(role)=>{calls.push(role);return '你好，世界！';}};
 const result=await runJob(cfg,store,gateway,job); assert.deepEqual(calls,['writer']); assert.equal(await readFile(result.outputPath,'utf8'),'你好，世界！'); assert.equal(store.job(job).state,'completed'); assert.deepEqual(store.artifacts(job).filter(x=>x.kind==='draft'||x.kind==='final_text').map(x=>x.model),['google/gemini-test','google/gemini-test']);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('翻译流程不调用审核 Agent，审核服务不可用也不影响作品导出',async()=>{
 const {dir,store,cfg}=await setup(); try{const id=store.addCompetition('https://example.org/resume','翻译赛');store.setBrief(id,Brief.parse(baseBrief)); const source=join(dir,'source.txt'); await writeFile(source,'Hello'); const job=store.createJob(id,'translation',{sourcePath:source,targetLanguage:'中文',format:'txt'},10);
 let writer=0,reviewer=0; const g={search:async()=>[],generate:async(role)=>{if(role==='reviewer'){reviewer++;throw Error('审核服务不可用');}writer++;return '最终译文';}};
 const r=await runJob(cfg,store,g,job);assert.equal(await readFile(r.outputPath,'utf8'),'最终译文');assert.equal(await readFile(join(dir,'jobs',job,'source.txt'),'utf8'),'Hello');assert.equal(writer,1);assert.equal(reviewer,0);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('缺失原文、格式不匹配和官方模板要求会阻止调用模型',async()=>{
 const {dir,store,cfg}=await setup(); try{const id=store.addCompetition('https://example.org/guard','翻译赛'); let calls=0;const g={search:async()=>[],generate:async()=>{calls++;return ''}};
 store.setBrief(id,Brief.parse(baseBrief));const missing=store.createJob(id,'translation',{sourcePath:'',targetLanguage:'中文',format:'txt'},10);await assert.rejects(runJob(cfg,store,g,missing),/缺少原文/);
 const source=join(dir,'a.txt');await writeFile(source,'a');const wrong=store.createJob(id,'translation',{sourcePath:source,targetLanguage:'中文',format:'docx'},10);await assert.rejects(runJob(cfg,store,g,wrong),/不一致/);
 store.setBrief(id,Brief.parse({...baseBrief,deliverables:[{...baseBrief.deliverables[0],official_template:'官方模板.docx'}]}));const template=store.createJob(id,'translation',{sourcePath:source,targetLanguage:'中文',format:'txt'},10);await assert.rejects(runJob(cfg,store,g,template),/官方模板/);assert.equal(calls,0);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('研究流程保存实际来源、查询与结构化规则',async()=>{
 const {dir,store,cfg}=await setup(); const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end('<title>测试翻译竞赛</title><h1>2026 翻译竞赛</h1><p>交付一份 txt 译文。</p>');}); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url=`http://127.0.0.1:${server.address().port}/rules`;const id=store.addCompetition(url,'测试翻译竞赛');const job=store.createJob(id,'research',{},10);const calls=[];const g={search:async()=>[],generate:async(role,prompt)=>{calls.push(role);return prompt.includes('提出最多三个具体的后续搜索词')?(calls.length===1?'["测试翻译竞赛 获奖作品"]':'[]'):prompt.includes('读取来源并只输出一个 JSON 对象')?JSON.stringify(baseBrief):`研究报告\n来源：${url}`;}};
 const result=await runJob(cfg,store,g,job);assert.deepEqual(calls,['writer','writer','writer','writer']);assert.equal(store.competition(id).brief.deliverables[0].type,'translation');assert.equal(store.evidence(id)[0].url,url);assert.equal(store.searches(id).length,4);assert.match(await readFile(result.outputPath,'utf8'),/来源/);
 }finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('附件下载失败不阻断研究报告；失败来源会记录',async()=>{
 const {dir,store,cfg}=await setup(); const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');if(req.url==='/rules'){res.end('<title>赛事通知</title><a href="/missing.pdf">附件下载</a><p>提交报告。</p>');}else{res.statusCode=404;res.end('missing');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url=`http://127.0.0.1:${server.address().port}/rules`;const id=store.addCompetition(url,'赛事通知');const job=store.createJob(id,'research',{},20);const g={search:async()=>[],generate:async(role,prompt)=>prompt.includes('读取来源并只输出一个 JSON 对象')?JSON.stringify(baseBrief):prompt.includes('提出最多三个具体的后续搜索词')?'[]':'研究报告'};const result=await runJob(cfg,store,g,job);assert.equal(store.job(job).state,'completed');assert.match(await readFile(result.outputPath,'utf8'),/研究报告/);assert.ok(store.sourceAttempts(id).some(x=>x.url.endsWith('/missing.pdf')));}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}
});
test('预算计数持久化并拒绝超额；非 Gemini 写作配置被拒绝',async()=>{const {dir,store}=await setup();try{const id=store.addCompetition('https://example.org/budget','赛');const job=store.createJob(id,'research',{},1);store.consumeCall(job);assert.throws(()=>store.consumeCall(job),/上限/);assert.equal(store.job(job).calls,1);const cfg=join(dir,'bad.json');await writeFile(cfg,JSON.stringify({dataDir:dir,writer:{providerID:'anthropic',id:'x'},reviewer:{providerID:'other',id:'y'}}));assert.throws(()=>loadConfig(cfg));}finally{store.close();await rm(dir,{recursive:true,force:true});}});
test('文档类比赛使用 Gemini 撰稿与修订，不强加固定版式',async()=>{
 const {dir,store,cfg}=await setup();try{const id=store.addCompetition('https://example.org/report','方案比赛');store.setBrief(id,Brief.parse({...baseBrief,deliverables:[{...baseBrief.deliverables[0],type:'报告',formats:['md']}],requires_idea:true}));const source=join(dir,'source.txt');await writeFile(source,'社区已有调研材料');const job=store.createJob(id,'report',{sourcePath:source,instructions:'提出服务方案',format:'md'},10);const calls=[];const g={search:async()=>[],generate:async(role,prompt)=>{calls.push({role,prompt});return '方案终稿';}};const r=await runJob(cfg,store,g,job);assert.equal(await readFile(r.outputPath,'utf8'),'方案终稿');assert.deepEqual(calls.map(x=>x.role),['writer']);assert.match(calls[0].prompt,/不使用预设模板/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('DOCX 导出能被再次读取且正文一致',async()=>{const {dir,store,cfg}=await setup();try{const id=store.addCompetition('https://example.org/docx','翻译赛');store.setBrief(id,Brief.parse({...baseBrief,deliverables:[{...baseBrief.deliverables[0],formats:['docx']}]}));const path=join(dir,'text.txt');await writeFile(path,'input');const job=store.createJob(id,'translation',{sourcePath:path,targetLanguage:'中文',format:'docx'},10);const g={search:async()=>[],generate:async()=>'第一段\n第二段'};const r=await runJob(cfg,store,g,job);assert.match(await readSource(r.outputPath),/第一段[\s\S]*第二段/);}finally{store.close();await rm(dir,{recursive:true,force:true});}});
