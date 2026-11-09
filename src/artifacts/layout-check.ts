/** 排版审查：用 officecli 把 docx 渲染成真实页面，交给排版 Agent 看图，只找肉眼可见的版面缺陷。 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ModelGateway } from '../core/types.js';
import { parseJSON } from '../core/gateway.js';
import { isJobControlError } from '../core/job-control.js';
import { budgetError } from '../workflows/shared.js';

const exec=promisify(execFile);
const officecli=()=>process.env.COMPETE_OFFICECLI||'officecli';
const Layout=z.object({issues:z.array(z.string()).default([]),suggestions:z.array(z.string()).default([])});
export type LayoutReport={issues:string[];suggestions:string[];checked:number};

/** officecli 是否可用；不可用时跳过排版审查，不影响其余验收。 */
export async function officeAvailable():Promise<boolean>{try{await exec(officecli(),['--version'],{timeout:15_000,windowsHide:true});return true;}catch{return false;}}
/** 渲染单页为 PNG；页码超出或渲染失败返回 null。 */
async function shot(file:string,page:number,out:string):Promise<Buffer|null>{try{await exec(officecli(),['view',file,'screenshot','--page',String(page),'-o',out],{timeout:90_000,windowsHide:true,maxBuffer:4_000_000});const data=await readFile(out);return data.length?data:null;}catch{return null;}}

const rubric=`你是文档排版审查员，现在看到的是 Word 文档渲染后的真实页面。只指出肉眼可见、会影响阅读的版面缺陷：Markdown 表格符号（竖线、横线）被当成普通文字显示而没有变成表格；单独成行的分隔线或代码围栏符号；星号、井号等未转换的 Markdown 标记；标题层级在字号和缩进上明显不连贯；文字溢出、重叠或被截断；图片缺失、位置错乱或没有图题；同类元素样式明显不统一。不评价内容质量，不因措辞、标点或个人偏好提意见。每条写清楚现象和改法，最多 5 条，没有缺陷时 issues 为空数组。只输出 JSON {"issues":["阻塞版面缺陷"],"suggestions":["可选改进"]}。`;

/** 抽检若干页并汇总问题；没有看图能力、officecli 不可用或全部页面取不到时返回 null。 */
export async function checkLayout(gateway:ModelGateway,file:string,pages:number[]=[1,2,3,5,8]):Promise<LayoutReport|null>{
  if(!gateway.inspectImage||!(await officeAvailable()))return null;
  const sharp=(await import('sharp')).default;const dir=await mkdtemp(join(tmpdir(),'layout-'));
  const issues:string[]=[],suggestions:string[]=[],seen=new Set<string>();let checked=0;
  try{
    for(const page of pages){
      const png=await shot(file,page,join(dir,`p${page}.png`));if(!png)continue;
      const hash=createHash('sha1').update(png).digest('hex');if(seen.has(hash))continue;seen.add(hash);
      const jpeg=await sharp(png).jpeg({quality:85}).toBuffer();
      try{
        const v=Layout.parse(parseJSON(await gateway.inspectImage(`${rubric}\n这是文档的第 ${page} 页。`,{data:jpeg,mime:'image/jpeg'},'layout')));
        checked++;issues.push(...v.issues.map(x=>`第 ${page} 页：${x}`));suggestions.push(...v.suggestions.map(x=>`第 ${page} 页：${x}`));
      }catch(e){if(isJobControlError(e)||budgetError(e))throw e;}
    }
  }finally{await rm(dir,{recursive:true,force:true});}
  return checked?{issues:[...new Set(issues)],suggestions:[...new Set(suggestions)],checked}:null;
}
