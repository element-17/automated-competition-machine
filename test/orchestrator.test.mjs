import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { Store } from '../dist/core/store.js';
import { runOrchestration, planProblems, fallbackPlan, Plan } from '../dist/workflows/orchestrator.js';
import { renderWork, Work } from '../dist/artifacts/artifacts.js';
import { readSource } from '../dist/competition/sources.js';

const item=(type,formats=[])=>({type,formats,quantity:null,limits:[],naming:null,attachments:[],submission:null,official_template:null});
const brief=deliverables=>({title:'华灿奖',edition:'2026',eligibility:null,deadline:null,ai_rules:null,scoring:null,deliverables,requires_idea:true,missing:[],citations:[],research:{past_winners:[],past_works:[],judging:[],missing:[]}});
const idea={title:'识物助盲',audience:'视障人士',problem:'识别日常物品',mechanism:'离线图像识别',verification:'识别率测试',evidence_urls:[]};
async function setup(b){const dir=await mkdtemp(join(tmpdir(),'orch-'));const store=new Store(dir);const cfg={dataDir:dir,execution:{productionRounds:2,plannerRounds:2},writer:{providerID:'google',id:'gemini-test'},reviewer:{providerID:'anthropic',id:'claude-test'},maxCalls:40,sources:[],profile:{}};const id=store.addCompetition('https://example.edu.cn/contest','华灿奖');store.setBrief(id,b);const job=store.createJob(id,'automatic',{},40);return {dir,store,cfg,id,job,done:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};}
const bundlePlan={tasks:[
  {id:'app',deliverable:0,title:'识物助盲软件',kind:'software',format:'zip',instructions:'离线识别页面',acceptance:['有识别功能']},
  {id:'doc',deliverable:0,title:'作品说明书',kind:'document',format:'docx',instructions:'说明设计与实现',acceptance:['含设计思路']},
  {id:'pledge',deliverable:0,title:'作品原创承诺书',kind:'document',format:'docx',instructions:'签名处留空',acceptance:['签名留空']}],
 packages:[{name:'软件赛道_识物助盲_作者.zip',deliverable:0,includes:['app','doc','pledge']}],notes:[]};

