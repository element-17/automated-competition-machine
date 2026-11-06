import { budgetError } from './shared.js';
import { assertJobCanRun, beginJobRun, controlledGateway, isJobControlError } from '../core/job-control.js';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../core/config.js';
import type { Store } from '../core/store.js';
import { Brief, type ModelGateway } from '../core/types.js';
import { parseJSON } from '../core/gateway.js';
import { modelLabel } from '../agents/models.js';
import { researchGraph } from './workflow.js';
import { collectCandidateEvidence, compareCandidates, type CandidateEvidence, type Choice } from './concepts.js';
import { saveJobProgress } from '../core/job-progress.js';
import { Guard, Idea, contents, record, cached, runOrchestration, type DeliverableResult } from './orchestrator.js';

export { deliveryFormat, canDraftUnknownFormat } from './orchestrator.js';
type Gate={decision:'proceed'|'exclude'|'needs_input';reason:string;evidence_url:string|null;evidence_quote:string|null};

const AutoState=Annotation.Root({jobId:Annotation<string>,competitionId:Annotation<string>,gate:Annotation<Gate>,ideas:Annotation<z.infer<typeof Idea>[]>,choice:Annotation<Choice>,candidateEvidence:Annotation<CandidateEvidence[]>,outputs:Annotation<string[]>,gaps:Annotation<string[]>,deliverables:Annotation<DeliverableResult[]>,manifestPath:Annotation<string>,resultPath:Annotation<string>});
type State=typeof AutoState.State;

