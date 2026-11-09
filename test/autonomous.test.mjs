import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../dist/core/store.js';
import { Brief } from '../dist/core/types.js';
import { discoverCompetitions, runAutomatic, deliveryFormat, canDraftUnknownFormat } from '../dist/workflows/autonomous.js';
import { renderWork, Work } from '../dist/artifacts/artifacts.js';
import { makeSoftware } from '../dist/artifacts/software.js';
import { makeVisual, VisualBrief } from '../dist/artifacts/visual.js';
import sharp from 'sharp';
import { readTemplate } from '../dist/artifacts/templates.js';
import { Document, Packer, Paragraph } from 'docx';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function setup(page='<title>2026 创意竞赛</title><p>提交方案报告和演示文稿。</p>'){const dir=await mkdtemp(join(tmpdir(),'competition-auto-'));const store=new Store(dir);const cfg={dataDir:dir,opencodeUrl:'http://127.0.0.1:4096',writer:{providerID:'google',id:'gemini-test'},reviewer:{providerID:'anthropic',id:'claude-test'},maxCalls:40,searchProvider:'tinyfish',sources:[],profile:{}};const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(page)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/contest`;return {dir,store,cfg,server,url};}
const brief=(deliverables,requires_idea=true)=>({title:'2026 创意竞赛',edition:'2026',eligibility:null,deadline:null,ai_rules:null,scoring:null,deliverables,requires_idea,missing:[]});
const item=(type,formats)=>({type,formats,quantity:null,limits:[],naming:null,attachments:[],submission:null,official_template:null});

test('候选生成预算耗尽会中断，补充预算后只生成缺失分支',async()=>{
 const {dir,store,cfg,server,url}=await setup();
 try{
  const id=store.addCompetition(url,'赛事'),job=store.createJob(id,'automatic',{},2);
  const gateway=makeGateway(brief([item('报告',['txt'])])),original=gateway.generate;
  const attempts=new Map();
  gateway.generate=async(role,prompt)=>{
   if(prompt.includes('为以下比赛独立提出一个作品方案')){
    const angle=prompt.match(/本分支视角：([^。]+)/)[1];
    attempts.set(angle,(attempts.get(angle)||0)+1);store.reserveCalls(job,1);
   }
   return original(role,prompt);
  };
  await assert.rejects(runAutomatic(cfg,store,gateway,job),/预算|上限/);
  assert.equal(store.job(job).state,'failed');
  // 三个分支并发，抢到预算的是哪两个不固定；只要求恰好两个已保存，恢复后不重做。
  const saved=new Map();for(const n of [1,2,3]){try{saved.set(n,await readFile(join(dir,'jobs',job,`concept-${n}.json`),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  assert.equal(saved.size,2);
  store.setBudget(job,4);
  const result=await runAutomatic(cfg,store,gateway,job,true);
  assert.equal(result.ideas.length,3);assert.equal(store.job(job).state,'completed');
  assert.deepEqual([...attempts.values()].sort(),[1,1,2]);assert.equal(store.job(job).calls,3);
  for(const [n,text] of saved)assert.equal(await readFile(join(dir,'jobs',job,`concept-${n}.json`),'utf8'),text);
 }finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('嵌套研究预算耗尽保留节点，恢复时继续研究而不重复来源追查',async()=>{
 const {dir,store,cfg,server,url}=await setup();
 try{
  const id=store.addCompetition(url,'赛事'),job=store.createJob(id,'automatic',{},1);
  const gateway=makeGateway(brief([item('报告',['txt'])],false)),original=gateway.generate;
  let investigations=0,followups=0,searches=0;
  gateway.search=async()=>{searches++;return [];};
  gateway.generate=async(role,prompt)=>{
   if(prompt.includes('提出最多三个具体的后续搜索词')){followups++;store.reserveCalls(job,1);}
   return original(role,prompt);
  };
  gateway.investigate=async()=>{investigations++;store.reserveCalls(job,2);return {text:JSON.stringify({urls:[],missing:['未找到公开作品']})};};
  await assert.rejects(runAutomatic(cfg,store,gateway,job),/预算|上限/);
  assert.equal(store.job(job).state,'failed');assert.equal(investigations,1);
  store.setBudget(job,5);
  await runAutomatic(cfg,store,gateway,job,true);
  assert.equal(store.job(job).state,'completed');assert.equal(investigations,2);
  assert.equal(followups,1);assert.equal(searches,6);assert.equal(store.job(job).calls,3);
 }finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}
});

function makeGateway(data,overrides={}){let index=0;const calls=[];const g={calls,search:async()=>[],generate:async(role,prompt)=>{calls.push({role,prompt});if(overrides.generate)return overrides.generate(role,prompt,calls);if(prompt.includes('提出最多三个具体的后续搜索词'))return '[]';if(prompt.includes('读取来源并只输出一个 JSON 对象'))return JSON.stringify(data);if(prompt.includes('撰写中文赛事研究报告'))return '依据资料整理的赛事研究';if(prompt.includes('判断当前比赛是否适合'))return JSON.stringify({decision:'proceed',reason:'资格需要核实',evidence_url:null,evidence_quote:null});if(prompt.includes('为以下比赛独立提出一个作品方案')){index++;return JSON.stringify({title:`方案${index}`,audience:`人群${index}`,problem:`问题${index}`,mechanism:`方法${index}`,verification:`验证${index}`,evidence_urls:[]});}if(prompt.includes('比较三个独立方案'))return JSON.stringify({selected:2,analysis:'第二个方案适合当前约束',similarity_risks:['往届作品公开不足']});if(prompt.includes('从给定的完整来源中寻找比赛明确指定要翻译的原文')||prompt.includes('从给定资料中寻找比赛指定要翻译的原文'))return JSON.stringify({url:null,text:null,reason:'未公开'});if(prompt.includes('根据规则、证据与指定作品检查缺项'))return JSON.stringify({issues:[],unsupported_claims:[]});if(prompt.includes('请针对这项比赛的指定交付物直接创作')){if(prompt.includes('"kind":"slides"'))return JSON.stringify({kind:'slides',title:'作品演示',sources:[],slides:[{background:'FFFFFF',elements:[{text:'真实可检验方案',x:1,y:1,w:7,h:1,fontSize:24,color:'202832',bold:true}]}]});return JSON.stringify({kind:'text',title:'方案',text:'基于当前资料提出的方案',sources:[]});}throw Error('unexpected prompt '+prompt.slice(0,100));}};return g;}

test('自动发现覆盖多类赛事而不是固定翻译赛，并按 URL 去重',async()=>{const {dir,store,cfg,server,url}=await setup();try{const q=[];const g={search:async query=>{q.push(query);return [{url,title:'比赛',snippet:''}]},generate:async()=>''};const ids=await discoverCompetitions(store,g);assert.equal(q.length,8);assert.ok(q.some(x=>x.includes('创新')));assert.ok(q.some(x=>x.includes('视频')));assert.ok(q.some(x=>x.includes('翻译')));assert.equal(ids.length,1);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});
test('自动发现跳过比赛平台首页并优先高校当届通知',async()=>{const {dir,store,server}=await setup();try{const year=new Date().getFullYear();const g={generate:async()=>'',search:async()=>[{url:'https://example.com/',title:'我爱竞赛网-高含金量竞赛平台',snippet:''},{url:'https://example.edu.cn/archive',title:'设计类竞赛归档-高等院校竞赛活动报名系统',snippet:''},{url:'https://example.com/a',title:'往届作品比赛',snippet:''},{url:'https://news.example.edu.cn/b',title:`关于 ${year} 年创新比赛征集通知`,snippet:''}]};const ids=await discoverCompetitions(store,g,'大学生比赛');assert.equal(ids.length,2);assert.match(store.competition(ids[0]).url,/example\.edu\.cn/);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('自动发现读取配置的赛事来源并保存来源访问记录',async()=>{const {dir,store,server,url}=await setup('<a href="/event">大学生创新大赛征集通知</a>');try{const g={search:async()=>[],generate:async()=>''};const ids=await discoverCompetitions(store,g,'无结果查询',[url]);assert.equal(ids.length,1);assert.match(store.competition(ids[0]).url,/\/event$/);assert.ok(store.searches(null).some(x=>x.query===`source:${url}`));}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('来源列表模式无需搜索密钥，跳过明显的获奖结果公告并记录检索缺口',async()=>{const {dir,store,server,url}=await setup('<a href="/event">大学生创新大赛征集通知</a><a href="/result">大学生创新大赛获奖公告</a>');try{const g={canSearch:false,search:async()=>{throw Error('不应调用搜索');},generate:async()=>''};const ids=await discoverCompetitions(store,g,undefined,[url]);assert.equal(ids.length,1);assert.match(store.competition(ids[0]).url,/\/event$/);assert.ok(store.searches(null).some(x=>x.error?.includes('未配置全网关键词搜索')));}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('独立方案并发生成，针对各方案查询相似作品',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'automatic',{},40);const g=makeGateway(brief([item('报告',['txt'])]));const original=g.generate;let active=0,max=0;g.generate=async(role,prompt)=>{if(prompt.includes('为以下比赛独立提出一个作品方案')){active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,25));active--;}return original(role,prompt);};const queries=[];g.search=async q=>{queries.push(q);return [];};await runAutomatic(cfg,store,g,job);assert.equal(max,3);assert.equal(queries.filter(q=>q.includes('竞赛 获奖作品')).length,3);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('往届证据必须能在实际来源中核对，伪造摘录被剔除',async()=>{const {dir,store,cfg,server,url}=await setup('<title>比赛资料</title><p>获奖名单：海岸守护获得一等奖。</p>');try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'research',{},20);const data=brief([item('报告',['txt'])]);data.research={past_winners:[{url,quote:'海岸守护获得一等奖'}],past_works:[{url,quote:'编造的完整参赛作品内容'}],judging:[],missing:[]};const g=makeGateway(data);const {runJob}=await import('../dist/workflows/workflow.js');await runJob(cfg,store,g,job);const research=store.competition(id).brief.research;assert.equal(research.past_winners.length,1);assert.equal(research.past_works.length,0);assert.match(research.missing.join(' '),/往届/);assert.ok(store.sourceAttempts(id).length>0);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('规则提取字段类型错误时只重试结构修复',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'research',{},20);const g=makeGateway(brief([item('报告',['txt'])]));const original=g.generate;let attempts=0;g.generate=async(role,prompt)=>{if(prompt.includes('读取来源并只输出一个 JSON 对象')){attempts++;return JSON.stringify({...brief([item('报告',['txt'])]),eligibility:{scope:'在校学生'}});}if(prompt.includes('上一份规则档案不符合指定 JSON 字段类型')){attempts++;return JSON.stringify({...brief([item('报告',['txt'])]),eligibility:'在校学生'});}return original(role,prompt);};const {runJob}=await import('../dist/workflows/workflow.js');await runJob(cfg,store,g,job);assert.equal(attempts,2);assert.equal(store.competition(id).brief.eligibility,'在校学生');}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('研究流程调用 Claude Agent 追查并独立抓取返回的公开来源',async()=>{const {dir,store,cfg,server,url}=await setup('<title>公开作品</title><p>海岸守护获奖作品的公开演示内容。</p>');try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'research',{},20);const g=makeGateway(brief([item('报告',['txt'])]));let prompt='';g.investigate=async p=>{prompt=p;return {sessionId:'s1',text:JSON.stringify({urls:[{url:`${url}?work=1`,title:'作品展示'}],missing:[]}),events:[]};};const {runJob}=await import('../dist/workflows/workflow.js');await runJob(cfg,store,g,job);assert.match(prompt,/往届获奖名单/);assert.ok(store.evidence(id).some(e=>e.kind==='agent_research'&&e.url.endsWith('?work=1')));assert.equal(JSON.parse(await readFile(join(dir,'jobs',job,'claude-research.json'),'utf8')).sessionId,'s1');}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('PPT 渲染校验页数并保留预览，不把缺少工具视为成功',async()=>{const {dir,store,server}=await setup();try{const {previewSlides}=await import('../dist/artifacts/preview.js');const calls=[];const ok=await previewSlides(join(dir,'submission.pptx'),2,async(cmd,args)=>{calls.push({cmd,args});if(cmd.includes('pdftoppm')){await writeFile(`${args.at(-1)}-1.png`,'page1');await writeFile(`${args.at(-1)}-2.png`,'page2');}});assert.equal(ok.status,'rendered');assert.equal(ok.pages.length,2);assert.equal(calls.length,2);const fail=await previewSlides(join(dir,'submission.pptx'),1,async()=>{throw Error('missing renderer');});assert.equal(fail.status,'unavailable');assert.match(fail.reason,/missing renderer/);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('自动完成研究、三种独立方案和多个交付物；评审 Agent 独立比较候选方案',async()=>{const {dir,store,cfg,server,url}=await setup();try{const competitionId=store.addCompetition(url,'2026 创意竞赛');const job=store.createJob(competitionId,'automatic',{},40);const gateway=makeGateway(brief([item('方案报告',['docx']),item('演示文稿',['pptx'])]));const result=await runAutomatic(cfg,store,gateway,job);assert.equal(store.job(job).state,'completed');assert.equal(result.ideas.length,3);assert.equal(result.choice.selected,1);assert.equal(result.outputs.filter(x=>x.endsWith('.docx')).length,1);assert.equal(result.outputs.filter(x=>x.endsWith('.pptx')).length,1);assert.match(result.gaps.join(" "),/往届/);const concepts=gateway.calls.filter(x=>x.prompt.includes('为以下比赛独立提出一个作品方案'));assert.equal(concepts.length,3);assert.ok(concepts.every(x=>x.role==='writer'));assert.ok(gateway.calls.some(x=>x.role==='reviewer'&&x.prompt.includes('任务：候选比较')));assert.ok(!concepts[1].prompt.includes('方案1'));const produced=gateway.calls.filter(x=>x.prompt.includes('请针对这项比赛的指定交付物直接创作'));assert.ok(produced.every(x=>x.role==='writer'));const report=JSON.parse(await readFile(result.outputs.at(-1),'utf8'));assert.equal(report.status,'needs_review');}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('翻译原文没公开时自动保留缺口，不编造原文或作品',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'翻译大赛');const job=store.createJob(id,'automatic',{},30);const g=makeGateway(brief([item('翻译作品',['docx'])],false));const result=await runAutomatic(cfg,store,g,job);assert.match(result.gaps.join(' '),/资料中没有找到比赛指定的翻译原文/);assert.equal(result.outputs.filter(x=>x.endsWith('docx')).length,0);assert.equal(g.calls.filter(x=>x.prompt.includes('为以下比赛独立提出一个作品方案')).length,0);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('选题引用未收集来源不再中断任务',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'征文通知');const job=store.createJob(id,'automatic',{},40);let idea=0;const g=makeGateway(brief([item('征文论文',[])],false),{generate:async(role,prompt)=>{if(prompt.includes('提出最多三个具体的后续搜索词'))return '[]';if(prompt.includes('读取来源并只输出一个 JSON 对象'))return JSON.stringify(brief([item('征文论文',[])],false));if(prompt.includes('撰写中文赛事研究报告'))return '研究报告';if(prompt.includes('判断当前比赛是否适合'))return JSON.stringify({decision:'proceed',reason:'待核实',evidence_url:null,evidence_quote:null});if(prompt.includes('为以下比赛独立提出一个作品方案')){idea++;return JSON.stringify({title:`方向${idea}`,audience:'学生',problem:'教学问题',mechanism:`方法${idea}`,verification:'待验证',evidence_urls:['https://example.net/uncollected']});}if(prompt.includes('比较三个独立方案'))return JSON.stringify({selected:1,analysis:'可行',similarity_risks:[]});if(prompt.includes('请针对这项比赛的指定交付物直接创作'))return JSON.stringify({kind:'text',title:'教学实践构想',text:'## 摘要\n摘要。\n## 引言\n教学方案的具体论证。\n## 结论与局限\n结论。',sources:[]});if(prompt.includes('检查文字初稿')||prompt.includes('复审修订后的文字草稿'))return JSON.stringify({issues:[],unsupported_claims:[]});throw Error(`unexpected: ${prompt.slice(0,80)}`);}});const result=await runAutomatic(cfg,store,g,job);assert.equal(result.ideas.length,3);assert.ok(result.ideas.every(x=>x.evidence_urls.includes('https://example.net/uncollected')));assert.ok(result.outputs.some(x=>x.endsWith('.docx')));}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('自动制作不再调用审核 Agent 判断作品资格',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'automatic',{},40);const base=makeGateway(brief([item('报告',['txt'])]));const calls=base.calls;const result=await runAutomatic(cfg,store,base,job);assert.equal(result.gate.decision,'proceed');assert.ok(!calls.some(x=>x.role==='reviewer'&&x.prompt.includes('判断当前比赛是否适合')));}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('实际 PPTX 可生成并检查越界；未知格式不伪装成功',async()=>{const {dir,store,server}=await setup();try{const work=Work.parse({kind:'slides',title:'自由布局',sources:[],slides:[{background:'FFFFFF',elements:[{text:'项目说明',x:1,y:1,w:6,h:1,fontSize:24,color:'202832',bold:true}]}]});const out=await renderWork(work,'pptx',dir);assert.equal((await readFile(out)).subarray(0,2).toString(),'PK');assert.deepEqual(deliveryFormat('海报',['png']),{format:'png',kind:'image'});assert.deepEqual(deliveryFormat('电影',['mp4']),{format:null,kind:null});const bad=Work.parse({...work,slides:[{background:'FFFFFF',elements:[{text:'越界',x:13,y:0,w:2,h:1,fontSize:20,color:'202832',bold:false}]}]});await assert.rejects(renderWork(bad,'pptx',dir),/越界/);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});
test('不把图片格式的翻译或文档格式的软件误判为已支持作品',()=>{assert.deepEqual(deliveryFormat('翻译作品',['png']),{format:null,kind:null});assert.deepEqual(deliveryFormat('软件源代码',['docx']),{format:null,kind:null});});

test('图片模型产出可被导出并叠加 Gemini 编写的文字',async()=>{const {dir,store,server}=await setup();try{const base=await sharp({create:{width:800,height:600,channels:3,background:'#336699'}}).png().toBuffer();let seen='';const g={search:async()=>[],generate:async()=>'',generateImage:async p=>{seen=p;return {data:base,mime:'image/png'}}};const out=await makeVisual(g,VisualBrief.parse({image_prompt:'校园设计',caption:'项目主题'}),'png',dir);assert.equal((await sharp(out).metadata()).width,800);assert.match(seen,/no text/i);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('纯文本 PDF 导出包含原始文字',async()=>{const {dir,store,server}=await setup();try{const work=Work.parse({kind:'text',title:'方案',text:'自动生成的作品内容。',sources:[]});const out=await renderWork(work,'pdf',dir);assert.equal((await readFile(out)).subarray(0,5).toString(),'%PDF-');const {readSource}=await import('../dist/competition/sources.js');assert.match(await readSource(out),/自动生成的作品内容/);assert.deepEqual(deliveryFormat('作品说明',['pdf']),{format:'pdf',kind:'text'});}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('软件制作调用代码执行器并使用 Gemini 文案，生成可解压的作品',async()=>{const {dir,store,server}=await setup();try{let called=0;const g={search:async()=>[],generate:async()=>'',buildProject:async(folder,prompt)=>{called++;assert.match(prompt,/所有面向用户的文字|用户可见文案/);await writeFile(join(folder,'index.html'),'<html><head><script src="copy.js"></script></head><body><main id="app"></main><script>document.getElementById("app").textContent=window.COMPETITION_COPY.title;</script></body></html>');}};const out=await makeSoftware(g,{title:'校园工具',strings:{action:'立即使用'}},{},null,'zip',dir);assert.equal(called,1);assert.equal((await readFile(out)).subarray(0,2).toString(),'PK');assert.deepEqual(deliveryFormat('软件作品',['zip']),{format:'zip',kind:'software'});assert.deepEqual(deliveryFormat('PPT',['pdf']),{format:null,kind:null});}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('独立方案生成中断后保留已完成分支并继续制作',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'automatic',{},40);const base=makeGateway(brief([item('报告',['txt'])]));const original=base.generate;let attempts=0;base.generate=async(role,prompt)=>{if(prompt.includes('为以下比赛独立提出一个作品方案')){attempts++;if(attempts===3)throw Error('临时模型故障');}return original(role,prompt);};const result=await runAutomatic(cfg,store,base,job);assert.equal(store.job(job).state,'completed');assert.equal(result.ideas.length,2);assert.equal(attempts,3);assert.ok(result.outputs.some(x=>x.endsWith('.txt')));}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('一个选题分支失败时保留其他分支并继续制作',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'automatic',{},40);const base=makeGateway(brief([item('报告',['txt'])]));const original=base.generate;let failed=false;base.generate=async(role,prompt)=>{if(!failed&&prompt.includes('本分支视角：从跨学科方法或相邻领域出发')){failed=true;throw Error('单个分支暂时不可用');}return original(role,prompt);};const result=await runAutomatic(cfg,store,base,job);assert.equal(store.job(job).state,'completed');assert.equal(result.ideas.length,2);assert.ok(result.outputs.some(x=>x.endsWith('.txt')));assert.ok(result.gaps.length>=0);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('自动流程把研究、写作和候选评审路由到不同 Agent',async()=>{const {dir,store,cfg,server,url}=await setup();try{const id=store.addCompetition(url,'赛事');const job=store.createJob(id,'automatic',{},40);const base=makeGateway(brief([item('报告',['txt'])]));const routed=[];const original=base.generate;base.generate=async(role,prompt,agent)=>{routed.push(agent||role);return original(role,prompt,agent);};await runAutomatic(cfg,store,base,job);assert.ok(routed.includes('writer'));assert.ok(routed.includes('research'));assert.ok(routed.includes('reviewer'));}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('有明确字段的官方 Word 模板可保留内容并填充；缺少字段拒绝生成',async()=>{const {dir,store,server}=await setup();try{const source=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('官方竞赛模板'),new Paragraph('项目名称：{title}'),new Paragraph('摘要：{summary}')]}]}));const template=readTemplate(source);assert.deepEqual(template.tags.sort(),['summary','title']);assert.throws(()=>template.render({title:'项目'}),/必填字段/);const result=template.render({title:'校园工具',summary:'改善办事体验'});const out=join(dir,'result.docx');await writeFile(out,result);const {readSource}=await import('../dist/competition/sources.js');const extracted=await readSource(out);assert.match(extracted,/官方竞赛模板/);assert.match(extracted,/校园工具/);assert.match(extracted,/改善办事体验/);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('往届获奖名单中出现作品线索后，会继续查找该作品的展示',async()=>{const {dir,store,cfg,server,url}=await setup('<title>2026 创意竞赛</title><p>往届名单：获奖作品“海岸守护”，团队“海蓝团队”。</p>');try{const id=store.addCompetition(url,'创意竞赛');const job=store.createJob(id,'research',{},20);let round=0;const queries=[];const g={search:async q=>{queries.push(q);return [];},generate:async(role,prompt)=>{if(prompt.includes('提出最多三个具体的后续搜索词')){round++;if(round===1)return '["创意竞赛 往届 获奖名单"]';assert.match(prompt,/海岸守护/);return '["海岸守护 海蓝团队 作品展示"]';}if(prompt.includes('读取来源并只输出一个 JSON 对象'))return JSON.stringify(brief([item('方案报告',['docx'])]));return '研究报告';}};const {runJob}=await import('../dist/workflows/workflow.js');await runJob(cfg,store,g,job);assert.ok(queries.includes('海岸守护 海蓝团队 作品展示'));assert.equal(store.searches(id).length,8);}finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}});

test('重复自动扫描已完成赛事时跳过模型调用',async()=>{const dir=await mkdtemp(join(tmpdir(),'competition-skip-'));let port=0;let modelCalls=0;const api=createServer((req,res)=>{if(req.url==='/contest'){res.setHeader('content-type','text/html');res.end('<title>创意比赛通知</title><p>提交报告。</p>');return;}if(req.url==='/api/info'){res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'2.2.0'}));return;}modelCalls++;res.statusCode=500;res.end('unexpected');});await new Promise(r=>api.listen(0,'127.0.0.1',r));port=api.address().port;const url=`http://127.0.0.1:${port}/contest`;const store=new Store(dir);const competition=store.addCompetition(url,'创意比赛通知');const job=store.createJob(competition,'automatic',{},30);store.setJob(job,'completed');store.close();try{const env={...process.env,OPENCODE_URL:`http://127.0.0.1:${port}`,COMPETE_DATA_DIR:dir};delete env.OPENCODE_PASSWORD;const {stdout}=await promisify(execFile)(process.execPath,['dist/cli.js','auto','--url',url],{cwd:process.cwd(),env,timeout:20000});assert.match(stdout,/已处理过所有候选/);assert.equal(modelCalls,0);}finally{api.close();await rm(dir,{recursive:true,force:true});}});

test('选题证据与风险进入规划提示和最终结果，不在制作节点被丢弃',async()=>{
  const {dir,store,cfg,server,url}=await setup('<p>相似作品使用了相同场景，仍需进一步区分机制。</p>');
  try{
    const id=store.addCompetition(url,'赛事'),job=store.createJob(id,'automatic',{},40);const g=makeGateway(brief([item('报告',['txt'])]));const original=g.generate;let sawPlan=false;
    g.search=async q=>q.includes('竞赛 获奖作品')?[{url:`${url}?novelty=1`,title:'相似作品',snippet:'不用于证据'}]:[];
    g.generate=async(role,prompt)=>{
      if(prompt.includes('任务：候选比较')){assert.match(prompt,/相似作品使用了相同场景/);return JSON.stringify({selected:2,analysis:'选择方案2，但验证尚未完成',similarity_risks:['方案2需要补充差异化验证']});}
      if(prompt.includes('拆解成可以实际制作的文件任务')){sawPlan=true;assert.match(prompt,/方案2需要补充差异化验证/);throw Error('规划离线');}
      if(prompt.includes('请针对这项比赛的指定交付物直接创作'))assert.match(prompt,/方案2需要补充差异化验证/);
      return original(role,prompt);
    };
    const result=await runAutomatic(cfg,store,g,job);assert.equal(sawPlan,true);assert.equal(result.choice.selected,2);assert.match(result.gaps.join(' '),/方案2需要补充差异化验证/);
    const final=JSON.parse(await readFile(result.outputs.at(-1),'utf8'));assert.match(final.gaps.join(' '),/方案2需要补充差异化验证/);
  }finally{server.close();store.close();await rm(dir,{recursive:true,force:true});}
});
