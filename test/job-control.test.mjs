import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/core/store.js';
import { Brief } from '../dist/core/types.js';
import { beginJobRun } from '../dist/core/job-control.js';
import { runJob } from '../dist/workflows/workflow.js';
import { processQueue } from '../dist/competition/queue.js';

test('跨进程控制请求：调用完成后保存结果，暂停后恢复不重复写作',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'job-control-')),store=new Store(dir),other=new Store(dir);
 try{
  const id=store.addCompetition('https://example.org/translation','翻译赛');store.setBrief(id,Brief.parse({title:'翻译',deliverables:[{type:'翻译',formats:['txt']}],requires_idea:false}));
  const source=join(dir,'source.txt');await writeFile(source,'Hello');const job=store.createJob(id,'translation',{sourcePath:source,targetLanguage:'中文',format:'txt'},10);
  const cfg={dataDir:dir};let calls=0;
  const gateway={search:async()=>[],generate:async()=>{calls++;assert.equal(other.requestJobControl(job,'pause').pending,true);assert.throws(()=>other.resumeJob(job),/仍在执行/);return '你好';}};
  await assert.rejects(runJob(cfg,store,gateway,job),/暂停/);assert.equal(store.job(job).state,'paused');assert.equal(await readFile(join(dir,'jobs',job,'submission.txt'),'utf8'),'你好');
  assert.deepEqual(other.resumeJob(job),{queued:false,resume:true});
  const result=await runJob(cfg,store,gateway,job,true);assert.equal(calls,1);assert.equal(store.job(job).state,'completed');assert.equal(await readFile(result.outputPath,'utf8'),'你好');
  assert.throws(()=>other.requestJobControl(job,'pause'),/已完成/);
 }finally{other.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('暂停与停止的队列任务不会被普通 retry 领取，继续仍经过队列审核',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'queue-control-')),store=new Store(dir);
 try{
  const id=store.addCompetition('https://example.org/task','赛事');store.enqueue(id);store.setQueueReview(id,{decision:'valid',reason:'人工确认',reviewer:'manual'});let job;
  await processQueue(store,{limit:1,budget:10,run:async t=>{job=t.jobId;store.setJob(job,'running');assert.equal(store.requestJobControl(job,'pause').pending,true);throw Error('安全边界');}});
  assert.equal(store.job(job).state,'paused');assert.equal(store.queue()[0].state,'paused');assert.equal(store.retryQueue(),0);
  assert.equal((await processQueue(store,{limit:1,budget:10,run:async()=>assert.fail('不应执行')})).length,0);
  assert.deepEqual(store.resumeJob(job),{queued:true,resume:true});
  await processQueue(store,{limit:1,budget:10,run:async t=>{assert.equal(t.jobId,job);store.setJob(job,'running');store.requestJobControl(job,'stop');throw Error('安全边界');}});
  assert.equal(store.job(job).state,'stopped');assert.equal(store.queue()[0].state,'stopped');assert.throws(()=>store.resumeJob(job),/已停止/);assert.equal(store.retryQueue(),0);assert.equal(store.enqueue(id,true),true);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('任务租约防止重复恢复，预算保持已用量且不能降低到已用量以下',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'job-lease-')),store=new Store(dir),other=new Store(dir);
 try{
  const id=store.addCompetition('https://example.org/task','赛事'),job=store.createJob(id,'research',{},10);store.reserveCalls(job,3);other.setBudget(job,8);assert.equal(store.job(job).calls,3);assert.throws(()=>other.setBudget(job,2),/已消耗量/);
  const release=beginJobRun(store,job);try{assert.throws(()=>beginJobRun(other,job),/已有执行进程/);assert.throws(()=>other.resumeJob(job),/仍在执行/);}finally{release();}
  assert.equal(other.requestJobControl(job,'pause').state,'paused');assert.throws(()=>beginJobRun(store,job),/暂停/);
 }finally{other.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('尚未开始的任务暂停后仍能从初始输入开始，过期租约不能覆盖新执行者',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'job-start-control-')),store=new Store(dir);
 try{
  const id=store.addCompetition('https://example.org/start','翻译');store.setBrief(id,Brief.parse({title:'翻译',deliverables:[{type:'翻译',formats:['txt']}]}));
  const source=join(dir,'source.txt');await writeFile(source,'Hello');const job=store.createJob(id,'translation',{sourcePath:source,targetLanguage:'中文',format:'txt'},10);
  store.requestJobControl(job,'pause');assert.deepEqual(store.resumeJob(job),{queued:false,resume:false});
  const release=beginJobRun(store,job);store.db.prepare("UPDATE job_runs SET expires_at='2000-01-01' WHERE job_id=?").run(job);
  const next=beginJobRun(store,job);try{assert.throws(()=>release.assert(),/租约已失效/);release();assert.doesNotThrow(()=>next.assert());}finally{next();}
  let calls=0;const result=await runJob({dataDir:dir},store,{search:async()=>[],generate:async()=>{calls++;return '你好';}},job,false);assert.equal(calls,1);assert.equal(await readFile(result.outputPath,'utf8'),'你好');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
