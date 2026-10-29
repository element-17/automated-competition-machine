import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { processQueue } from '../dist/queue.js';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const approve=(store,id)=>store.setQueueReview(id,{decision:'valid',reason:'测试中人工确认',reviewer:'manual'});

test('队列跨重启持久化，按入队顺序逐个处理且去重',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'competition-queue-'));let store=new Store(dir);
  try{const ids=[1,2,3].map(i=>store.addCompetition(`https://example.com/${i}`,`赛事${i}`));for(const id of ids){assert.equal(store.enqueue(id),true);approve(store,id);}assert.equal(store.enqueue(ids[0]),false);store.close();store=new Store(dir);
    let running=0,max=0;const seen=[];const run=async task=>{running++;max=Math.max(max,running);seen.push(task.competitionId);await new Promise(r=>setTimeout(r,10));store.setJob(task.jobId,'completed');running--;return {ok:true};};
    const first=await processQueue(store,{limit:2,budget:10,run});assert.equal(first.length,2);assert.deepEqual(seen,ids.slice(0,2));assert.equal(max,1);assert.deepEqual(store.queue().map(x=>x.state),['completed','completed','queued']);
    store.close();store=new Store(dir);await processQueue(store,{limit:2,budget:10,run});assert.deepEqual(seen,ids);assert.ok(store.queue().every(x=>x.state==='completed'));
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('失败项保留任务并显式重试，后续赛事仍可处理',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'competition-queue-'));const store=new Store(dir);
  try{const a=store.addCompetition('https://example.com/a','a'),b=store.addCompetition('https://example.com/b','b');store.enqueue(a);store.enqueue(b);approve(store,a);approve(store,b);const result=await processQueue(store,{limit:2,budget:10,run:async t=>{if(t.competitionId===a){store.setJob(t.jobId,'failed','错误');throw Error('错误');}store.setJob(t.jobId,'completed');return {};}});assert.equal(result.length,2);const original=store.queue()[0].jobId;assert.equal(store.queue()[0].state,'failed');assert.equal(store.queue()[1].state,'completed');assert.equal(store.retryQueue(a),1);await processQueue(store,{limit:1,budget:20,run:async t=>{assert.equal(t.jobId,original);assert.equal(t.resume,true);assert.equal(store.job(t.jobId).maxCalls,20);store.setJob(t.jobId,'completed');return {};}});assert.equal(store.queue()[0].state,'completed');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('工作进程互斥，崩溃后租约到期恢复原任务',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'competition-queue-'));let store=new Store(dir);
  try{const id=store.addCompetition('https://example.com/a','赛事');store.enqueue(id);approve(store,id);store.acquireWorker('dead',30);const task=store.claimQueue('dead',10);store.setJob(task.jobId,'running');assert.throws(()=>store.acquireWorker('other',1000),/已有队列处理进程/);store.close();await new Promise(r=>setTimeout(r,50));store=new Store(dir);let resumed;await processQueue(store,{limit:1,budget:10,run:async t=>{resumed=t;store.setJob(t.jobId,'completed');return {};}});assert.equal(resumed.jobId,task.jobId);assert.equal(resumed.resume,true);assert.equal(store.queue()[0].state,'completed');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('已完成任务不会重复入队，redo 显式创建新任务',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'competition-queue-'));const store=new Store(dir);
  try{const id=store.addCompetition('https://example.com/a','赛事');store.enqueue(id);approve(store,id);const first=await processQueue(store,{limit:1,budget:10,run:async t=>{store.setJob(t.jobId,'completed');return {};}});assert.equal(store.enqueue(id),false);assert.equal(store.enqueue(id,true),true);approve(store,id);await processQueue(store,{limit:1,budget:10,run:async t=>{assert.notEqual(t.jobId,first[0].jobId);assert.equal(t.resume,false);store.setJob(t.jobId,'completed');return {};}});
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('CLI 扫描后立即持久入队，模型不可用时队列保留',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'competition-queue-cli-'));const server=createServer((req,res)=>{if(req.url==='/contest'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<title>大学生作品大赛通知</title><p>作品征集</p>');return;}res.setHeader('content-type','application/json');if(req.url==='/api/info')res.end(JSON.stringify({version:'2.2.0'}));else if(req.url?.startsWith('/api/model'))res.end(JSON.stringify({location:{},data:[]}));else{res.statusCode=404;res.end('{}');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const url=`http://127.0.0.1:${server.address().port}`,env={...process.env,COMPETE_DATA_DIR:dir,COMPETE_CONFIG:join(dir,'missing.json')};delete env.ANTHROPIC_API_KEY;delete env.GEMINI_API_KEY;delete env.GOOGLE_API_KEY;delete env.GOOGLE_GENERATIVE_AI_API_KEY;const run=promisify(execFile);const invoke=args=>run(process.execPath,['dist/cli.js',...args],{cwd:process.cwd(),env,timeout:20000});const scan=await invoke(['scan','--url',`${url}/contest`]);assert.equal(JSON.parse(scan.stdout).enqueued,true);assert.equal(JSON.parse((await invoke(['queue'])).stdout)[0].state,'queued');await assert.rejects(invoke(['work','--limit','1']),/模型不可用/);assert.equal(JSON.parse((await invoke(['queue'])).stdout)[0].state,'queued');
  }finally{server.close();await rm(dir,{recursive:true,force:true});}
});