test('规划 Agent 把压缩包交付物拆成软件和文档并打包；评审不通过的文档带意见返工',async()=>{
  const ctx=await setup(brief([item('参赛作品压缩包（含作品文件、《作品原创承诺书》）',['zip'])]));
  try{
    const calls=[];let docReviews=0,built=0;
    const g={search:async()=>[],
      buildProject:async(ws,prompt)=>{built++;assert.match(prompt,/离线识别页面/);await writeFile(join(ws,'index.html'),'<html><body><h1>识物助盲</h1><script src="app.js"></script></body></html>');await writeFile(join(ws,'app.js'),'console.log(1)');await writeFile(join(ws,'README.md'),'# 识物助盲');},
      generate:async(role,prompt,agent=role)=>{calls.push({role,agent,prompt});
        if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify(bundlePlan);
        if(prompt.includes('独立作品验收评审')){if(prompt.includes('任务：作品说明书')){docReviews++;return JSON.stringify(docReviews===1?{pass:false,issues:['缺少设计思路章节']}:{pass:true,issues:[]});}return JSON.stringify({pass:true,issues:[]});}
        if(prompt.includes('请针对这项比赛的指定交付物直接创作')){const fixed=prompt.includes('缺少设计思路章节');return JSON.stringify({kind:'text',title:prompt.includes('任务：作品原创承诺书')?'作品原创承诺书':'作品说明书',text:fixed?'## 设计思路\n离线识别。':'## 简介\n作品简介。',sources:[]});}
        throw Error('unexpected '+prompt.slice(0,60));}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.ok(calls.some(c=>c.agent==='planner'),'规划由 planner Agent 完成');
    assert.ok(calls.filter(c=>c.prompt.includes('独立作品验收评审')).every(c=>c.agent==='reviewer'));
    assert.equal(built,1);assert.equal(docReviews,2);
    const doc=result.deliverables.find(d=>d.id==='doc');assert.equal(doc.status,'submission');assert.equal(doc.rounds,2);
    const zipPath=result.outputs.find(x=>x.endsWith('.zip'));assert.match(zipPath,/软件赛道_识物助盲_作者\.zip$/);
    const names=Object.keys((await JSZip.loadAsync(await readFile(zipPath))).files);
    assert.ok(names.includes('识物助盲软件/index.html'));assert.ok(names.includes('作品说明书.docx'));assert.ok(names.includes('作品原创承诺书.docx'));
    assert.ok(!result.outputs.some(x=>x.endsWith('.md')),'不再降级为 Markdown');
    assert.match(await readSource(doc.artifactPaths[0]),/设计思路/);
    assert.equal(result.deliverables.find(d=>d.id==='app').status,'draft','未运行交互测试的软件不能升级为投稿件');
    assert.equal(result.deliverables.at(-1).status,'draft','打包不会抹去子产物的验收缺口');
  }finally{await ctx.done();}
});

test('计划引用错误格式时带问题重试一次，仍无效则用确定性计划',async()=>{
  const ctx=await setup(brief([item('方案报告',['docx'])]));
  try{const prompts=[];const bad={tasks:[{id:'a',deliverable:0,title:'报告',kind:'slides',format:'docx',instructions:'x',acceptance:['y']}]};
    const g={search:async()=>[],generate:async(role,prompt)=>{if(prompt.includes('拆解成可以实际制作的文件任务')){prompts.push(prompt);return JSON.stringify(bad);}if(prompt.includes('独立作品验收评审'))return JSON.stringify({pass:true,issues:[]});if(prompt.includes('直接创作'))return JSON.stringify({kind:'text',title:'报告',text:'正文',sources:[]});throw Error('unexpected');}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(prompts.length,2);assert.match(prompts[1],/slides 只能制作 pptx/);
    assert.ok(result.outputs.some(x=>x.endsWith('.docx')));assert.match(result.gaps.join(' '),/已按格式规则生成计划/);
  }finally{await ctx.done();}
});

test('两轮仍未通过验收的作品保留为草稿，不标记为投稿件',async()=>{
  const ctx=await setup(brief([item('方案报告',['docx'])]));
  try{let writes=0;const g={search:async()=>[],generate:async(role,prompt)=>{if(prompt.includes('拆解成可以实际制作的文件任务'))throw Error('规划不可用');if(prompt.includes('独立作品验收评审'))return JSON.stringify({pass:false,issues:['只有提纲']});if(prompt.includes('直接创作')){writes++;return JSON.stringify({kind:'text',title:'报告',text:'提纲',sources:[]});}throw Error('unexpected');}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(writes,2);const d=result.deliverables[0];assert.equal(d.status,'draft');assert.match(result.gaps.join(' '),/2 轮仍未通过验收：只有提纲/);
    assert.ok(!ctx.store.artifacts(ctx.job).some(a=>a.kind==='submission'));
  }finally{await ctx.done();}
});

test('计划校验：每个交付物需有任务，翻译需原文，打包引用必须存在',()=>{
  const b=brief([item('翻译作品',['docx']),item('演示',['pptx'])]);
  const plan=Plan.parse({tasks:[{id:'t',deliverable:0,title:'译文',kind:'translation',format:'DOCX',instructions:'x',acceptance:['y']}],packages:[{name:'p',deliverable:0,includes:['missing']}]});
  const problems=planProblems(plan,b,false).join('\n');
  assert.match(problems,/没有比赛指定的原文/);assert.match(problems,/不存在的任务 missing/);assert.match(problems,/交付物 1（演示）没有对应任务/);
  const fb=fallbackPlan(b,false);assert.equal(fb.tasks[0].kind,'supporting');assert.equal(fb.tasks[1].kind,'slides');
  assert.deepEqual(planProblems(fb,b,false),[]);
});

test('Word 导出把 Markdown 标题和加粗转为样式，不残留标记',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'docx-md-'));
  try{const out=await renderWork(Work.parse({kind:'text',title:'作品说明',text:'## 背景\n**重点**内容\n- 列表项',sources:[]}),'docx',dir);const text=await readSource(out);
    assert.match(text,/作品说明/);assert.match(text,/背景/);assert.match(text,/重点内容/);assert.doesNotMatch(text,/##|\*\*/);}
  finally{await rm(dir,{recursive:true,force:true});}
});

const documentTask=(overrides={})=>({id:'report',deliverable:0,title:'报告',kind:'document',format:'txt',instructions:'完整报告正文',acceptance:['内容完整'],...overrides});
function documentGateway(plan,{review={pass:true,issues:[]},reviewError=false}={}){
  const calls={plans:0,writes:0,reviews:0};
  return {calls,search:async()=>[],generate:async(role,prompt)=>{
    if(prompt.includes('拆解成可以实际制作的文件任务')){calls.plans++;return JSON.stringify(plan);}
    if(prompt.includes('独立作品验收评审')){calls.reviews++;if(reviewError)throw Error('评审服务离线');return JSON.stringify(review);}
    if(prompt.includes('直接创作')){calls.writes++;return JSON.stringify({kind:'text',title:'报告',text:prompt.includes('更新后的规则')?'依照新规则生成的正文':'经过实际生成的正文',sources:[]});}
    throw Error('unexpected prompt');
  }};
}

test('规划器不能用制作器支持的格式替代官方格式，也不能跨交付物打包',()=>{
  const b=brief([item('报告',['PDF']),item('软件包',['ZIP'])]);
  const wrong=Plan.parse({tasks:[documentTask({format:'docx'}),documentTask({id:'code',deliverable:1,kind:'software',format:'zip'})]});
  assert.match(planProblems(wrong,b,true).join(' '),/docx 不符合交付物指定格式 PDF/);
  const cross=Plan.parse({...wrong,packages:[{name:'all.zip',deliverable:1,includes:['report','code']}]});
  assert.match(planProblems(cross,b,true).join(' '),/其他交付物的任务 report/);
  const wrapper=Plan.parse({tasks:[documentTask({format:'pdf'})],packages:[{name:'report.zip',deliverable:0,includes:['report']}]});
  assert.match(planProblems(wrapper,brief([item('报告',['pdf'])]),true).join(' '),/ZIP 不符合交付物指定格式/);
});

test('错误官方格式触发规划修复与确定性回退，生成正确格式',async()=>{
  const ctx=await setup(brief([item('报告',['txt'])]));
  try{
    const g=documentGateway({tasks:[documentTask({format:'docx'})]});
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(g.calls.plans,2);assert.equal(result.deliverables[0].format,'txt');assert.equal(result.deliverables[0].status,'submission');
    assert.match(result.gaps.join(' '),/不符合交付物指定格式/);
  }finally{await ctx.done();}
});

test('评审离线和未知官方格式均保留真实产物为草稿',async()=>{
  for(const scenario of [{formats:['txt'],reviewError:true,check:'content'},{formats:[],reviewError:false,check:'format'}]){
    const ctx=await setup(brief([item('报告',scenario.formats)]));
    try{
      const g=documentGateway({tasks:[documentTask()]},{reviewError:scenario.reviewError});
      const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
      const d=result.deliverables[0];assert.equal(d.status,'draft');assert.equal(d.checks.find(c=>c.id===scenario.check).status,'unverified');
      assert.match(await readFile(d.artifactPaths[0],'utf8'),/经过实际生成/);
      assert.ok(!ctx.store.artifacts(ctx.job).some(a=>a.kind==='submission'));
    }finally{await ctx.done();}
  }
});

test('评审同时返回通过和问题时，仍须返工并保留草稿',async()=>{
  const ctx=await setup(brief([item('报告',['txt'])]));
  try{const g=documentGateway({tasks:[documentTask()]},{review:{pass:true,issues:['没有完整正文']}});
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(g.calls.writes,2);assert.equal(result.deliverables[0].status,'draft');assert.equal(result.deliverables[0].review.pass,false);
  }finally{await ctx.done();}
});

test('恢复核对产物：完整结果跳过，修改或丢失重新生成，规则变化不复用旧模型缓存',async()=>{
  const ctx=await setup(brief([item('报告',['txt'])]));
  try{
    const g=documentGateway({tasks:[documentTask()]});const input={jobId:ctx.job,competitionId:ctx.id,idea};
    const first=await runOrchestration(ctx.cfg,ctx.store,g,input);const path=first.deliverables[0].artifactPaths[0];
    const counts={...g.calls};await runOrchestration(ctx.cfg,ctx.store,g,input);assert.deepEqual(g.calls,counts);
    await writeFile(path,'损坏的文件');await runOrchestration(ctx.cfg,ctx.store,g,input);
    assert.match(await readFile(path,'utf8'),/经过实际生成/);assert.equal(g.calls.reviews,counts.reviews+1);assert.equal(g.calls.writes,counts.writes);
    await rm(path);await runOrchestration(ctx.cfg,ctx.store,g,input);assert.match(await readFile(path,'utf8'),/经过实际生成/);
    const changed=brief([item('报告',['txt'])]);changed.scoring='更新后的规则';ctx.store.setBrief(ctx.id,changed);
    const updated=await runOrchestration(ctx.cfg,ctx.store,g,input);
    assert.equal(g.calls.plans,counts.plans+1);assert.equal(g.calls.writes,counts.writes+1);
    assert.notEqual(updated.deliverables[0].artifactPaths[0],path);assert.match(await readFile(updated.deliverables[0].artifactPaths[0],'utf8'),/依照新规则/);
    assert.match(await readFile(path,'utf8'),/经过实际生成/,'旧输入的作品仍保留');
  }finally{await ctx.done();}
});

test('任务中途预算耗尽后恢复，只继续未完成的交付物',async()=>{
  const ctx=await setup(brief([item('报告',['txt']),item('说明',['txt'])]));
  try{
    const g=documentGateway({tasks:[documentTask(),documentTask({id:'second',title:'说明',deliverable:1})]});
    const generate=g.generate;let fail=true;
    g.generate=async(role,prompt)=>{if(fail&&prompt.includes('独立作品验收评审')&&prompt.includes('任务：说明'))throw Error('模型调用预算耗尽');return generate(role,prompt);};
    const input={jobId:ctx.job,competitionId:ctx.id,idea};
    await assert.rejects(runOrchestration(ctx.cfg,ctx.store,g,input),/预算/);const counts={...g.calls};fail=false;
    const result=await runOrchestration(ctx.cfg,ctx.store,g,input);
    assert.equal(g.calls.plans,counts.plans);assert.equal(g.calls.writes,counts.writes);assert.equal(g.calls.reviews,counts.reviews+1);
    assert.ok(result.deliverables.every(d=>d.status==='submission'));
    const audit=JSON.parse(await readFile(join(ctx.dir,'jobs',ctx.job,'resume-checks.json'),'utf8'));
    assert.equal(audit[0].reused,true);assert.equal(audit[1].reused,false);
  }finally{await ctx.done();}
});

test('图片的设计说明通过评审，也不能替代实际画面验收',async()=>{
  const ctx=await setup(brief([item('海报',['png'])]));
  try{
    const g={search:async()=>[],generateImage:async()=>({data:await sharp({create:{width:800,height:600,channels:3,background:'#336699'}}).png().toBuffer(),mime:'image/png'}),generate:async(role,prompt)=>{
      if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify({tasks:[documentTask({kind:'image',format:'png'})]});
      if(prompt.includes('独立作品验收评审'))return JSON.stringify({pass:true,issues:[]});
      if(prompt.includes('设计一张独特的图片作品'))return JSON.stringify({image_prompt:'校园设计',caption:''});
      throw Error('unexpected');
    }};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(result.deliverables[0].review.pass,true);assert.equal(result.deliverables[0].status,'draft');
    assert.equal(result.deliverables[0].checks.find(c=>c.id==='visual').status,'unverified');
  }finally{await ctx.done();}
});

test('返工生成另一轮产物，失败时保留上一轮草稿文件',async()=>{
  const ctx=await setup(brief([item('软件',['zip'])]));
  try{
    let builds=0;
    const g={search:async()=>[],buildProject:async(ws,prompt)=>{
      builds++;assert.match(prompt,/完整报告正文/);
      await writeFile(join(ws,'index.html'),builds===1?'<html>上一版作品</html>':'<html>失败的返工</html>');
      await writeFile(join(ws,'app.js'),builds===1?'console.log(1)':'function {');
    },generate:async(role,prompt)=>{
      if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify({tasks:[documentTask({kind:'software',format:'zip'})]});
      if(prompt.includes('独立作品验收评审'))return JSON.stringify({pass:false,issues:['需完善功能']});
      throw Error('unexpected');
    }};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(builds,2);const d=result.deliverables[0];assert.equal(d.status,'draft');assert.match(d.gaps.join(' '),/保留上一版草稿/);
    const zip=await JSZip.loadAsync(await readFile(d.artifactPaths[0]));assert.match(await zip.file('index.html').async('string'),/上一版作品/);
  }finally{await ctx.done();}
});

test('实际文件违反明确数值限制时先返工，模型说通过也不能跳过检查',async()=>{
  const d=item('报告',['txt']);d.limits=['含标点不含空白字符数：不少于20字'];d.naming='report.txt';d.quantity='1份';
  const ctx=await setup(brief([d]));
  try{
    let writes=0,reviews=0;const g={search:async()=>[],generate:async(role,prompt)=>{
      if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify({tasks:[documentTask()]});
      if(prompt.includes('直接创作')){writes++;if(writes===2)assert.match(prompt,/实测.*字符/);return JSON.stringify({kind:'text',title:'报告',text:writes===1?'太短':'这份完整作品描述了具体对象与问题，并说明了方案机制及后续验证计划。',sources:[]});}
      if(prompt.includes('独立作品验收评审')){reviews++;return JSON.stringify({pass:true,issues:[]});}
      throw Error('unexpected');
    }};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(writes,2);assert.equal(reviews,1);assert.equal(result.deliverables[0].status,'submission');assert.match(result.outputs[0],/report\.txt$/);
    const requirements=JSON.parse(await readFile(join(ctx.dir,'jobs',ctx.job,'requirements.json'),'utf8'));
    assert.ok(requirements[0].checks.every(c=>c.status==='passed'));assert.ok(requirements[0].metrics[0].characters>=20);
  }finally{await ctx.done();}
});

test('未知命名及未核实字数要求写入产物检查记录，不能登记为投稿件',async()=>{
  const d=item('报告',['txt']);d.naming='学校_作者姓名_作品名称';d.limits=['1000字以内'];
  const ctx=await setup(brief([d]));
  try{const g=documentGateway({tasks:[documentTask()]});const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(result.deliverables[0].status,'draft');assert.ok(result.deliverables[0].checks.some(c=>c.id==='delivery-naming'&&c.status==='unverified'));
    assert.ok(!ctx.store.artifacts(ctx.job).some(a=>a.kind==='submission'));
  }finally{await ctx.done();}
});

test('明确要求多份作品时修正规划，确定性回退也补齐最终文件数量',async()=>{
  const d=item('报告',['txt']);d.quantity='2份';const ctx=await setup(brief([d]));
  try{const g=documentGateway({tasks:[documentTask()]});const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(g.calls.plans,2);assert.equal(result.outputs.length,2);assert.ok(result.deliverables.every(d=>d.status==='submission'));assert.match(result.gaps.join(' '),/计划只有 1 个最终文件/);
  }finally{await ctx.done();}
});

test('规则检查报告只关联可在来源中逐字核对的引用',async()=>{
  const b=brief([item('报告',['txt'])]);b.citations=[{field:'deliverables.0.formats',url:'https://example.edu.cn/rules',quote:'作品采用TXT格式'},{field:'deliverables[0].quantity',url:'https://example.edu.cn/rules',quote:'编造数量'}];
  const ctx=await setup(b);
  try{ctx.store.putEvidence({id:'rule-evidence',competitionId:ctx.id,url:'https://example.edu.cn/rules',title:'规则',text:'作品采用TXT格式。',fetchedAt:new Date().toISOString(),kind:'official'});
    const g=documentGateway({tasks:[documentTask()]});await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    const requirements=JSON.parse(await readFile(join(ctx.dir,'jobs',ctx.job,'requirements.json'),'utf8'));
    assert.equal(requirements[0].sources.length,1);assert.equal(requirements[0].sources[0].quote,'作品采用TXT格式');
  }finally{await ctx.done();}
});

test('多轮任务在第三轮评审中断，恢复时不重复已完成的写作和评审',async()=>{
  const ctx=await setup(brief([item('报告',['txt'])]));ctx.cfg.execution.productionRounds=4;
  try{
    let writes=0,reviews=0,interrupt=true;const g={search:async()=>[],generate:async(role,prompt)=>{
      if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify({tasks:[documentTask()]});
      if(prompt.includes('直接创作')){writes++;if(writes>1){assert.match(prompt,/上一版作品：\{/);assert.match(prompt,new RegExp(`第${writes-1}版正文`));}return JSON.stringify({kind:'text',title:'报告',text:`第${writes}版正文`,sources:[]});}
      if(prompt.includes('独立作品验收评审')){if(interrupt&&writes===3)throw Error('预算耗尽');reviews++;return JSON.stringify(reviews<3?{pass:false,issues:['请补充论证']}: {pass:true,issues:[]});}
      throw Error('unexpected');
    }};const input={jobId:ctx.job,competitionId:ctx.id,idea};
    await assert.rejects(runOrchestration(ctx.cfg,ctx.store,g,input),/预算/);assert.equal(writes,3);assert.equal(reviews,2);interrupt=false;
    const result=await runOrchestration(ctx.cfg,ctx.store,g,input);assert.equal(writes,3);assert.equal(reviews,3);assert.equal(result.deliverables[0].rounds,3);assert.equal(result.deliverables[0].status,'submission');
  }finally{await ctx.done();}
});

test('增加制作轮数后继续原来的失败草稿，复用此前完整轮次',async()=>{
  const ctx=await setup(brief([item('报告',['txt'])]));
  try{
    let writes=0,reviews=0;const g=documentGateway({tasks:[documentTask()]});const original=g.generate;
    g.generate=async(role,prompt)=>{if(prompt.includes('直接创作'))writes++;if(prompt.includes('独立作品验收评审')){reviews++;return JSON.stringify({pass:reviews===3,issues:reviews===3?[]:['需补充具体内容']});}return original(role,prompt);};
    const input={jobId:ctx.job,competitionId:ctx.id,idea};const first=await runOrchestration(ctx.cfg,ctx.store,g,input);assert.equal(first.deliverables[0].status,'draft');assert.equal(writes,2);
    ctx.cfg.execution.productionRounds=4;const next=await runOrchestration(ctx.cfg,ctx.store,g,input);assert.equal(next.deliverables[0].status,'submission');assert.equal(writes,3);assert.equal(reviews,3);
  }finally{await ctx.done();}
});

test('软件返工承接上一轮可用文件，同时保留上一轮原件',async()=>{
  const ctx=await setup(brief([item('软件',['zip'])]));
  try{
    let builds=0,reviews=0;const folders=[];const g={search:async()=>[],buildProject:async(ws)=>{
      builds++;folders.push(ws);
      if(builds===1){await writeFile(join(ws,'index.html'),'<html><script src="state.js"></script></html>');await writeFile(join(ws,'state.js'),'const preserved = 1;');}
      else{assert.equal(await readFile(join(ws,'state.js'),'utf8'),'const preserved = 1;');await writeFile(join(ws,'index.html'),'<html>修订界面<script src="state.js"></script></html>');}
    },generate:async(role,prompt)=>{
      if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify({tasks:[documentTask({kind:'software',format:'zip'})]});
      if(prompt.includes('独立作品验收评审')){reviews++;return JSON.stringify({pass:reviews===2,issues:reviews===2?[]:['补充界面']});}throw Error('unexpected');
    }};
    await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});assert.equal(builds,2);assert.doesNotMatch(await readFile(join(folders[0],'index.html'),'utf8'),/修订界面/);
  }finally{await ctx.done();}
});

test('规划中断后恢复已保存的错误计划，后续轮次接到原计划与具体反馈',async()=>{
  const ctx=await setup(brief([item('报告',['txt'])]));ctx.cfg.execution.plannerRounds=3;
  try{
    let plans=0,stop=true;const base=documentGateway({tasks:[documentTask()]});const original=base.generate;
    base.generate=async(role,prompt)=>{if(prompt.includes('拆解成可以实际制作的文件任务')){plans++;if(plans===1)return JSON.stringify({tasks:[documentTask({format:'docx'})]});if(stop)throw Error('规划预算耗尽');assert.match(prompt,/上一份计划：.*docx/s);assert.match(prompt,/不符合交付物指定格式/);return JSON.stringify({tasks:[documentTask()]});}return original(role,prompt);};
    const input={jobId:ctx.job,competitionId:ctx.id,idea};await assert.rejects(runOrchestration(ctx.cfg,ctx.store,base,input),/预算/);stop=false;
    const result=await runOrchestration(ctx.cfg,ctx.store,base,input);assert.equal(plans,3);assert.equal(result.deliverables[0].status,'submission');
  }finally{await ctx.done();}
});

test('计划里安排执行 Agent 打包其他任务文件时被拦下，要求改用 packages',()=>{
  const b=brief([item('参赛作品压缩包',['zip'])]);
  const plan=Plan.parse({tasks:[{id:'doc',deliverable:0,title:'说明书',kind:'document',format:'pdf',instructions:'x',acceptance:['y']},{id:'pack',deliverable:0,title:'打包参赛作品压缩包',kind:'software',format:'zip',instructions:'包内含 doc 的 PDF',acceptance:['y']}]});
  assert.match(planProblems(plan,b,false).join('\n'),/任务 pack 在打包其他任务的文件/);
});

test('一个图片任务要求多张图时被拦下，要求拆分',()=>{
  const b=brief([item('作品图片',['png'])]);
  const plan=Plan.parse({tasks:[{id:'renders',deliverable:0,title:'渲染图（主视图、爆炸图、场景图）',kind:'image',format:'png',instructions:'x',acceptance:['交付3张PNG，文件名分别含main / exploded / scenario']}]});
  assert.match(planProblems(plan,b,false).join('\n'),/任务 renders 要求多张图片/);
});

test('评审只按阻塞问题判定：细节建议不阻止通过，待补资料汇总成单独文件',async()=>{
  const ctx=await setup(brief([item('方案报告',['docx'])]));
  try{let writes=0,reviewPrompt='',writePrompt='';
    const g={search:async()=>[],generate:async(role,prompt)=>{
      if(prompt.includes('拆解成可以实际制作的文件任务'))throw Error('规划不可用');
      if(prompt.includes('独立作品验收评审')){reviewPrompt=prompt;return JSON.stringify({issues:[],suggestions:['第3节标题层级可统一'],needs_input:['团队实测的开启力数据']});}
      if(prompt.includes('直接创作')){writes++;writePrompt=prompt;return JSON.stringify({kind:'text',title:'报告',text:'## 背景\n用户调研显示【待补充：用户访谈记录】。',sources:[],needs_input:['10 名目标用户的访谈记录']});}
      throw Error('unexpected');}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(writes,1,'只有建议时不返工');
    assert.equal(result.deliverables[0].review.pass,true);
    assert.match(writePrompt,/不要防御性写作/);assert.match(reviewPrompt,/细枝末节/);
    const file=result.outputs.find(x=>x.endsWith('需要你提供的资料.md'));assert.ok(file,'生成待补资料文件');
    const text=await readFile(file,'utf8');assert.match(text,/10 名目标用户的访谈记录/);assert.match(text,/团队实测的开启力数据/);
    assert.doesNotMatch(result.gaps.join(' '),/标题层级/,'建议不进入缺口');
  }finally{await ctx.done();}
});

test('评审给出阻塞问题时，即使模型写 pass:true 也判不通过',async()=>{
  const ctx=await setup(brief([item('方案报告',['docx'])]));
  try{let writes=0;const g={search:async()=>[],generate:async(role,prompt)=>{if(prompt.includes('拆解成可以实际制作的文件任务'))throw Error('规划不可用');if(prompt.includes('独立作品验收评审'))return JSON.stringify(writes===1?{pass:true,issues:['核心机制只有一句话，没有原理说明']}:{issues:[]});if(prompt.includes('直接创作')){writes++;return JSON.stringify({kind:'text',title:'报告',text:'正文',sources:[]});}throw Error('unexpected');}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(writes,2);assert.equal(result.deliverables[0].rounds,2);
  }finally{await ctx.done();}
});

test('评审看实际图片：通过即完成视觉验收；PPT 嵌入先生成的图片',async()=>{
  const ctx=await setup(brief([item('参赛作品压缩包',['zip'])]));
  try{const seen=[];let slidePrompt='';
    const g={search:async()=>[],
      generateImage:async()=>({data:await sharp({create:{width:800,height:600,channels:3,background:'#336699'}}).png().toBuffer(),mime:'image/png'}),
      inspectImage:async(prompt,image,agent)=>{seen.push({agent,mime:image.mime,bytes:image.data.length});assert.match(prompt,/实际生成的图片/);return JSON.stringify({issues:[],suggestions:[],needs_input:[]});},
      generate:async(role,prompt)=>{
        if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify({tasks:[
          {id:'deck',deliverable:0,title:'展示PPT',kind:'slides',format:'pptx',instructions:'展示作品',acceptance:['含效果图']},
          {id:'render',deliverable:0,title:'效果图',kind:'image',format:'png',instructions:'产品主视图',acceptance:['主体清晰']}],
          packages:[{name:'作品.zip',deliverable:0,includes:['deck','render']}]});
        if(prompt.includes('设计一张独特的图片作品'))return JSON.stringify({image_prompt:'产品',caption:'效果图'});
        if(prompt.includes('独立作品验收评审'))return JSON.stringify({issues:[]});
        if(prompt.includes('直接创作')){slidePrompt=prompt;return JSON.stringify({kind:'slides',title:'展示',sources:[],slides:[{background:'FFFFFF',elements:[{type:'text',text:'作品外观',x:0.5,y:0.3,w:6,h:0.8,fontSize:28},{type:'image',ref:'render',x:0.5,y:1.3,w:8,h:5.5}]}]});}
        throw Error('unexpected '+prompt.slice(0,40));}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(seen.length,1);assert.equal(seen[0].agent,'reviewer');assert.equal(seen[0].mime,'image/jpeg');
    const render=result.deliverables.find(d=>d.id==='render');assert.equal(render.checks.find(c=>c.id==='visual').status,'passed');
    assert.match(slidePrompt,/"ref":"render"/,'PPT 写作时已知道图片');
    const deck=result.deliverables.find(d=>d.id==='deck');const pptx=await JSZip.loadAsync(await readFile(deck.artifactPaths[0]));
    assert.ok(Object.keys(pptx.files).some(n=>/^ppt\/media\/.+\.(jpe?g|png)$/i.test(n)),'PPT 内含图片');
    assert.deepEqual(result.deliverables.slice(0,2).map(d=>d.id),['deck','render'],'结果按计划顺序输出');
  }finally{await ctx.done();}
});

test('PPT 引用不存在的图片时要求修复',async()=>{
  const {validateWork}=await import('../dist/artifacts/artifacts.js');
  const work=Work.parse({kind:'slides',title:'t',sources:[],slides:[{background:'FFFFFF',elements:[{type:'image',ref:'nope',x:0,y:0,w:4,h:3}]}]});
  assert.match(validateWork(work,{render:'x.png'}).join(' '),/不存在的图片 nope/);
});

test('图题默认放在画面下方的色带里，不遮挡画面',async()=>{
  const {makeVisual,VisualBrief}=await import('../dist/artifacts/visual.js');const dir=await mkdtemp(join(tmpdir(),'band-'));
  try{const g={generateImage:async()=>({data:await sharp({create:{width:800,height:600,channels:3,background:'#ff0000'}}).png().toBuffer(),mime:'image/png'})};
    const out=await makeVisual(g,VisualBrief.parse({image_prompt:'x',caption:'这是一个很长的图题用来检查自动缩小字号是否生效'}),'png',dir);
    const meta=await sharp(out).metadata();assert.equal(meta.width,800);assert.ok(meta.height>600,'色带加在画面下方');
    const {data}=await sharp(out).extract({left:400,top:300,width:1,height:1}).raw().toBuffer({resolveWithObject:true});assert.deepEqual([...data].slice(0,3),[255,0,0],'画面本身未被覆盖');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('长文档先列大纲再逐章写，返工时只重写评审指出的章节',async()=>{
  const ctx=await setup(brief([item('设计说明书',['docx'])]));
  try{const calls={outline:0,section:[]};let reviews=0;
    const g={search:async()=>[],generate:async(role,prompt)=>{
      if(prompt.includes('拆解成可以实际制作的文件任务'))return JSON.stringify({tasks:[documentTask({format:'docx',instructions:'写一份 8000-12000字的设计说明书',acceptance:['内容完整']})]});
      if(prompt.includes('先只输出大纲')){calls.outline++;const revise=prompt.includes('这是返工');return JSON.stringify({title:'设计说明书',sections:[{heading:'## 背景',points:['问题'],chars:3000,rewrite:!revise},{heading:'## 机制',points:['原理'],chars:5000,rewrite:true}],needs_input:[]});}
      if(prompt.includes('分章写作：现在只写')){const n=prompt.match(/第 (\d+)\/2 章/)[1];calls.section.push(n);return n==='1'?'## 背景\n背景正文。':`## 机制\n${prompt.includes('机制只有一句话')?'机制原理的详细说明，用户访谈【待补充：5 名用户的访谈记录】。':'机制一句话。'}`;}
      if(prompt.includes('独立作品验收评审')){reviews++;return JSON.stringify(reviews===1?{issues:['机制只有一句话，需展开原理']}:{issues:[]});}
      throw Error('unexpected '+prompt.slice(0,40));}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(calls.outline,2);assert.deepEqual(calls.section,['1','2','2'],'返工只重写第 2 章');
    const d=result.deliverables[0];assert.equal(d.review.pass,true);assert.equal(d.rounds,2);
    const text=await readSource(d.artifactPaths[0]);assert.match(text,/背景正文/);assert.match(text,/机制原理的详细说明/);
    assert.ok(d.needsInput.some(x=>x.includes('5 名用户的访谈记录')),'正文中的待补充标记进入资料清单');
  }finally{await ctx.done();}
});

test('从制作要求中识别目标字数',async()=>{
  const {targetLength}=await import('../dist/workflows/orchestrator.js');
  assert.equal(targetLength({instructions:'正文 8000–12000字',acceptance:[]}),8000);
  assert.equal(targetLength({instructions:'不少于1.5万字',acceptance:['摘要300字']}),15000);
  assert.equal(targetLength({instructions:'简短说明',acceptance:[]}),0);
});

test('compete materials 导入用户资料，写作提示词把它当作可用事实',async()=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const dir=await mkdtemp(join(tmpdir(),'materials-'));
  try{let store=new Store(dir);const id=store.addCompetition('https://example.edu.cn/m','赛事');store.setBrief(id,brief([item('方案报告',['docx'])]));const job=store.createJob(id,'automatic',{},40);store.close();
    const file=join(dir,'访谈.md');await writeFile(file,'# 用户访谈\n受访者 A：每天服药 5 次。');
    const {stdout}=await promisify(execFile)(process.execPath,['dist/cli.js','materials',id,file],{cwd:process.cwd(),env:{...process.env,COMPETE_DATA_DIR:dir},timeout:20000});
    assert.match(stdout,/资料已导入/);
    store=new Store(dir);
    try{const e=store.evidence(id).find(x=>x.kind==='user');assert.ok(e);assert.match(e.text,/每天服药 5 次/);
      let prompt='';const cfg={dataDir:dir,execution:{productionRounds:2,plannerRounds:2},writer:{providerID:'google',id:'gemini-test'},reviewer:{providerID:'anthropic',id:'claude-test'},maxCalls:40,sources:[],profile:{}};
      const g={search:async()=>[],generate:async(role,p)=>{if(p.includes('拆解成可以实际制作的文件任务'))throw Error('规划不可用');if(p.includes('独立作品验收评审'))return JSON.stringify({issues:[]});if(p.includes('直接创作')){prompt=p;return JSON.stringify({kind:'text',title:'报告',text:'正文',sources:[]});}throw Error('unexpected');}};
      await runOrchestration(cfg,store,g,{jobId:job,competitionId:id,idea});
      assert.match(prompt,/kind 为 user/);assert.match(prompt,/每天服药 5 次/);
    }finally{store.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('评审输出不是有效 JSON 时重试一次，而不是记为未评审',async()=>{
  const ctx=await setup(brief([item('方案报告',['docx'])]));
  try{let reviews=0;const g={search:async()=>[],generate:async(role,prompt)=>{if(prompt.includes('拆解成可以实际制作的文件任务'))throw Error('规划不可用');if(prompt.includes('独立作品验收评审')){reviews++;return reviews===1?'{"issues":["被截断':JSON.stringify({issues:[]});}if(prompt.includes('直接创作'))return JSON.stringify({kind:'text',title:'报告',text:'正文',sources:[]});throw Error('unexpected');}};
    const result=await runOrchestration(ctx.cfg,ctx.store,g,{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.equal(reviews,2);assert.equal(result.deliverables[0].review.pass,true);
  }finally{await ctx.done();}
});

async function formatServer(html){const {createServer}=await import('node:http');const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,url:`http://127.0.0.1:${server.address().port}/notice`};}
const formatGateway=(url,quote,writes)=>({search:async()=>[{url,title:'征文要求',snippet:''}],generate:async(role,prompt)=>{
  if(prompt.includes('没有写提交文件格式'))return JSON.stringify({items:[{deliverable:0,formats:['docx'],url,quote}]});
  if(prompt.includes('拆解成可以实际制作的文件任务'))throw Error('规划不可用');
  if(prompt.includes('独立作品验收评审'))return JSON.stringify({issues:[]});
  if(prompt.includes('直接创作')){writes.push(prompt);return JSON.stringify({kind:'text',title:'论文',text:'正文',sources:[]});}
  throw Error('unexpected '+prompt.slice(0,40));}});

test('公告没写格式时搜索官方要求，引用核对通过后作品成为投稿件',async()=>{
  const {server,url}=await formatServer('<title>征文要求</title><p>论文请以 Word 格式提交，正文不少于 3000 字。</p>');
  const ctx=await setup(brief([item('征文论文',[])]));
  try{const writes=[];const result=await runOrchestration(ctx.cfg,ctx.store,formatGateway(url,'论文请以 Word 格式提交',writes),{jobId:ctx.job,competitionId:ctx.id,idea});
    const d=result.deliverables[0];assert.equal(d.format,'docx');assert.equal(d.checks.find(c=>c.id==='format').status,'passed');assert.equal(d.status,'submission');
    const saved=ctx.store.competition(ctx.id).brief;assert.deepEqual(saved.deliverables[0].formats,['docx']);assert.ok(saved.citations.some(c=>c.field==='deliverables.0.formats'&&c.url===url));
    assert.ok(!result.outputs.some(x=>x.endsWith('需要你提供的资料.md')));
  }finally{server.close();await ctx.done();}
});

test('格式引用在页面里找不到时不采纳，保持草稿并向用户索要格式要求',async()=>{
  const {server,url}=await formatServer('<title>征文通知</title><p>欢迎投稿，具体要求见网盘附件。</p>');
  const ctx=await setup(brief([item('征文论文',[])]));
  try{const writes=[];const result=await runOrchestration(ctx.cfg,ctx.store,formatGateway(url,'论文请以 PDF 格式提交',writes),{jobId:ctx.job,competitionId:ctx.id,idea});
    assert.deepEqual(ctx.store.competition(ctx.id).brief.deliverables[0].formats,[]);assert.notEqual(result.deliverables[0].status,'submission');
    const file=result.outputs.find(x=>x.endsWith('需要你提供的资料.md'));assert.ok(file);
    const text=await readFile(file,'utf8');assert.match(text,/## 提交格式/);assert.match(text,/征文论文/);assert.match(text,/compete materials/);
  }finally{server.close();await ctx.done();}
});

test('只承认引用里写明的文件格式',async()=>{
  const {formatsInQuote}=await import('../dist/workflows/formats.js');
  assert.deepEqual(formatsInQuote('请以 Word 格式提交'),['docx']);assert.deepEqual(formatsInQuote('作品打包为压缩包，附 PDF 说明'),['pdf','zip']);
  assert.deepEqual(formatsInQuote('稿件字数不少于 3000 字'),[]);
});
