import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJobView, jobViewSummary } from '../dist/core/job-view.js';
import { saveJobProgress } from '../dist/core/job-progress.js';

test('任务界面读取完整验收、证据和进度，并区分草稿与投稿候选',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'job-view-'));const folder=join(dir,'jobs','test-job');await mkdir(folder,{recursive:true});
  try{
    const write=(name,value)=>writeFile(join(folder,name),JSON.stringify(value));
    await write('deliverables.json',{deliverables:[{id:'doc',type:'报告',status:'draft',rounds:3,artifactPaths:['report.docx'],gaps:['未确认作者'],checks:[{id:'naming',status:'unverified',details:['未确认作者']}]}]});
    await write('requirements.json',[{deliverable:0,type:'报告',checks:[{id:'size',status:'passed',actual:512,unit:'KB',details:[]}]}]);
    await write('candidate-evidence.json',[{candidate:1,title:'方案',query:'作品',searchStatus:'empty',sources:[],gaps:['原创性未核实']}]);
    await write('resume-checks.json',[{id:'doc',reused:true}]);
    await saveJobProgress(dir,'test-job',{stage:'review',action:'评审第三轮',round:3,maxRounds:4,budget:{used:20,limit:80}});
    const view=await loadJobView(dir,'test-job');assert.equal(view.manifest,'final');assert.equal(view.counts.draft,1);assert.equal(view.counts.submission,0);assert.equal(view.progress.round,3);assert.equal(view.requirements[0].checks[0].actual,512);assert.match(jobViewSummary(view).join(' '),/流程结束不等于作品符合/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('任务中断时展示已保存轮次，损坏清单给出警告且不冒充完成',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'job-view-partial-'));const folder=join(dir,'jobs','job');await mkdir(folder,{recursive:true});
  try{
    await writeFile(join(folder,'deliverables.json'),'{broken');
    await writeFile(join(folder,'orchestration.json'),JSON.stringify({first:{type:'初稿',status:'draft',artifactPaths:['draft.txt']}}));
    await writeFile(join(folder,`task-next-${'a'.repeat(20)}-r2-state.json`),JSON.stringify({attempt:{paths:['r2/report.txt']}}));
    const view=await loadJobView(dir,'job');assert.equal(view.manifest,'partial');assert.equal(view.warnings.length,1);assert.equal(view.counts.submission,0);assert.equal(view.rounds[0].round,2);assert.equal(view.rounds[0].review,'pending');
    await assert.rejects(loadJobView(dir,'../outside'),/ID 格式/);
    assert.equal((await loadJobView(dir,'missing')).manifest,'missing');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('并发进度写入保留完整 JSON 和有序事件日志',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'job-progress-'));try{
    await Promise.all([1,2,3].map(round=>saveJobProgress(dir,'job',{stage:'production',action:'制作',round,maxRounds:3})));
    assert.equal(JSON.parse(await readFile(join(dir,'jobs','job','runtime-progress.json'),'utf8')).round,3);
    const events=(await readFile(join(dir,'jobs','job','progress.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.deepEqual(events.map(e=>e.round),[1,2,3]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
