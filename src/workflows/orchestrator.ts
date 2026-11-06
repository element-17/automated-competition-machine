import { assertJobCanRun, controlledGateway, isJobControlError } from '../core/job-control.js';
/**
 * 作品制作的中心调度：规划 Agent 把交付物拆成带验收标准的文件任务（结构化计划），
 * 代码按产物类型把任务分派给固定的执行 Agent，评审 Agent 逐项验收，不通过则带意见返工。
 * 控制流、路由、预算和验收关卡都在代码里，模型只负责规划、制作和评审本身。
 */
import { mkdir, writeFile, readFile, rename, cp, lstat } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';
import type { AppConfig } from '../core/config.js';
import { executionSettings } from '../core/config.js';
import { saveJobProgress, type JobProgress } from '../core/job-progress.js';
import type { Store } from '../core/store.js';
import type { Brief, ModelGateway } from '../core/types.js';
import { parseJSON } from '../core/gateway.js';
import { modelLabel } from '../agents/models.js';
import type { AgentName } from '../agents/prompts.js';
import { Work, renderWork, validateWork } from '../artifacts/artifacts.js';
import { buildSoftware, softwareDigest } from '../artifacts/software.js';
import { BrowserReport, BrowserSuite, browserAvailability, inspectSoftware, softwareArtifactDigest } from '../artifacts/browser-checks.js';
import { VisualBrief, makeVisual } from '../artifacts/visual.js';
import { downloadTemplate, readTemplate, saveTemplateFile } from '../artifacts/templates.js';
import { previewSlides } from '../artifacts/preview.js';

import { Guard, Idea, budgetError, errorHead, contents, record, cached, type DeliverableResult, type DeliverableStatus } from './shared.js';
import { createSupportingArtifact } from '../artifacts/supporting.js';
import { discoverFormats } from './formats.js';
import { atomicWriteJson, checkTaskReceipt, createTaskReceipt, taskInputHash, type TaskReceipt } from './task-receipts.js';
import { checkDelivery, checkLimits, fixedFileName, measureArtifact, parseBounds, type RequirementCheck } from '../artifacts/delivery-checks.js';
export { Guard, Idea, contents, record, cached, type DeliverableResult, type DeliverableStatus };
const Original=z.object({url:z.string().nullable(),text:z.string().nullable(),reason:z.string()});

const message=(e:unknown)=>e instanceof Error?e.message:String(e);
/** 预算耗尽或模型接口失败时中止任务，保留检查点，修复后可恢复；其余错误在任务内处理。 */
const fatal=(m:string)=>/预算|上限|调用失败/.test(errorHead(m));
/** 配置类错误重试无意义，直接降级。 */
const configError=(m:string)=>/缺少 [A-Z][A-Z0-9_]+|不支持|未下载|没有配置运行时|不支持代码 Agent/.test(m);
class Blocked extends Error {}


/** 无固定作品模板：优先使用比赛指定的可制作格式；其余显式列入缺口。 */
export function deliveryFormat(type:string, formats:string[]):{format:string|null;kind:'text'|'slides'|'software'|'image'|null} {
  const f=formats.map(x=>x.toLowerCase().replace(/^\./,'')); const joined=(f.length?f:[type.toLowerCase()]).join(' ');
  const software=/软件|代码|源码|网页|网站|程序|prototype|software|source code|web\s*app/i.test(type);
  if(software&&/\bzip\b/.test(joined))return {format:'zip',kind:'software'};
  if(software&&/\bhtml?\b/.test(joined))return {format:'html',kind:'software'};
  if(software)return {format:null,kind:null};
  const textOnly=/翻译|译文|译稿|translation|报告|文档|方案书|申报书|report|document|proposal/i.test(type);
  if(/\bpng\b/.test(joined))return textOnly?{format:null,kind:null}:{format:'png',kind:'image'};
  if(/\bjpe?g\b/.test(joined))return textOnly?{format:null,kind:null}:{format:'jpg',kind:'image'};
  if(/pptx|powerpoint|幻灯|ppt/i.test(type)&&f.length&&!/pptx|powerpoint/.test(joined))return {format:null,kind:null};
  if(/pptx|powerpoint|幻灯|ppt/.test(joined))return {format:'pptx',kind:'slides'};
  if(/docx|word/.test(joined))return {format:'docx',kind:'text'};
  if(/\bpdf\b/.test(joined))return {format:'pdf',kind:'text'};
  if(/markdown|\bmd\b/.test(joined))return {format:'md',kind:'text'};
  if(/\btxt\b|纯文本/.test(joined))return {format:'txt',kind:'text'};
  if(f.length) return {format:null,kind:null};
  if(/报告|文档|文稿|方案|翻译|译文|translation|report|document|proposal/.test(joined))return {format:'txt',kind:'text'};
  return {format:null,kind:null};
}
export function canDraftUnknownFormat(type:string,formats:string[],officialTemplate:string|null):boolean {
  return !formats.length&&!officialTemplate&&/征文|论文|文章|文稿|稿件|报告|方案|说明书|essay|paper|article|report|proposal/i.test(type)&&!/翻译|译文|译稿|translation|软件|代码|网页|视频|动画|海报|图像|图片/i.test(type);
}

/* ---------- 计划 ---------- */
export const artifactKinds=['document','translation','slides','image','software','supporting'] as const;
export type ArtifactKind=typeof artifactKinds[number];
/** 每种产物可制作的格式和固定的执行 Agent；路由不由模型临场决定。 */
export const kindFormats:Record<ArtifactKind,readonly string[]>={document:['docx','pdf','md','txt'],translation:['docx','pdf','md','txt'],slides:['pptx'],image:['png','jpg'],software:['zip','html'],supporting:['md']};
export const executors:Record<ArtifactKind,AgentName>={document:'writer',translation:'writer',slides:'writer',image:'image',software:'coder',supporting:'writer'};
const normFormat=(x:string)=>{const f=x.toLowerCase().trim().replace(/^\./,'');return f==='jpeg'?'jpg':f;};
/** 只识别明确写出的格式；公告未给格式时，不把规划器的选择当作官方要求。 */
const formatAliases:Record<string,string>={word:'docx',powerpoint:'pptx',jpeg:'jpg',markdown:'md'};
function requestedFormats(item:Brief['deliverables'][number]):string[]{
  return [...new Set(item.formats.flatMap(raw=>{
    const tokens=(raw.toLowerCase().match(/[a-z0-9]+/g)||[]).map(x=>formatAliases[x]||x);
    const known=tokens.filter(x=>Object.values(kindFormats).some(formats=>formats.includes(x)));
    return known.length?known:[normFormat(raw)];
  }))];
}

export const PlanTask=z.object({
  id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  deliverable:z.number().int().min(0),
  title:z.string().min(1).max(120),
  kind:z.enum(artifactKinds),
  format:z.string().transform(normFormat),
  instructions:z.string().min(1).max(4000),
  acceptance:z.array(z.string().min(1)).min(1).max(12),
  reason:z.string().default(''),
});
export type PlanTask=z.infer<typeof PlanTask>;
export const PlanPackage=z.object({name:z.string().min(1).max(120),deliverable:z.number().int().min(0),includes:z.array(z.string()).min(1)});
export const Plan=z.object({tasks:z.array(PlanTask).min(1).max(12),packages:z.array(PlanPackage).max(6).default([]),notes:z.array(z.string()).default([])});
export type Plan=z.infer<typeof Plan>;