/** 仅用于提示可能重复，不能作为原创性的最终裁决。 */
export function conceptSimilarity(a:z.infer<typeof Idea>,b:z.infer<typeof Idea>):number {const features=(x:z.infer<typeof Idea>)=>{const text=`${x.audience} ${x.problem} ${x.mechanism}`.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');const grams=new Set<string>();for(let i=0;i<text.length-1;i++)grams.add(text.slice(i,i+2));return grams;};const left=features(a),right=features(b);if(!left.size||!right.size)return 0;let common=0;for(const g of left)if(right.has(g))common++;return common/(left.size+right.size-common);}

export function autonomousGraph(cfg:AppConfig,store:Store,gateway:ModelGateway) {
 const b=new StateGraph(AutoState)
  .addNode('research',async(s:State)=>{const nested=researchGraph(cfg,store,gateway);const conf={configurable:{thread_id:`${s.jobId}:research`}};try{const existing=await nested.graph.getState(conf);if(existing.next?.length)await nested.graph.invoke(null as any,conf);else if(!existing.createdAt)await nested.graph.invoke({jobId:s.jobId,competitionId:s.competitionId} as any,conf);}catch(e){if(isJobControlError(e)||budgetError(e))throw e;const c=store.competition(s.competitionId);await record(cfg,store,s.jobId,'research-error.json',{error:e instanceof Error?e.message:String(e),continued:true},null);if(!c.brief)store.setBrief(s.competitionId,Brief.parse({title:c.title,deliverables:[],missing:['研究阶段未能完整读取公告或附件；以下仅生成辅助制作材料']}));}finally{nested.saver.db.close();}return {};})
  .addNode('eligibility',async(s:State)=>{const gate={decision:'proceed' as const,reason:'赛事审核已由队列审核 Agent 完成；自动制作不再重复审核作品资格',evidence_url:null,evidence_quote:null};await record(cfg,store,s.jobId,'eligibility.json',gate,null);return {gate};})
  .addNode('concepts',async(s:State)=>{const c=store.competition(s.competitionId);const brief=c.brief as Brief;if(brief.requires_idea===false&&!brief.deliverables.some(item=>/征文|论文|essay|paper|article/i.test(item.type)))return {ideas:[],choice:{selected:1,analysis:'赛题已给定，不生成选题',similarity_risks:[]}};const evidence=contents(store,s.competitionId);const neutral=evidence.filter(e=>(e.kind==='entry'||e.kind==='official')&&!/往届|获奖|优秀作品/.test(e.title));const angles=['从真实使用者痛点和具体场景出发','从跨学科方法或相邻领域出发','从低资源限制和可验证的实际效果出发'];const ideas=[];
     const branches=await Promise.allSettled(angles.map(async(angle,index)=>{const idea=await cached(cfg,store,s.jobId,`concept-${index+1}.json`,Idea,modelLabel(cfg,'writer'),async()=>parseJSON(await gateway.generate('writer',`${Guard}\n为以下比赛独立提出一个作品方案，本分支视角：${angle}。不要生成空泛 AI 平台；必须有具体对象、问题、机制、可执行验证。只输出 JSON {"title":"","audience":"","problem":"","mechanism":"","verification":"","evidence_urls":[]}。没有证据的事实标为假设；evidence_urls 可以留空，或列出相关来源供后续参考，不要求来源已在本次材料中收集。规则：${JSON.stringify(brief)}\n资料：${JSON.stringify(neutral)}`)));return idea;}));const errors=branches.flatMap((x,index)=>x.status==='rejected'?[{branch:index+1,error:x.reason instanceof Error?x.reason.message:String(x.reason)}]:[]);for(const branch of branches)if(branch.status==='fulfilled')ideas.push(branch.value);if(errors.length)await record(cfg,store,s.jobId,'concept-errors.json',errors,null);
     const budgetFailure=branches.find((branch):branch is PromiseRejectedResult=>branch.status==='rejected'&&(isJobControlError(branch.reason)||budgetError(branch.reason)));
     if(budgetFailure)throw budgetFailure.reason;
     await record(cfg,store,s.jobId,'concepts.json',ideas,modelLabel(cfg,'writer'));return {ideas};})
  .addNode('novelty',async(s:State)=>{const candidateEvidence=await collectCandidateEvidence(cfg,store,gateway,s.jobId,s.competitionId,s.ideas||[]);return {candidateEvidence};})
  .addNode('compare',async(s:State)=>{
    const pairs=[];for(let i=0;i<(s.ideas||[]).length;i++)for(let j=i+1;j<s.ideas.length;j++)pairs.push({left:i+1,right:j+1,lexical_similarity:conceptSimilarity(s.ideas[i]!,s.ideas[j]!)});
    await record(cfg,store,s.jobId,'concept-diversity.json',pairs,null);
    return compareCandidates(cfg,store,gateway,s.jobId,store.competition(s.competitionId).brief as Brief,s.ideas||[],s.candidateEvidence||[],pairs);
  })
  // 中心调度：规划 Agent 拆解任务，按产物类型分派执行 Agent，评审 Agent 验收并返工。
  .addNode('make',async(s:State)=>{const idea=s.ideas?.length?s.ideas[s.choice.selected-1]||null:null;const result=await runOrchestration(cfg,store,gateway,{jobId:s.jobId,competitionId:s.competitionId,idea,selection:s.choice});return {...result,gaps:[...new Set([...(s.gaps||[]),...result.gaps])]};})
  .addNode('finish',async(s:State)=>{const summary={status:s.gate.decision==='exclude'?'excluded':s.gate.decision==='needs_input'?'needs_input':s.gaps?.length?'needs_review':'ready_for_review',gate:s.gate,outputs:s.outputs||[],gaps:s.gaps||[],notes:['请最终核对当届赛事规则、AI 使用要求和作品中的事实；系统未自动报名或提交。']};const path=await record(cfg,store,s.jobId,'result.json',summary,null);return {outputs:[...(s.outputs||[]),path]};})
  .addEdge(START,'research').addEdge('research','eligibility').addConditionalEdges('eligibility',(s:State)=>s.gate.decision==='proceed'?'concepts':'finish',['concepts','finish']).addEdge('concepts','novelty').addEdge('novelty','compare').addEdge('compare','make').addEdge('make','finish').addEdge('finish',END);
 const saver=SqliteSaver.fromConnString(join(cfg.dataDir,'checkpoints.sqlite'));return {graph:b.compile({checkpointer:saver}),saver};
}

export { isCompetitionCandidate, discoverCompetitions } from '../competition/discovery.js';

export async function runAutomatic(cfg:AppConfig,store:Store,gateway:ModelGateway,jobId:string,resume=false){
 const job=store.job(jobId);if(job.kind!=='automatic')throw Error('不是自动竞赛任务');if(job.state==='completed')throw Error('任务已经完成');
 const release=beginJobRun(store,jobId);const runtime=autonomousGraph(cfg,store,controlledGateway(store,jobId,gateway,release.assert));const conf={configurable:{thread_id:jobId}};
 store.setJob(jobId,'running');
 try{
  await saveJobProgress(cfg.dataDir,jobId,{stage:'workflow',action:resume?'从检查点恢复任务':'开始赛事任务'});
  const checkpoint=resume?await runtime.graph.getState(conf):null;
  const result=await runtime.graph.invoke(resume&&checkpoint?.createdAt?null as any:{jobId,competitionId:job.competitionId} as any,conf);
  release.assert();assertJobCanRun(store,jobId);
  const state=store.finishJob(jobId,'completed',null,{gate:result.gate,outputs:result.outputs,gaps:result.gaps});
  if(state!=='completed'){release.assert();assertJobCanRun(store,jobId);}
  await saveJobProgress(cfg.dataDir,jobId,{stage:'finished',action:result.gaps?.length?'流程结束，仍有待核实项':'流程结束，等待人工终审'});return result;
 }catch(e){
  release.assert();const state=store.finishJob(jobId,'failed',e instanceof Error?e.message:String(e));
  await saveJobProgress(cfg.dataDir,jobId,{stage:state,action:state==='paused'?'已在安全边界暂停':state==='stopped'?'任务已停止，产物保留':'任务未完成，检查点已保存'});throw e;
 }finally{runtime.saver.db.close();release();}
}
