import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Brief } from './types.js';
import { checkDelivery, measureArtifact, type ArtifactMetrics } from '../artifacts/delivery-checks.js';
import { atomicWriteJson } from '../workflows/task-receipts.js';

const Suite=z.object({cases:z.array(z.object({id:z.string().min(1),brief:Brief,runs:z.array(z.object({
  name:z.string().min(1),files:z.array(z.object({deliverable:z.number().int().nonnegative(),path:z.string().min(1)})),
  usage:z.object({model:z.string().optional(),budget:z.number().nonnegative().optional(),modelCalls:z.number().int().nonnegative().optional(),elapsedMs:z.number().nonnegative().optional(),manualReviewMinutes:z.number().nonnegative().optional()}).optional(),
})).min(1)})).min(1)});

/** 同一 brief 检查不同执行器的真实产物；只报告机械约束，不推断作品质量。 */
export async function evaluateSuite(path:string,output?:string){
  const suite=Suite.parse(JSON.parse(await readFile(path,'utf8')));const root=await realpath(dirname(resolve(path)));
  const cases=[];
  for(const scenario of suite.cases){
    if(!scenario.brief.deliverables.length)throw Error(`${scenario.id} 没有定义交付要求`);
    const runs=[];
    for(const run of scenario.runs){
      const grouped=new Map<number,ArtifactMetrics[]>();const errors:string[]=[];const seen=new Set<string>();
      for(const file of run.files){
        if(file.deliverable>=scenario.brief.deliverables.length)throw Error(`${scenario.id}/${run.name} 的交付物编号超出范围`);
        if(isAbsolute(file.path))throw Error('评估文件必须使用相对案例目录的路径');
        const full=resolve(root,file.path),rel=relative(root,full);
        if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw Error('评估文件不能超出案例目录');
        try{
          const actual=await realpath(full),realRelative=relative(root,actual);
          if(!realRelative||realRelative==='..'||realRelative.startsWith(`..${sep}`)||isAbsolute(realRelative))throw Error('评估文件的实际路径超出案例目录');
          if(seen.has(actual))throw Error('同一文件重复计入交付物');seen.add(actual);
          const metrics=await measureArtifact(actual);metrics.path=full;const files=grouped.get(file.deliverable)||[];files.push(metrics);grouped.set(file.deliverable,files);
        }catch(e){errors.push(`${file.path}：${e instanceof Error?e.message:String(e)}`);}
      }
      const deliveries=scenario.brief.deliverables.map((item,index)=>{
        const metrics=grouped.get(index)||[];const checks=checkDelivery(item,metrics);
        return {deliverable:index,type:item.type,checks,metrics};
      });
      const checks=deliveries.flatMap(d=>d.checks);const counts={passed:checks.filter(c=>c.status==='passed').length,failed:checks.filter(c=>c.status==='failed').length,unverified:checks.filter(c=>c.status==='unverified').length};
      runs.push({name:run.name,usage:run.usage||null,status:errors.length||counts.failed?'failed':counts.unverified?'needs_review':'mechanical_checks_passed',counts,errors,deliveries});
    }
    cases.push({id:scenario.id,runs});
  }
  const report={version:1,scope:'仅比较相同规则下的实际文件与可测量约束；不评判真实性、原创性、视觉、交互或总体质量。usage 是使用者填报数据，未经本命令验证。',cases};
  if(output)await atomicWriteJson(output,report);
  return report;
}