/** 计划的结构外校验：Agent 与格式匹配、引用存在、每个交付物都有任务。 */
export function planProblems(plan:Plan,brief:Brief,hasSource:boolean):string[]{
  const out:string[]=[];const ids=new Set<string>();const count=Math.max(1,brief.deliverables.length);
  for(const t of plan.tasks){
    if(ids.has(t.id))out.push(`任务 id 重复：${t.id}`);ids.add(t.id);
    if(t.deliverable>=count)out.push(`任务 ${t.id} 的 deliverable ${t.deliverable} 超出交付物范围 0-${count-1}`);
    if(!kindFormats[t.kind].includes(t.format))out.push(`任务 ${t.id} 的 ${t.kind} 只能制作 ${kindFormats[t.kind].join('/')}，不能是 ${t.format}`);
    if(t.kind==='translation'&&!hasSource)out.push(`任务 ${t.id} 是翻译，但资料中没有比赛指定的原文；应改为 supporting`);
  }
  for(const p of plan.packages){
    const item=brief.deliverables[p.deliverable];
    if(item?.formats.length&&!requestedFormats(item).includes('zip'))out.push(`打包 ${p.name} 的 ZIP 不符合交付物指定格式 ${item.formats.join('/')}`);
    if(new Set(p.includes).size!==p.includes.length)out.push(`打包 ${p.name} 重复包含同一任务`);
    for(const id of p.includes){
      const task=plan.tasks.find(t=>t.id===id);
      if(!task)out.push(`打包 ${p.name} 引用了不存在的任务 ${id}`);
      else if(task.deliverable!==p.deliverable)out.push(`打包 ${p.name} 引用了其他交付物的任务 ${id}`);
    }
    if(p.deliverable>=count)out.push(`打包 ${p.name} 的 deliverable 超出范围`);
  }
  for(const t of plan.tasks){
    const item=brief.deliverables[t.deliverable];
    const packaged=plan.packages.some(p=>p.deliverable===t.deliverable&&p.includes.includes(t.id));
    if(item?.formats.length&&t.kind!=='supporting'&&!packaged&&!requestedFormats(item).includes(t.format))out.push(`任务 ${t.id} 的 ${t.format} 不符合交付物指定格式 ${item.formats.join('/')}`);
  }
  for(let i=0;i<brief.deliverables.length;i++)if(!plan.tasks.some(t=>t.deliverable===i))out.push(`交付物 ${i}（${brief.deliverables[i]!.type}）没有对应任务`);
  // 打包由代码完成；执行 Agent 拿不到其他任务的文件，"打包任务"只会产出空壳或伪造的压缩包。
  // 一个图片任务只生成一张图；验收要求多张时必须拆开，否则评审永远无法通过。
  for(const t of plan.tasks)if(t.kind==='image'&&/(交付|生成|输出|包含)\s*[2-9二三四五六七八九两]\s*张|多张/.test([t.title,t.instructions,...t.acceptance].join(' ')))out.push(`任务 ${t.id} 要求多张图片，但一个 image 任务只生成一张；请拆成每张图一个 image 任务`);
  for(const t of plan.tasks)if(/打包|压缩包|归档/.test(t.title)&&plan.tasks.some(o=>o.id!==t.id&&o.deliverable===t.deliverable&&t.instructions.includes(o.id)))out.push(`任务 ${t.id} 在打包其他任务的文件；执行 Agent 拿不到这些文件，请删除该任务，改用 packages 列出要打包的任务 id`);
  for(const [i,item] of brief.deliverables.entries()){
    if(!item.quantity||plan.tasks.some(t=>t.deliverable===i&&t.kind==='supporting'))continue;
    const bounds=parseBounds(item.quantity,'(?:份|个|件|张|套|文件)?');
    const packaged=new Set(plan.packages.flatMap(p=>p.includes));
    const count=plan.tasks.filter(t=>t.deliverable===i&&!packaged.has(t.id)).length+plan.packages.filter(p=>p.deliverable===i).length;
    if(bounds&&((bounds.minimum!==undefined&&count<bounds.minimum)||(bounds.maximum!==undefined&&count>bounds.maximum)))out.push(`交付物 ${i} 要求 ${item.quantity}，计划只有 ${count} 个最终文件`);
  }
  return out;
}

const defaultAcceptance=(item:Brief['deliverables'][number]|undefined)=>[
  `内容完整对应交付物「${item?.type||'作品'}」，不是提纲、说明或待办清单`,
  ...(item?.limits||[]),...(item?.naming?[`命名符合：${item.naming}`]:[]),
  '不含编造的数据、实验、采访、获奖或来源；需要个人信息的地方留空待填',
];
/** 规划 Agent 不可用或计划无效时的确定性计划：沿用按格式路由的规则。 */
export function fallbackPlan(brief:Brief,hasSource:boolean):Plan{
  const tasks:PlanTask[]=[];
  const add=(i:number,kind:ArtifactKind,format:string,reason='')=>{const item=brief.deliverables[i];tasks.push({id:`d${i+1}`,deliverable:i,title:item?.type||'作品',kind,format,instructions:`按比赛规则制作交付物「${item?.type||'作品'}」。${item?.limits.length?`限制：${item.limits.join('；')}`:''}`,acceptance:defaultAcceptance(item),reason});};
  if(!brief.deliverables.length){add(0,'supporting','md','公告没有明确交付物、作品格式或数量，无法确认正式投稿要求');return {tasks,packages:[],notes:['确定性计划']};}
  brief.deliverables.forEach((item,i)=>{
    const route=deliveryFormat(item.type,item.formats);const isTranslation=/translation|翻译|译文|译稿/i.test(item.type);
    if(route.kind&&route.format){
      if(isTranslation&&!hasSource)return add(i,'supporting','md','比赛指定原文未找到，不能编造原文或把其他内容冒充译文');
      const kind:ArtifactKind=route.kind==='text'?(isTranslation?'translation':'document'):route.kind;return add(i,kind,route.format);
    }
    if(canDraftUnknownFormat(item.type,item.formats,item.official_template))return add(i,'document','docx','比赛未明确格式，按 Word 文档制作');
    add(i,'supporting','md',`交付物格式 ${item.formats.join('/')||'未明确'} 暂无可用制作器`);
  });
  for(const [index,item] of brief.deliverables.entries()){
    const bounds=item.quantity?parseBounds(item.quantity,'(?:份|个|件|张|套|文件)?'):null;
    const base=tasks.find(t=>t.deliverable===index);const required=bounds?.minimum||1;
    if(!base||base.kind==='supporting'||required<=1||!Number.isInteger(required)||required>12||tasks.length+required-1>12)continue;
    for(let n=2;n<=required;n++)tasks.push({...base,id:`${base.id}-${n}`,title:`${base.title}（第 ${n} 份）`,instructions:`${base.instructions}\n这是所需 ${required} 份作品中的第 ${n} 份，按要求制作独立作品。`});
  }
  return {tasks,packages:[],notes:['确定性计划']};
}
const capabilities=`可用的制作能力（kind → 可选 format → 执行者）：
- document → docx/pdf/md/txt → 写作 Agent 撰写完整正文（论文、报告、方案书、作品说明书、承诺书等）
- translation → docx/pdf/md/txt → 写作 Agent 翻译比赛提供的原文（仅当资料中有原文）
- slides → pptx → 写作 Agent 设计并排版每页内容
- image → png/jpg → 图片模型生成一张画面，写作 Agent 设计画面和图上少量文字。图片模型画不出可读文字，image 任务的要求和验收标准里不要写编号标签、零件名、尺寸标注、图例文字，只写画面内容；需要标注的结构图用 slides 制作，在 PPT 里把图片和文字标注组合起来。一个 image 任务只产出一张图；需要多张图（主视图、爆炸图、场景图等）就拆成多个 image 任务。图片模型不擅长排大量文字，信息图、流程图、对比表这类以文字为主的版面用 slides 或 document 制作
- software → zip/html → 编码 Agent 制作可在浏览器离线运行的完整网页软件（含 README）
- supporting → md → 以上都做不了的（视频、实物硬件、音频、需要现场拍摄等），只写制作脚本/方案，作为兜底`;
const PlanRecord=z.object({plan:Plan,source:z.enum(['planner','fallback']),gaps:z.array(z.string()).default([])});
export type PlanRecord=z.infer<typeof PlanRecord>;

