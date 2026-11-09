import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/core/store.js';
import { Brief } from '../dist/core/types.js';
import { runOrchestration } from '../dist/workflows/orchestrator.js';
import { browserAvailability } from '../dist/artifacts/browser-checks.js';
import { loadJobView } from '../dist/core/job-view.js';

const suite={cases:[{name:'点击计数',criterion:0,steps:[{action:'click',selector:'#add'}],expect:[{selector:'#count',text:'1'}]}]};
const plan={tasks:[{id:'counter',deliverable:0,title:'计数器',kind:'software',format:'html',instructions:'离线计数器，点击加一',acceptance:['点击一次按钮后计数从0变成1']}],packages:[],notes:[]};
const html=value=>`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>计数器</title><body><button id="add">加一</button><output id="count">0</output><script>document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent='${value}'</script></body>`;
async function setup(){const dir=await mkdtemp(join(tmpdir(),'browser-orch-'));const store=new Store(dir);const id=store.addCompetition('https://example.org/software','软件赛');store.setBrief(id,Brief.parse({title:'软件赛',deliverables:[{type:'网页软件',formats:['html']}],requires_idea:false}));const job=store.createJob(id,'automatic',{},40);return {dir,store,id,job,cfg:{dataDir:dir,execution:{productionRounds:2}}};}

test('实际浏览器失败驱动第二轮修复，沿用首轮用例并保留每轮截图',{skip:!browserAvailability().available},async()=>{
 const c=await setup();let builds=0,suites=0,reviews=0;
 try{
  const gateway={search:async()=>[],generate:async(_role,prompt)=>{
   if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify(plan);
   if(prompt.includes('为实际网页交付物设计浏览器验收用例')){suites++;return JSON.stringify(suite);}
   if(prompt.includes('任务：作品验收')){reviews++;return JSON.stringify({pass:true,issues:[]});}throw Error('unexpected');
  },buildProject:async(folder,prompt)=>{builds++;if(builds===2)assert.match(prompt,/浏览器实测/);await writeFile(join(folder,'index.html'),html(builds===1?'2':'1'));}};
  const result=await runOrchestration(c.cfg,c.store,gateway,{jobId:c.job,competitionId:c.id,idea:null});
  assert.equal(builds,2);assert.equal(suites,1);assert.equal(reviews,1);
  const delivery=result.deliverables[0];assert.equal(delivery.rounds,2);assert.equal(delivery.checks.find(x=>x.id==='interaction').status,'passed');assert.equal(delivery.status,'draft');
  const view=await loadJobView(c.dir,c.job);assert.deepEqual(view.rounds.map(r=>r.browser.status),['failed','passed']);assert.ok(view.rounds.every(r=>r.browser.screenshots.length>=2));
  const before=builds;await runOrchestration(c.cfg,c.store,gateway,{jobId:c.job,competitionId:c.id,idea:null});assert.equal(builds,before);
 }finally{c.store.close();await rm(c.dir,{recursive:true,force:true});}
});

test('软件制作后暂停保存归档，恢复只继续浏览器与内容验收',{skip:!browserAvailability().available},async()=>{
 const c=await setup();let builds=0;
 try{
  const gateway={search:async()=>[],generate:async(_role,prompt)=>{
   if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify(plan);
   if(prompt.includes('为实际网页交付物设计浏览器验收用例'))return JSON.stringify(suite);
   if(prompt.includes('任务：作品验收'))return JSON.stringify({pass:true,issues:[]});throw Error('unexpected');
  },buildProject:async(folder)=>{builds++;await writeFile(join(folder,'index.html'),html('1'));c.store.requestJobControl(c.job,'pause');}};
  await assert.rejects(runOrchestration(c.cfg,c.store,gateway,{jobId:c.job,competitionId:c.id,idea:null}),/暂停/);
  const folder=join(c.dir,'jobs',c.job),state=(await readdir(folder)).find(n=>n.endsWith('-r1-state.json'));assert.ok(state);const saved=JSON.parse(await readFile(join(folder,state),'utf8'));assert.match(await readFile(saved.attempt.paths[0],'utf8'),/计数器/);
  c.store.resumeJob(c.job);const result=await runOrchestration(c.cfg,c.store,gateway,{jobId:c.job,competitionId:c.id,idea:null});assert.equal(builds,1);assert.equal(result.deliverables[0].checks.find(c=>c.id==='interaction').status,'passed');
 }finally{c.store.close();await rm(c.dir,{recursive:true,force:true});}
});
