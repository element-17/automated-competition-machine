import { randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import { todayChina } from './screening.js';

const LEASE_MS=5*60_000;
type Task={competitionId:string;jobId:string;resume:boolean};
export async function processQueue(store:Store,options:{limit:number;budget:number;run:(task:Task)=>Promise<unknown>;onStart?:(task:Task)=>void;onError?:(task:Task,error:string)=>void}) {
  if(!Number.isInteger(options.limit)||options.limit<1||!Number.isInteger(options.budget)||options.budget<1)throw Error('limit 和 budget 必须为正整数');
  const owner=randomUUID();store.acquireWorker(owner,LEASE_MS);
  const heartbeat=setInterval(()=>{try{if(!store.heartbeatWorker(owner,LEASE_MS))console.error('队列处理锁已失效，当前任务结束后将停止');}catch(e){console.error(`队列处理锁续期失败：${String(e)}`);}},15_000);heartbeat.unref();
  const processed:{competitionId:string;jobId:string;result?:unknown;error?:string}[]=[];
  try{store.expireQueueReviews(todayChina());for(let i=0;i<options.limit;i++){
    const task=store.claimQueue(owner,options.budget);if(!task)break;
    options.onStart?.(task);
    try{const result=store.job(task.jobId).state==='completed'?store.job(task.jobId).result:await options.run(task);if(!store.heartbeatWorker(owner,LEASE_MS))throw Error('队列处理锁已失效');const state=store.finishJob(task.jobId,'completed');store.finishQueue(owner,task.competitionId,state);processed.push({competitionId:task.competitionId,jobId:task.jobId,...(state==='completed'?{result}:{error:state==='paused'?'任务已暂停':'任务已停止'})});if(state==='paused'||state==='stopped')break;}
    catch(e){if(!store.heartbeatWorker(owner,LEASE_MS))throw e;const error=e instanceof Error?e.message:String(e);const state=store.finishJob(task.jobId,'failed',error);store.finishQueue(owner,task.competitionId,state,error);processed.push({competitionId:task.competitionId,jobId:task.jobId,error});options.onError?.(task,error);if(state==='paused'||state==='stopped')break;}
  }return processed;}finally{clearInterval(heartbeat);store.releaseWorker(owner);}
}