/** 规划 Agent 在配置的轮数内修复 schema 和交付约束，仍失败则用确定性计划。 */
export async function planWork(cfg:AppConfig,store:Store,gateway:ModelGateway,input:{jobId:string;brief:Brief;idea:Idea|null;evidence:{url:string;title:string;text:string}[];hasSource:boolean;selection?:unknown}):Promise<PlanRecord>{
  const {jobId,brief,idea,evidence,hasSource}=input;
  const key=taskInputHash({policy:3,hasSource},{brief,idea,evidence,selection:input.selection,model:modelLabel(cfg,'planner'),prompts:cfg.prompts});
  const result=await cached(cfg,store,jobId,`plan-${key}.json`,PlanRecord,modelLabel(cfg,'planner'),async()=>{
    const base=`${Guard}\n把这项比赛的参赛作品拆解成可以实际制作的文件任务。\n${capabilities}\n要求：
1. brief.deliverables 中每个交付物（下标从 0 开始）至少对应一个任务；一个交付物可以拆成多个文件，例如“参赛作品压缩包（含作品文件、原创承诺书）”应拆为作品本体（如 software 或 slides）、作品说明 document、原创承诺书 document，再用 packages 打包。打包由系统完成：不要安排“打包/压缩”任务，各任务也拿不到彼此的文件。全部任务完成后，系统还会把所有要提交的文件汇总成一个最终提交包，所以也不要安排汇总全部文件的任务。
2. 必须遵守交付物指定格式；只有 ZIP 交付物的内部文件可以使用其他格式，packages 只能包含同一 deliverable 的任务。交付物没写格式时，按赛道和评分标准选择真实产物并标明格式待确认；只有确实无法制作时才用 supporting。
3. 每个任务的 acceptance 写 2-8 条可以从产物本身检查的验收标准（内容、结构、页数/字数、命名、功能）。
4. instructions 要具体：紧扣选定方案和评分要求，写清楚要包含哪些部分/页面/功能。需要姓名、学校、签名等个人信息的地方要求留空待填。只安排要提交给主办方的文件；给作者看的待补资料清单、投稿事务清单、格式核对清单不要单独安排任务，系统会把各任务登记的待补资料自动汇总成文件交给用户。
5. 资料中${hasSource?'有':'没有'}比赛指定的翻译原文${hasSource?'':'，不能安排 translation 任务'}。
只输出 JSON：{"tasks":[{"id":"小写字母数字和-","deliverable":0,"title":"","kind":"","format":"","instructions":"","acceptance":[""],"reason":"为何这样拆"}],"packages":[{"name":"按比赛命名规则的文件名.zip","deliverable":0,"includes":["任务id"]}],"notes":[""]}
比赛档案：${JSON.stringify(brief)}\n选定方案：${JSON.stringify(idea)}\n选题比较及风险：${JSON.stringify(input.selection||null)}\n资料摘录：${JSON.stringify(evidence.slice(0,20).map(e=>({...e,text:e.text.slice(0,3000)})))}`;
    let feedback='',previousRaw='';const gaps:string[]=[];
    for(let attempt=0;attempt<executionSettings(cfg).plannerRounds;attempt++){
      const progress={stage:'planning',action:'规划交付物并核对格式与数量',round:attempt+1,maxRounds:executionSettings(cfg).plannerRounds};
      if(gateway.reportProgress)await gateway.reportProgress(progress);else await saveJobProgress(cfg.dataDir,jobId,progress);
      let raw:string;try{const response=await cached(cfg,store,jobId,`plan-${key}-attempt-${attempt+1}.json`,z.object({raw:z.string()}),modelLabel(cfg,'planner'),async()=>({raw:await gateway.generate('reviewer',feedback?`${base}\n\n上一份计划：${previousRaw}\n上一份计划有以下问题，请保留正确部分并修正后输出完整 JSON：\n${feedback}`:base,'planner')}));raw=response.raw;previousRaw=raw;}catch(e){const m=message(e);if(isJobControlError(e)||budgetError(m))throw e;gaps.push(`规划 Agent 不可用，已按格式规则生成计划：${m.slice(0,200)}`);break;}
      let plan:Plan;try{plan=Plan.parse(parseJSON(raw));}catch(e){feedback=message(e).slice(0,2000);continue;}
      const problems=planProblems(plan,brief,hasSource);if(!problems.length)return {plan,source:'planner' as const,gaps};feedback=problems.join('\n');
    }
    if(feedback)gaps.push(`规划 Agent 的计划未通过校验，已按格式规则生成计划：${feedback.slice(0,300)}`);
    return {plan:fallbackPlan(brief,hasSource),source:'fallback' as const,gaps};
  });
  await record(cfg,store,jobId,'plan.json',result,modelLabel(cfg,'planner'));
  return result;
}
/* ---------- 执行 ---------- */
type Ctx={cfg:AppConfig;store:Store;gateway:ModelGateway;jobId:string;competitionTitle:string;brief:Brief;idea:Idea|null;evidence:ReturnType<typeof contents>;sourceText:string|null;plan:Plan;inputContext:unknown;selection?:unknown;images:Record<string,{path:string;title:string;caption:string}>};
/** 一次制作的结果；reviewText 为评审可读的产物内容，null 表示无法评审（如压缩包）。 */
type Attempt={paths:string[];reviewText:string|null;notes:string[];needsInput?:string[]};
const jobDir=(ctx:Ctx)=>join(ctx.cfg.dataDir,'jobs',ctx.jobId);
const taskKey=(ctx:Ctx,task:PlanTask)=>`task-${task.id}-${taskInputHash(task,ctx.inputContext).slice(0,20)}`;
const taskFolder=(ctx:Ctx,task:PlanTask,round:number)=>join(jobDir(ctx),taskKey(ctx,task),`r${round+1}`);
const announce=(ctx:Ctx,event:JobProgress)=>{assertJobCanRun(ctx.store,ctx.jobId);return ctx.gateway.reportProgress?ctx.gateway.reportProgress(event):saveJobProgress(ctx.cfg.dataDir,ctx.jobId,event);};

async function fillTemplate(ctx:Ctx,task:PlanTask,templateRef:string,round:number,feedback:string[]):Promise<Attempt>{
  if(!['docx','pptx'].includes(task.format))throw new Blocked(`官方模板 ${task.title} 的 ${task.format} 格式无法自动保留`);
  const templateUrl=ctx.evidence.find(e=>e.url===templateRef)?.url||ctx.evidence.find(e=>/模板/.test(e.title)&&e.url.toLowerCase().split('?')[0]?.endsWith(`.${task.format}`))?.url;
  if(!templateUrl)throw new Blocked(`未找到可核对的官方模板地址：${templateRef}`);
  const template=readTemplate(await downloadTemplate(templateUrl));const Fields=z.record(z.string(),z.string());
  const fields=await cached(ctx.cfg,ctx.store,ctx.jobId,`${taskKey(ctx,task)}-r${round+1}-template-fields.json`,Fields,modelLabel(ctx.cfg,'writer'),async()=>parseJSON(await ctx.gateway.generate('writer',`${Guard}\n填写官方模板，所有文字由你撰写。严格返回 JSON 对象，键必须是这些模板字段 ${JSON.stringify(template.tags)}，值是相应文字。个人姓名、学校、电话、邮箱、证书、真实调查、实验等缺失时输出空字符串，不得编造。任务 ${JSON.stringify(task)}，比赛 ${JSON.stringify(ctx.brief)}，选题 ${JSON.stringify(ctx.idea)}，选题比较及风险 ${JSON.stringify(ctx.selection||null)}，资料 ${JSON.stringify(ctx.evidence)}，原文 ${JSON.stringify(ctx.sourceText)}。返工意见 ${JSON.stringify(feedback)}`)));
  const empty=template.tags.filter(tag=>!fields[tag]?.trim());if(empty.length)throw new Blocked(`官方模板缺少真实信息：${empty.join('、')}`);
  const out=await saveTemplateFile(template.render(fields),task.format as 'docx'|'pptx',taskFolder(ctx,task,round));
  return {paths:[out],reviewText:JSON.stringify(fields),notes:[`官方模板 ${task.title} 已按可识别字段填写，仍需检查版式和字段`]};
}

