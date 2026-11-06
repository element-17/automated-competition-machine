import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { Brief } from '../dist/core/types.js';
import { parseBounds, fixedFileName, measureArtifact, checkDelivery, checkLimits } from '../dist/artifacts/delivery-checks.js';
import { evaluateSuite } from '../dist/core/evaluation.js';
import { renderWork, Work } from '../dist/artifacts/artifacts.js';

test('确定性规则只解析完整且无歧义的数值限制',()=>{
  assert.deepEqual(parseBounds('不少于10页','页'),{minimum:10});assert.deepEqual(parseBounds('2～5页','页'),{minimum:2,maximum:5});
  assert.equal(parseBounds('正文10页，附录不限','页'),null);assert.equal(parseBounds('至少10页以内','页'),null);
  assert.equal(fixedFileName('文件名为 report.txt'),'report.txt');assert.equal(fixedFileName('学校_姓名.txt'),null);assert.equal(fixedFileName('../report.txt'),null);
  assert.equal(fixedFileName('CON.txt'),null);
  assert.equal(checkLimits(['摘要200字，全文3000字'],[])[0].status,'unverified');
});

test('从导出文件测量正文和文件体积，命名与数量不会被模型意见覆盖',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'delivery-measure-'));try{
    const path=join(dir,'report.txt');await writeFile(path,'标题\n甲乙丙丁。\n');const metric=await measureArtifact(path);assert.equal(metric.characters,7);
    const item=Brief.parse({title:'测试',deliverables:[{type:'报告',formats:['txt'],quantity:'2份',naming:'report.txt',limits:['含标点不含空白字符数：不少于10字','文件大小不超过1KB']}]}).deliverables[0];
    const checks=checkDelivery(item,[metric]);assert.equal(checks.find(c=>c.id==='quantity').status,'failed');assert.equal(checks.find(c=>c.id==='naming').status,'passed');
    assert.equal(checks.find(c=>c.id==='limit-1').status,'failed');assert.equal(checks.find(c=>c.id==='limit-2-1').status,'passed');
    assert.equal(checkLimits(['字数不超过1000字'],[metric])[0].status,'unverified');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('页数读取实际 PPTX，附件检查读取实际压缩包目录',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'delivery-pages-'));try{
    const file=await renderWork(Work.parse({kind:'slides',title:'演示',slides:[{elements:[{text:'第一页',x:1,y:1,w:4,h:1}]}]}),'pptx',dir);
    const m=await measureArtifact(file);assert.equal(m.pages,1);assert.equal(checkLimits(['至少2页'],[m])[0].status,'failed');
    const zip=new JSZip();zip.file('材料/承诺书.txt','签名待填写');const path=join(dir,'作品.zip');await writeFile(path,await zip.generateAsync({type:'nodebuffer'}));
    const item=Brief.parse({title:'测试',deliverables:[{type:'作品',formats:['zip'],attachments:['承诺书.txt','调查数据.csv']}]}).deliverables[0];
    const checks=checkDelivery(item,[await measureArtifact(path)]);assert.equal(checks.find(c=>c.id==='attachment-1').status,'passed');assert.equal(checks.find(c=>c.id==='attachment-2').status,'failed');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('离线评估对同一规则比较实际文件，区分机械检查和作品质量',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'delivery-eval-'));try{
    await writeFile(join(dir,'report.txt'),'真实文件');const path=join(dir,'case.json'),out=join(dir,'result.json');
    const suite={cases:[{id:'same-rules',brief:{title:'比赛',deliverables:[{type:'报告',formats:['txt'],quantity:'1份',naming:'report.txt'}]},runs:[{name:'valid',files:[{deliverable:0,path:'report.txt'}]},{name:'missing',files:[]}]}]};
    await writeFile(path,JSON.stringify(suite));const report=await evaluateSuite(path,out);assert.equal(report.cases[0].runs[0].status,'mechanical_checks_passed');assert.equal(report.cases[0].runs[1].status,'failed');
    assert.match(report.scope,/不评判真实性/);assert.deepEqual(JSON.parse(await readFile(out,'utf8')),report);
    suite.cases[0].runs[0].files[0].path='../outside.txt';await writeFile(path,JSON.stringify(suite));await assert.rejects(evaluateSuite(path),/超出案例目录/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