/** 制作要求和验收标准里的目标字数（取最大的下限），如“8000–12000字”“不少于1.5万字”。 */
export function targetLength(task:{instructions:string;acceptance:string[]}):number{
  let best=0;for(const m of [task.instructions,...task.acceptance].join(' ').matchAll(/(\d+(?:\.\d+)?)\s*(万)?\s*(?:[-–—~～至到]\s*\d+(?:\.\d+)?\s*万?\s*)?字/g)){const n=Number(m[1])*(m[2]?10000:1);if(n>best)best=n;}
  return best;
}
/** 长文一次生成容易写短、各章深浅不一，超过这个字数就先列大纲再逐章写。 */
export const longDocumentChars=6000;
const Outline=z.object({title:z.string().min(1),facts:z.array(z.string()).default([]),sections:z.array(z.object({heading:z.string().min(1),points:z.array(z.string()).default([]),chars:z.number().int().min(200).max(6000).default(1500),rewrite:z.boolean().default(true)})).min(2).max(10),needs_input:z.array(z.string()).default([])});
const Sections=z.object({outline:Outline,texts:z.array(z.string())});
/** 分章写作：大纲一次调用，每章一次调用；返工时只重写评审意见涉及的章节，其余沿用上一版。 */
async function writeLong(ctx:Ctx,task:PlanTask,round:number,feedback:string[],head:string,facts:string,target:number):Promise<Work>{
  const label=modelLabel(ctx.cfg,'writer');const key=`${taskKey(ctx,task)}-r${round+1}`;
  let previous:z.infer<typeof Sections>|null=null;
  if(round>0){try{previous=Sections.parse(JSON.parse(await readFile(join(jobDir(ctx),`${taskKey(ctx,task)}-r${round}-sections.json`),'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'&&!(e instanceof SyntaxError)&&!(e instanceof z.ZodError))throw e;}}
  const feedbackText=feedback.length?`上一版未通过评审，必须解决：\n${feedback.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n`:'';
  const outline=await cached(ctx.cfg,ctx.store,ctx.jobId,`${key}-outline.json`,Outline,label,async()=>parseJSON(await ctx.gateway.generate('writer',`${head}\n这份作品要求约 ${target} 字以上，分章写作。先只输出大纲 JSON：{"title":"作品标题","facts":["全文统一使用的关键参数和设定，每条写成“名称：取值”，如尺寸、材料、零件数、角度、时间、价格、样本量"],"sections":[{"heading":"## 章节标题","points":["本章要写清楚的要点"],"chars":本章目标字数,"rewrite":true}],"needs_input":[]}。sections 4-8 个，chars 之和不少于 ${target}，按评分要点分配篇幅。facts 是各章共用的唯一事实来源：各章写到这些量时必须用同一个值，所以要把核心机构、结构、材料、工艺、验证方案涉及的参数都列进去。返工时若评审指出参数前后不一致，在 facts 里定下统一的值。${previous?`这是返工：只把需要按评审意见修改的章节标 rewrite:true，其余章节保持标题不变并标 false。上一版大纲及各章开头：${JSON.stringify({outline:previous.outline,excerpts:previous.texts.map(t=>t.slice(0,300))})}`:''}\n${feedbackText}${facts}`)));
  const Text=z.object({text:z.string().min(1)});const texts:string[]=[];
  for(const [i,s] of outline.sections.entries()){
    const old=previous?previous.outline.sections.findIndex(p=>p.heading===s.heading):-1;const oldText=old>=0?previous!.texts[old]:undefined;
    if(!s.rewrite&&oldText){texts.push(oldText);continue;}
    const r=await cached(ctx.cfg,ctx.store,ctx.jobId,`${key}-section-${i+1}.json`,Text,label,async()=>({text:(await ctx.gateway.generate('writer',`${head}\n分章写作：现在只写第 ${i+1}/${outline.sections.length} 章。直接输出这一章的 Markdown 正文，以「${s.heading}」开头；不要 JSON，不要写其他章。参考文献只列资料中实际出现、可核对的文献或标准，不要凭记忆写期刊卷期页码；没有可核对的文献时少列或不列。本章约 ${s.chars} 字，要有实质论证、机制细节和具体内容，不要写成要点罗列。缺真实资料的地方写【待补充：要什么】。证据中 kind 为 user 的条目是用户提供的真实资料，直接使用。\n全文统一参数（必须严格使用这些值，不要另写不同的数值，也不要引入这里没有的新零件或新工艺）：${JSON.stringify(outline.facts)}\n全文大纲：${JSON.stringify(outline.sections.map(x=>({heading:x.heading,points:x.points})))}\n本章要点：${JSON.stringify(s.points)}\n${texts.length?`上一章结尾（保持衔接，不要重复）：${texts.at(-1)!.slice(-600)}\n`:''}${oldText?`本章上一版（在此基础上按评审意见改写）：${oldText}\n`:''}${feedbackText}${facts}`)).replace(/^```(?:markdown|md)?\s*/i,'').replace(/\s*```$/,'').trim()}));
    texts.push(/^#/.test(r.text)?r.text:`${s.heading.startsWith('#')?s.heading:`## ${s.heading}`}\n\n${r.text}`);
  }
  await atomicWriteJson(join(jobDir(ctx),`${key}-sections.json`),{outline,texts});
  const text=texts.join('\n\n');const marks=[...text.matchAll(/【待补充[:：]\s*([^】]+)】/g)].map(m=>m[1]!.trim());
  return Work.parse({kind:'text',title:outline.title,text,sources:[],needs_input:[...new Set([...outline.needs_input,...marks])]});
}

async function writeWork(ctx:Ctx,task:PlanTask,round:number,feedback:string[]):Promise<Attempt>{
  const slides=task.kind==='slides';const item=ctx.brief.deliverables[task.deliverable];
  const needs='"needs_input":["只有用户才能提供的资料，写清要什么、用在作品哪里"]';
  // 同一作品中已生成的图片可直接放进 PPT；写作模型只引用 id，路径由程序填入。
  const imageList=Object.entries(ctx.images).map(([ref,x])=>({ref,title:x.title,caption:x.caption}));
  const imageSpec=imageList.length?`可用的已生成图片（用 {"type":"image","ref":"图片 ref","x":0,"y":0,"w":6,"h":4} 放进页面，程序按原比例缩放到框内）：${JSON.stringify(imageList)}。展示外观、结构、场景、流程的页面应放入对应图片，不要只写图片文件名或“此处放图”；图片和文字不要重叠。`:'目前没有可用的已生成图片，不要使用 image 元素。';
  const spec=slides?`输出 JSON {"kind":"slides","title":"","sources":[],${needs},"slides":[{"background":"FFFFFF","elements":[{"type":"text|rect|ellipse|line|image","text":"文字元素内容，其他元素可为空","x":0,"y":0,"w":5,"h":1,"fontSize":24,"color":"202832","fill":"可选六位色值","bold":false}]}]}；每个 type 只选一个值。页面宽13.333英寸高7.5英寸，元素自行布局，文本框不要重叠或溢出。${imageSpec}`
    :`输出 JSON {"kind":"text","title":"","text":"完整作品正文","sources":[],${needs}}。正文可以用 Markdown 标题（#、##、###）、列表和 **加粗**，导出时会转换成文档样式。`;
  let previous:unknown=null;
  if(round>0){for(const suffix of ['-repair','']){try{previous=JSON.parse(await readFile(join(jobDir(ctx),`${taskKey(ctx,task)}-r${round}${suffix}.json`),'utf8'));break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}}
  const prompt=`${Guard}\n请针对这项比赛的指定交付物直接创作。所有参赛文字由你撰写，不使用固定模板。只能依据给定来源和真实原文，不虚构数据、采访、实验和来源。不要防御性写作：设计方案、结构、参数和验证计划都作为作品内容肯定地写，不逐句加“设计假设”“待核实”“仅供参考”等免责声明。只有需要真实外部资料的地方（统计数据、价格、调研、照片、测试记录、作者和学校等个人信息）才在正文对应位置写【待补充：要什么】，并把每一项写进 needs_input，系统会汇总成单独文件向用户索要。证据中 kind 为 user 的条目是用户亲自提供的真实资料，可以直接作为事实使用，用来替换相应的【待补充】，不要再向用户索要。${task.kind==='translation'?'本任务是翻译：忠实、完整地翻译比赛提供的原文，不增删内容。':''}${spec}\n这是第 ${round+1} 轮，请保留上一版已正确的内容并解决反馈，返回完整作品。上一版作品：${JSON.stringify(previous)}
${feedback.length?`上一版未通过评审，必须逐条解决：\n${feedback.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n`:''}任务：${task.title}\n制作要求：${task.instructions}\n验收标准：${JSON.stringify(task.acceptance)}\n规则 ${JSON.stringify(ctx.brief)}\n本项交付物 ${JSON.stringify(item||null)}\n选题 ${JSON.stringify(ctx.idea)}\n选题比较及风险 ${JSON.stringify(ctx.selection||null)}\n证据 ${JSON.stringify(ctx.evidence)}\n比赛提供的原文 ${JSON.stringify(ctx.sourceText)}`;
  // 分章写作复用同一份写作约定（spec 之前的部分）和任务资料；每章只带精简后的证据，控制调用成本。
  const target=!slides&&task.kind!=='translation'?targetLength(task):0;
  const head=prompt.slice(0,prompt.indexOf(spec));
  const facts=`任务：${task.title}
制作要求：${task.instructions}
验收标准：${JSON.stringify(task.acceptance)}
规则 ${JSON.stringify(ctx.brief)}
本项交付物 ${JSON.stringify(item||null)}
选题 ${JSON.stringify(ctx.idea)}
证据 ${JSON.stringify(ctx.evidence.map(e=>({...e,text:e.text.slice(0,3000)})))}`;
  const label=modelLabel(ctx.cfg,'writer');const want=slides?'slides':'text';
  let work=await cached(ctx.cfg,ctx.store,ctx.jobId,`${taskKey(ctx,task)}-r${round+1}.json`,Work,label,async()=>target>=longDocumentChars?writeLong(ctx,task,round,feedback,head,facts,target):parseJSON(await ctx.gateway.generate('writer',prompt)));
  if(work.kind!==want)throw Error(`写作模型返回类型 ${work.kind} 与要求 ${want} 不符`);
  const layout=validateWork(work,slides?imagePaths(ctx):undefined);if(layout.length)work=await cached(ctx.cfg,ctx.store,ctx.jobId,`${taskKey(ctx,task)}-r${round+1}-repair.json`,Work,label,async()=>parseJSON(await ctx.gateway.generate('writer',`${prompt}\n自动检查未通过，请修复这些问题并仅输出完整作品 JSON：${JSON.stringify(layout)}\n需要修复的作品：${JSON.stringify(work)}`)));
  const folder=taskFolder(ctx,task,round);const out=await renderWork(work,task.format,folder,'submission',imagePaths(ctx));const notes:string[]=[];
  if(slides){const preview=await previewSlides(out,work.slides!.length);await record(ctx.cfg,ctx.store,ctx.jobId,`task-${task.id}-preview.json`,preview,null);if(preview.status==='rendered'){for(const page of preview.pages)ctx.store.artifact(ctx.jobId,'slide-preview',page,null);}else notes.push(`${task.title} 无法渲染预览：${preview.reason}`);}
  const reviewText=slides?JSON.stringify(work.slides!.map((s,i)=>({page:i+1,text:s.elements.filter(e=>e.type==='text').map(e=>e.text),images:s.elements.filter(e=>e.type==='image').map(e=>ctx.images[e.ref!]?.title||e.ref)}))):`# ${work.title}\n\n${work.text}`;
  return {paths:[out],reviewText,notes,needsInput:work.needs_input};
}

const imagePaths=(ctx:Ctx)=>Object.fromEntries(Object.entries(ctx.images).map(([ref,x])=>[ref,x.path]));
async function drawImage(ctx:Ctx,task:PlanTask,round:number,feedback:string[]):Promise<Attempt>{
  const visual=await cached(ctx.cfg,ctx.store,ctx.jobId,`${taskKey(ctx,task)}-r${round+1}-brief.json`,VisualBrief,modelLabel(ctx.cfg,'writer'),async()=>parseJSON(await ctx.gateway.generate('writer',`${Guard}\n根据赛事要求和选题，设计一张独特的图片作品。只输出 JSON {"image_prompt":"无文字的图像画面描述","caption":"由你撰写的简短图题或空字符串","caption_mode":"band"}。图片模型只画画面、不画文字；caption 会由程序排在画面下方的独立色带里，不会遮挡画面。只有海报类作品确实需要文字压在画面上时才用 "caption_mode":"overlay"，并给出 caption_x、caption_y（0-1 比例）把文字放在画面空白处。一张图只画一个画面，不要拼成多格。不得伪造照片或事实。${feedback.length?`上一版评审意见（必须解决）：${JSON.stringify(feedback)}`:''}任务 ${JSON.stringify(task)} 要求 ${JSON.stringify(ctx.brief)} 选题 ${JSON.stringify(ctx.idea)} 选题比较及风险 ${JSON.stringify(ctx.selection||null)}`)));
  const out=await makeVisual(ctx.gateway,visual,task.format as 'png'|'jpg',taskFolder(ctx,task,round));
  return {paths:[out],reviewText:`画面设计说明：${JSON.stringify(visual)}`,notes:[]};
}

async function buildApp(ctx:Ctx,task:PlanTask,round:number,feedback:string[]):Promise<Attempt>{
  const folder=taskFolder(ctx,task,round);
  if(round>0){
    const previous=join(taskFolder(ctx,task,round-1),'workspace'),workspace=join(folder,'workspace');
    try{await lstat(workspace);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;try{await cp(previous,workspace,{recursive:true,filter:async path=>{const name=path.split(/[\\/]/).at(-1)!;const info=await lstat(path);return !name.startsWith('.')&&name!=='node_modules'&&!info.isSymbolicLink();}});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  }
  const out=await buildSoftware(ctx.gateway,{brief:{...ctx.brief,selection:ctx.selection},idea:ctx.idea,task,feedback},task.format as 'zip'|'html',folder);
  return {paths:[out],reviewText:await softwareDigest(folder),notes:[]};
}

async function produce(ctx:Ctx,task:PlanTask,round:number,feedback:string[]):Promise<Attempt>{
  const template=ctx.brief.deliverables[task.deliverable]?.official_template;
  if(template&&(task.kind==='document'||task.kind==='slides'))return fillTemplate(ctx,task,template,round,feedback);
  if(task.kind==='image')return drawImage(ctx,task,round,feedback);
  if(task.kind==='software')return buildApp(ctx,task,round,feedback);
  return writeWork(ctx,task,round,feedback);
}
/* ---------- 验收 ---------- */
const Verdict=z.object({pass:z.boolean().optional(),visual:z.boolean().optional(),issues:z.array(z.string()).default([]),suggestions:z.array(z.string()).default([]),needs_input:z.array(z.string()).default([])}).transform(v=>({...v,pass:v.issues.length===0}));
export type Verdict=z.infer<typeof Verdict>;
const RoundRecord=z.object({attempt:z.object({paths:z.array(z.string()).min(1),reviewText:z.string().nullable(),notes:z.array(z.string()),needsInput:z.array(z.string()).optional()}),receipt:z.unknown(),review:Verdict.optional(),browser:BrowserReport.optional()});
/** 同一任务复用首轮的验收用例，避免返工时偷偷降低预期来通过测试。 */
async function browserVerify(ctx:Ctx,task:PlanTask,round:number,artifact:string):Promise<BrowserReport>{
  const suiteFile=`${taskKey(ctx,task)}-browser-suite.json`;let suite:BrowserSuite|undefined,problem:string|undefined;
  if(browserAvailability().available){
    try{
      const saved=await cached(ctx.cfg,ctx.store,ctx.jobId,suiteFile,z.object({raw:z.string()}),modelLabel(ctx.cfg,'reviewer'),async()=>({raw:await ctx.gateway.generate('reviewer',`${Guard}\n为实际网页交付物设计浏览器验收用例。只输出 JSON {"cases":[{"name":"具体操作及结果","criterion":0,"steps":[{"action":"fill","selector":"#input","value":"示例输入"},{"action":"click","selector":"#submit"}],"expect":[{"selector":"#result","text":"预期结果"}]}]}。criterion 对应验收标准的零起始序号。最多6个用例，每个最多6步及6个断言；每个用例独立从首页开始。步骤只允许 click/fill/select/check，必须用实际文件存在的 CSS 选择器。断言可用 text（包含文字）、value（输入值相等）、visible（布尔），必须验证操作的预期结果，不能只确认按钮存在。依据任务要求决定正确结果，不能把错误实现当成正确答案；不提交 JS、URL、shell 或外部调用。涉及人工视觉、实测数据等无法自动核验的标准不要伪造用例。没有可验证用例时 cases 为空。\n任务：${JSON.stringify(task)}\n实际交付文件：${await softwareArtifactDigest(artifact)}`,'reviewer')}));
      suite=BrowserSuite.parse(parseJSON(saved.raw));
      if(suite.cases.some(c=>c.criterion>=task.acceptance.length))throw Error('浏览器用例引用不存在的验收标准');
    }catch(e){if(isJobControlError(e)||budgetError(e))throw e;problem=`关键操作用例不可用：${message(e).slice(0,300)}`;suite=undefined;}
  }
  await announce(ctx,{stage:'browser',action:`${task.title}：运行浏览器检查与关键操作`,taskId:task.id,round:round+1,maxRounds:executionSettings(ctx.cfg).productionRounds});
  const report=await inspectSoftware(artifact,join(taskFolder(ctx,task,round),'browser'),suite);
  const covered=new Set(report.cases.filter(c=>c.status==='passed').map(c=>c.criterion));
  const missing=task.acceptance.filter((_,i)=>!covered.has(i));
  if(missing.length||problem){if(report.status==='passed')report.status='unverified';report.issues.push(...(problem?[problem]:[]),...missing.map(c=>`尚未通过自动交互用例验证：${c}`));}
  await atomicWriteJson(report.reportPath,report);ctx.store.artifact(ctx.jobId,'browser-report',report.reportPath,null);for(const path of report.screenshots)ctx.store.artifact(ctx.jobId,'browser-screenshot',path,null);
  return report;
}
/** 评审 Agent 对照验收标准检查产物；图片任务让评审看实际画面。评审不可用时返回 null（产物保留，标记未评审）。 */
async function verify(ctx:Ctx,task:PlanTask,attempt:Attempt):Promise<Verdict|null>{
  const reviewText=attempt.reviewText||'';
  const rubric=`阻塞问题（issues）只包括：只有提纲或说明、没有实质作品内容；核心部分缺失或明显单薄；论证有硬伤或前后矛盾；编造实验、测试结果、采访、获奖或参考文献；违反赛事硬性规则；专业水准明显不足、难以拿奖。
建议（suggestions）放：措辞、标点、章节编号、标题层级、格式、占位写法、数据有没有标来源、表述够不够严谨等细枝末节，以及可选的润色方向。建议不影响通过。不要建议增加“设计假设”“待核实”之类的标注或免责声明，也不要建议把肯定的表述改成“预期可”“设计目标为”“拟”之类的弱化说法，设计参数和方案直接陈述即可；【待补充】标记由系统统一处理，不要建议改写它们。
需向用户索要的资料（needs_input）放：只有用户才能提供、模型无法核实的资料，如个人信息、实测数据、照片、调研结果、真实价格。缺这些不是作品缺陷，不要写进 issues，也不要要求作者在正文里加免责声明。
只输出 JSON {"issues":["阻塞问题，写清位置、问题和改法"],"suggestions":["建议"],"needs_input":["需要用户提供的资料及用途"]}；没有阻塞问题时 issues 为空数组，即为通过。issues 最多 6 条、suggestions 最多 5 条，每条不超过 150 字，按严重程度排序。\n任务：${task.title}（${task.kind}/${task.format}）\n制作要求：${task.instructions}\n验收标准：${JSON.stringify(task.acceptance)}\n比赛档案：${JSON.stringify(ctx.brief)}`;
  const parse=async(raw:Promise<string>)=>Verdict.parse(parseJSON(await raw));
  try{
    if(task.kind==='image'&&ctx.gateway.inspectImage&&attempt.paths[0]){
      // 看图评审：画面质量问题（主体错误、拼成多格、文字遮挡或乱码、水印、虚构品牌、明显不专业）是阻塞问题。
      const sharp=(await import('sharp')).default;const data=await sharp(attempt.paths[0]).resize({width:1536,height:1536,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
      try{const v=await parse(ctx.gateway.inspectImage(`${Guard}\n你是独立作品验收评审，现在看到的是实际生成的图片。像评委一样严格检查画面质量：主体是否符合任务、构图是否完整专业、是否被拼成了多格画面、文字是否遮挡关键内容或出现乱码、有无水印或虚构品牌标识。画面层面的这些问题是阻塞问题。\n${rubric}\n画面设计说明：${reviewText}`,{data,mime:'image/jpeg'},'reviewer'));return {...v,visual:true};}
      catch(e){if(isJobControlError(e)||budgetError(e))throw e;/* 评审模型不支持看图时退回到读设计说明。 */}
    }
    const imageNote=task.kind==='image'?'\n注意：你只能看到画面设计说明，看不到图片。只评审说明是否落实了要求；只能从画面判断的标准不要列为问题。':'';
    const textPrompt=`${Guard}\n你是独立作品验收评审。只依据下面的实际产物内容，按评委的眼光严格检查作品质量。${imageNote}\n${rubric}\n产物内容：\n${reviewText.slice(0,40000)}`;
    // 评审输出偶尔被截断或不是 JSON；重试一次，仍失败才记为未评审。
    for(let attempt=0;;attempt++){try{return {...await parse(ctx.gateway.generate('reviewer',attempt?`${textPrompt}\n\n上一次输出不是有效 JSON。只输出 JSON，issues、suggestions、needs_input 各不超过 5 条，每条不超过 120 字。`:textPrompt,'reviewer')),visual:false};}catch(e){if(attempt>=1||!/JSON|Zod|invalid|Expected/i.test(errorHead(e)))throw e;}}
  }catch(e){const m=message(e);if(isJobControlError(e)||budgetError(m))throw e;return null;}
}

/** 待补资料去重：写作和评审常把同一项写成不同说法，被另一条完整包含的短条目并入长条目。 */
export function mergeRequests(items:string[]):string[]{
  const key=(x:string)=>x.replace(/[\s，,。.、；;：:（）()【】\[\]“”"'-]/g,'');
  const unique=[...new Map(items.map(x=>x.trim()).filter(Boolean).map(x=>[key(x),x])).values()];
  return unique.filter(x=>!unique.some(y=>y!==x&&key(y).length>key(x).length&&key(y).includes(key(x))));
}
/** 默认值；每个任务的实际上限从 execution.productionRounds 读取。 */
export const maxRounds=4;
type Check={id:string;status:'passed'|'failed'|'unverified';details:string[]};
export type TaskResult=DeliverableResult&{id:string;deliverable:number;title:string;kind:ArtifactKind;format:string;executor:AgentName;review:Verdict|null;rounds:number;checks:Check[];receipt?:TaskReceipt;needsInput?:string[]};

/** 模型意见只是内容评审；未知格式、未看过的画面和未运行的功能不能由 pass 豁免。 */
function acceptanceChecks(ctx:Ctx,task:PlanTask,review:Verdict|null,browser?:BrowserReport):Check[]{
  const item=ctx.brief.deliverables[task.deliverable];
  const packaged=ctx.plan.packages.some(p=>p.deliverable===task.deliverable&&p.includes.includes(task.id));
  const allowed=item?requestedFormats(item):[];
  const formatPassed=allowed.includes(packaged?'zip':task.format);
  const checks:Check[]=[
    {id:'format',status:formatPassed?'passed':'unverified',details:formatPassed?[]:[`${task.title} 的官方交付格式${allowed.length?'与当前产物不匹配':'尚未明确'}，需确认后才能作为投稿件`]},
    {id:'content',status:review?(review.pass?'passed':'failed'):'unverified',details:review?(review.pass?[]:review.issues):[`${task.title} 未完成独立内容验收`]},
  ];
  if(task.kind==='image'&&review?.visual)checks.push({id:'visual',status:review.pass?'passed':'failed',details:review.pass?[]:review.issues});
  else if(task.kind==='image'||task.kind==='slides')checks.push({id:'visual',status:'unverified',details:[`${task.title} 尚未完成实际画面的视觉验收`]});
  if(task.kind==='software')checks.push({id:'interaction',status:browser?.status||'unverified',details:browser?.issues||[`${task.title} 尚未在浏览器运行并验收交互功能`]}, {id:'visual',status:'unverified',details:[`${task.title} 的浏览器截图已作为检查材料；视觉质量及用例覆盖仍需人工终审`]});
  return checks;
}

async function supporting(ctx:Ctx,task:PlanTask,reason:string):Promise<TaskResult>{
  const item=ctx.brief.deliverables[task.deliverable];
  const r=await createSupportingArtifact(ctx.cfg,ctx.store,ctx.gateway,{jobId:ctx.jobId,competitionTitle:ctx.competitionTitle,type:item?.type||task.title,formats:item?.formats||[],reason,idea:ctx.idea,brief:ctx.brief,...(ctx.brief.deliverables.length?{key:task.id}:{})});
  return {...r,id:task.id,deliverable:task.deliverable,title:task.title,kind:task.kind,format:task.format,executor:executors.supporting,review:null,rounds:0,checks:[]};
}

/** 制作 → 验收 → 带意见返工，最多 maxRounds 轮；仍不通过保留为草稿，做不出来降级为辅助材料。 */
export async function runTask(ctx:Ctx,task:PlanTask):Promise<TaskResult>{
  if(task.kind==='supporting')return supporting(ctx,task,task.reason||`${task.title} 无法用现有制作能力完成`);
  const item=ctx.brief.deliverables[task.deliverable];
  const rounds=executionSettings(ctx.cfg).productionRounds;
  const base={id:task.id,deliverable:task.deliverable,title:task.title,kind:task.kind,format:task.format,executor:executors[task.kind],type:item?.type||task.title,requestedFormats:item?.formats||[]};
  const done=(status:DeliverableStatus,attempt:Attempt,review:Verdict|null,rounds:number,gaps:string[],requirements:RequirementCheck[]=[]):TaskResult=>{
    const checks=[...acceptanceChecks(ctx,task,review,currentBrowser),...requirements];
    if(status==='submission'&&checks.some(c=>c.status!=='passed'))status='draft';
    return {...base,status,artifactPaths:attempt.paths,review,rounds,checks,needsInput:mergeRequests([...(attempt.needsInput||[]),...(review?.needs_input||[])]),gaps:[...new Set([...attempt.notes,...gaps,...checks.filter(c=>c.status!=='passed').flatMap(c=>c.details)])]};
  };
  let currentBrowser:BrowserReport|undefined;
  let feedback:string[]=[];let last:{attempt:Attempt;review:Verdict;requirements:RequirementCheck[]}|null=null;
  for(let round=0;round<rounds;round++){
    await announce(ctx,{stage:'production',action:`${task.title}：${round?'根据验收反馈继续制作':'制作作品'}`,taskId:task.id,round:round+1,maxRounds:rounds});
    const checkpointPath=join(jobDir(ctx),`${taskKey(ctx,task)}-r${round+1}-state.json`);
    let checkpoint:z.infer<typeof RoundRecord>|null=null;
    try{const parsed=RoundRecord.parse(JSON.parse(await readFile(checkpointPath,'utf8')));if((await checkTaskReceipt(parsed.receipt,{task,round},ctx.inputContext,parsed.attempt.paths,jobDir(ctx))).valid)checkpoint=parsed;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'&&!(e instanceof SyntaxError)&&!(e instanceof z.ZodError))throw e;}
    let attempt:Attempt;
    try{attempt=checkpoint?.attempt||await produce(ctx,task,round,feedback);}
    catch(e){
      const m=message(e);
      // 图片模型拒绝某个画面（HTTP 4xx，非限流）是这一张图的问题，不能中止整个任务；下一轮让写作 Agent 改写画面描述。
      const refused=task.kind==='image'&&/图片模型调用失败：HTTP 4(?!29)\d\d/.test(m);
      if(isJobControlError(e)||(fatal(m)&&!refused))throw e;
      if(e instanceof Blocked||configError(m)||round===rounds-1){
        if(last)return done('draft',last.attempt,last.review,round,[`${task.title} 返工失败（${m}），保留上一版草稿；未解决：${last.review.issues.join('；')}`],last.requirements);
        return {...await supporting(ctx,task,`${task.title} 制作失败：${m}`),kind:task.kind,format:task.format};
      }
      feedback=[refused?`图片模型拒绝了上一版画面描述（${m.slice(0,160)}）。改写成单一的产品渲染画面：不要标注、尺寸、文字、CAD 或工程图说法，用外观、材质、光线和视角描述结构。`:`上一次制作失败：${m}`];continue;
    }
    const direct=ctx.plan.tasks.filter(t=>t.deliverable===task.deliverable).length===1&&!ctx.plan.packages.some(p=>p.deliverable===task.deliverable);
    const filename=direct?fixedFileName(item?.naming):null;
    if(filename&&extname(filename).slice(1).toLowerCase()===task.format&&attempt.paths.length===1){const original=attempt.paths[0]!;const target=join(dirname(original),filename);if(target!==original){await rename(original,target);attempt.paths=[target];}}
    if(!checkpoint){checkpoint={attempt,receipt:await createTaskReceipt({task,round},ctx.inputContext,attempt.paths,jobDir(ctx))};await atomicWriteJson(checkpointPath,checkpoint);}
    if(task.kind==='software'){
      currentBrowser=checkpoint.browser;
      if(!currentBrowser||currentBrowser.status==='unverified'){
        currentBrowser=await browserVerify(ctx,task,round,attempt.paths[0]!);checkpoint.browser=currentBrowser;await atomicWriteJson(checkpointPath,checkpoint);
      }
    }
    const requirements=direct&&item?checkLimits(item.limits,await Promise.all(attempt.paths.map(measureArtifact))):[];
    const failures=[...requirements.filter(c=>c.status==='failed').map(c=>`规则「${c.requirement}」未通过：${c.details.join('；')}`),...(currentBrowser?.status==='failed'?currentBrowser.issues.map(i=>`浏览器实测：${i}`):[])];
    if(attempt.reviewText===null)return done('draft',attempt,null,round+1,[],requirements);
    await announce(ctx,{stage:'review',action:`${task.title}：检查实际文件并评审本轮内容`,taskId:task.id,round:round+1,maxRounds:rounds});
    const review=failures.length?{pass:false,issues:failures,suggestions:[],needs_input:[]}:checkpoint.review||await verify(ctx,task,attempt);
    if(!review)return done('draft',attempt,null,round+1,[`${task.title} 评审 Agent 不可用，未经独立验收`],requirements);
    checkpoint.review=review;await atomicWriteJson(checkpointPath,checkpoint);
    if(review.pass)return done('submission',attempt,review,round+1,[],requirements);
    last={attempt,review,requirements};feedback=review.issues.length?review.issues:['评审未通过但未给出具体问题，请对照验收标准全面检查'];
  }
  return done('draft',last!.attempt,last!.review,rounds,[`${task.title} 经 ${rounds} 轮仍未通过验收：${last!.review.issues.join('；')}`],last!.requirements);
}
/* ---------- 打包 ---------- */
const safeName=(x:string)=>x.replace(/[\\/:*?"<>|\r\n]/g,'_').trim().slice(0,80).replace(/^\.+$/,'')||'file';
/** 把计划中指定的任务产物打成压缩包；软件放入源码目录，不嵌套压缩包。 */
async function buildPackages(ctx:Ctx,plan:Plan,results:TaskResult[]):Promise<(DeliverableResult&{deliverable:number})[]>{
  const out:(DeliverableResult&{deliverable:number})[]=[];
  for(const [i,pkg] of plan.packages.entries()){
    const zip=new JSZip();const gaps:string[]=[];let draft=false;
    for(const id of pkg.includes){
      const r=results.find(x=>x.id===id);
      if(!r||!['submission','draft'].includes(r.status)){gaps.push(`压缩包 ${pkg.name} 缺少 ${r?.title||id}（${r?.status||'未执行'}）`);continue;}
      if(r.status==='draft')draft=true;
      for(const p of r.artifactPaths){
        // 只使用已经生成并核对的归档，不能重新读取可能变化的工作区。
        if(r.kind==='software'&&extname(p)==='.zip'){
          const archive=await JSZip.loadAsync(await readFile(p));
          const prefix=zip.files[`${safeName(r.title)}/`]?`${safeName(r.title)}-${r.id}`:safeName(r.title);
          for(const file of Object.values(archive.files))if(!file.dir)zip.file(`${prefix}/${file.name}`,await file.async('nodebuffer'));
        }else{
          const name=`${safeName(r.title)}${extname(p)}`;
          zip.file(zip.file(name)?`${safeName(r.title)}-${r.id}${extname(p)}`:name,await readFile(p));
        }
      }
    }
    const officialName=fixedFileName(ctx.brief.deliverables[pkg.deliverable]?.naming);
    const name=officialName?.toLowerCase().endsWith('.zip')?officialName:safeName(pkg.name).replace(/\.zip$/i,'')+'.zip';const folder=join(jobDir(ctx),`package-${i+1}`);await mkdir(folder,{recursive:true});
    const path=join(folder,name);await writeFile(path,await zip.generateAsync({type:'nodebuffer'}));
    const status:DeliverableStatus=gaps.length||draft?'draft':'submission';
    const item=ctx.brief.deliverables[pkg.deliverable];
    out.push({deliverable:pkg.deliverable,type:item?.type||pkg.name,requestedFormats:item?.formats||[],status,artifactPaths:[path],gaps:[...gaps,...(draft?[`压缩包 ${pkg.name} 含未通过验收的草稿`]:[])]});
  }
  return out;
}

/** 最后一步：把所有要提交的文件按交付物分目录汇总成一个最终提交包；总共不到两个文件时不需要。 */
async function buildFinalBundle(ctx:Ctx,results:TaskResult[],packages:(DeliverableResult&{deliverable:number})[],packaged:Set<string>):Promise<{path:string;draft:boolean}|null>{const zip=new JSZip();const names=new Set<string>();let draft=false;const items=[...results.filter(r=>!packaged.has(r.id)),...packages];for(const r of items){if(r.status!=='submission'&&r.status!=='draft')continue;if(r.status==='draft')draft=true;const dir=`${r.deliverable+1}-${safeName(ctx.brief.deliverables[r.deliverable]?.type||'作品')}`;for(const p of r.artifactPaths){const base=p.split(/[\\/]/).pop()!;let name=`${dir}/${base}`;for(let n=2;names.has(name);n++)name=`${dir}/${n}-${base}`;names.add(name);zip.file(name,await readFile(p));}}if(names.size<2)return null;const folder=join(jobDir(ctx),'final');await mkdir(folder,{recursive:true});const path=join(folder,`${safeName(ctx.competitionTitle).slice(0,40)}-最终提交包.zip`);await writeFile(path,await zip.generateAsync({type:'nodebuffer'}));return {path,draft};}

/* ---------- 入口 ---------- */
const Progress=z.record(z.string(),z.any());
/** 规划 → 制作与验收 → 打包；只有输入和产物收据均匹配才复用已完成任务。 */
export async function runOrchestration(cfg:AppConfig,store:Store,gateway:ModelGateway,input:{jobId:string;competitionId:string;idea:Idea|null;selection?:unknown}){
  const {jobId,competitionId,idea}=input;assertJobCanRun(store,jobId);gateway=controlledGateway(store,jobId,gateway);const c=store.competition(competitionId);const brief=c.brief as Brief;let evidence=contents(store,competitionId);
  const gaps:string[]=[...brief.missing,...(brief.research?.missing||[])];
  let sourceText:string|null=null;
  if(brief.deliverables.some(d=>/translation|翻译|译文|译稿/i.test(d.type))){
    try{const original=Original.parse(parseJSON(await gateway.generate('writer',`${Guard}\n从给定资料中寻找比赛指定要翻译的原文。仅输出 JSON {"url":null或来源URL,"text":null或原文,"reason":"说明"}；来源资料里没有时返回 null。来源 ${JSON.stringify(evidence)}`)));if(original.text)sourceText=original.text;}
    catch(e){if(isJobControlError(e)||fatal(message(e)))throw e;}
    if(!sourceText)gaps.push('资料中没有找到比赛指定的翻译原文');
  }
  // 公告没写格式时先搜索并核对官方要求；核对通过的格式写进赛事档案，作品才能成为投稿件。
  const formatSearch=await discoverFormats(cfg,store,gateway,{jobId,competitionId,title:c.title,brief});
  evidence=contents(store,competitionId);
  const formatRequests=formatSearch.unresolved.map(i=>`「${brief.deliverables[i]?.type}」的提交文件格式：公告和搜索到的页面（${formatSearch.queries.join("；")}）都没有写明。请提供官方格式要求，例如通知附件或征文要求原文，用 compete materials 导入后重新生成`);
  for(const r of formatSearch.resolved)gaps.push(`已从官方资料核实「${brief.deliverables[r.deliverable]?.type}」的格式：${r.formats.join("/")}（${r.url}）`);
  const planned=await planWork(cfg,store,gateway,{jobId,brief,idea,evidence,hasSource:!!sourceText,selection:input.selection});gaps.push(...planned.gaps);
  const inputContext={policy:5,brief,idea,evidence,sourceText,selection:input.selection,plan:planned.plan,prompts:cfg.prompts,models:['writer','reviewer','coder','image'].map(agent=>modelLabel(cfg,agent as AgentName))};
  const ctx:Ctx={cfg,store,gateway,jobId,competitionTitle:c.title,brief,idea,evidence,sourceText,plan:planned.plan,inputContext,selection:input.selection,images:{}};
  const progressPath=join(jobDir(ctx),'orchestration.json');
  let progress:Record<string,TaskResult>={};try{progress=Progress.parse(JSON.parse(await readFile(progressPath,'utf8'))) as Record<string,TaskResult>;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const results:TaskResult[]=[];
  const resumeChecks:{id:string;reused:boolean;reason?:string}[]=[];
  // 图片先做，PPT 和文档才能放入真实生成的图片；其余任务保持计划顺序。
  const ordered=[...planned.plan.tasks.filter(t=>t.kind==='image'),...planned.plan.tasks.filter(t=>t.kind!=='image')];
  for(const task of ordered){
    const prior=progress[task.id];
    const checked=await checkTaskReceipt(prior?.receipt,task,inputContext,prior?.artifactPaths||[],jobDir(ctx));
    // 文件收据之外，旧版本缺少验收记录的结果也需要重新执行。
    const continueRounds=prior?.status==='draft'&&prior.review?.pass===false&&prior.rounds<executionSettings(cfg).productionRounds;
    const reusable=!continueRounds&&checked.valid&&Array.isArray(prior?.checks)&&prior.id===task.id&&['submission','draft','supporting_material','blocked'].includes(prior.status)&&
      (prior.status!=='submission'||(prior.review?.pass===true&&prior.checks.length>=2&&prior.checks.every(c=>c.status==='passed')));
    if(reusable)await announce(ctx,{stage:'resume',action:`${task.title}：输入与产物完整，复用已完成结果`,taskId:task.id,round:prior.rounds,maxRounds:executionSettings(cfg).productionRounds});
    const result=reusable?prior:await runTask(ctx,task);
    if(task.kind==='image'&&['submission','draft'].includes(result.status)&&result.artifactPaths[0])ctx.images[task.id]={path:result.artifactPaths[0],title:task.title,caption:task.instructions.slice(0,120)};
    if(!reusable)result.receipt=await createTaskReceipt(task,inputContext,result.artifactPaths,jobDir(ctx));
    results.push(result);resumeChecks.push({id:task.id,reused:reusable,...(!reusable?{reason:continueRounds?'增加轮数后继续未通过的作品':checked.reason||'验收记录不完整'}:{})});
    progress[task.id]=result;await atomicWriteJson(progressPath,progress);
  }
  // 执行顺序为了图片先行而调整过，结果仍按计划顺序输出。
  results.sort((a,b)=>planned.plan.tasks.findIndex(t=>t.id===a.id)-planned.plan.tasks.findIndex(t=>t.id===b.id));
  await record(cfg,store,jobId,'resume-checks.json',resumeChecks,null);
  const packages=await buildPackages(ctx,planned.plan,results);
  const packaged=new Set(planned.plan.packages.flatMap(p=>p.includes));
  const requirements=[];
  for(const [index,item] of brief.deliverables.entries()){
    const final=[...results.filter(r=>r.deliverable===index&&!packaged.has(r.id)),...packages.filter(p=>p.deliverable===index)];
    const paths=final.filter(r=>r.status==='submission'||r.status==='draft').flatMap(r=>r.artifactPaths);
    const metrics=await Promise.all(paths.map(measureArtifact));const checks=checkDelivery(item,metrics);
    const issues=checks.filter(c=>c.status!=='passed').map(c=>`${item.type}：${c.requirement} — ${c.details.join('；')}`);
    for(const r of final){if(issues.length&&r.status==='submission')r.status='draft';r.gaps=[...new Set([...r.gaps,...issues])];r.checks=[...(r.checks||[]).filter(c=>!c.id.startsWith('delivery-')),...checks.map(c=>({...c,id:`delivery-${c.id}`}))];}
    const sources=(brief.citations||[]).filter(c=>new RegExp(`^deliverables(?:\\.${index}|\\[${index}\\])(?:\\.|$)`).test(c.field)&&c.quote.trim().length>0&&evidence.some(e=>e.url===c.url&&e.text.replace(/\s+/g,' ').includes(c.quote.replace(/\s+/g,' '))));
    requirements.push({deliverable:index,type:item.type,paths,checks,metrics,sources});
  }
  await record(cfg,store,jobId,'requirements.json',requirements,null);
  await atomicWriteJson(progressPath,progress);
  const outputs=[...results.filter(r=>!packaged.has(r.id)||r.status==='supporting_material'||r.status==='blocked').flatMap(r=>r.artifactPaths),...packages.flatMap(p=>p.artifactPaths)];
  // 各任务登记的待补资料汇总成一个文件交给用户，不放进参赛压缩包，作品正文里也不再逐处解释。
  const requests=results.filter(r=>r.needsInput?.length).map(r=>({title:r.title,items:r.needsInput!}));
  if(formatRequests.length)requests.unshift({title:"提交格式",items:formatRequests});
  if(requests.length){
    const text=`# 需要你提供的资料\n\n以下资料只有你能提供，模型无法核实，所以没有写进作品，在作品里对应位置标了【待补充】。补齐后替换这些标记，或把资料发给我重新生成。\n\n${requests.map(r=>`## ${r.title}\n\n${r.items.map(x=>`- [ ] ${x}`).join('\n')}`).join('\n\n')}\n`;
    outputs.push(await record(cfg,store,jobId,'需要你提供的资料.md',text,null));
  }
  // 全部任务完成后，把所有要交付的文件汇总成一个最终提交包，放在输出列表最前面。
  const finalBundle=await buildFinalBundle(ctx,results,packages,packaged);
  if(finalBundle){outputs.unshift(finalBundle.path);if(finalBundle.draft)gaps.push('最终提交包含未通过验收的草稿');}
  for(const r of [...results,...packages])gaps.push(...r.gaps);
  const deliverables:DeliverableResult[]=[...results,...packages];
  for(const result of deliverables)if(result.status==='submission'||result.status==='draft')for(const path of result.artifactPaths)store.artifact(jobId,result.status,path,null);
  const manifestPath=await record(cfg,store,jobId,'deliverables.json',{competition:c.title,requirementsPath:'requirements.json',plan:{source:planned.source,tasks:planned.plan.tasks,packages:planned.plan.packages,notes:planned.plan.notes},deliverables},null);
  return {outputs,gaps:[...new Set(gaps)],deliverables,manifestPath};
}
