import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { leaseOwner, trackLeaseOnExit } from './store.js';
import type { ModelGateway } from './types.js';

export class JobControlError extends Error {
  constructor(public action:'pause'|'stop') { super(action==='pause'?'任务已在安全边界暂停，检查点已保留':'任务已停止，已有产物保留');this.name='JobControlError'; }
}
export class JobLeaseError extends Error { constructor(){super('任务执行租约已失效，当前进程不能继续或覆盖状态');this.name='JobLeaseError';} }
export const isJobControlError=(error:unknown):error is JobControlError|JobLeaseError=>error instanceof JobControlError||error instanceof JobLeaseError;
export function assertJobCanRun(store:Store,id:string){
  const control=store.jobControl(id);if(control)throw new JobControlError(control.action);
  const state=store.job(id).state;if(state==='paused'||state==='stopped')throw new JobControlError(state==='paused'?'pause':'stop');
}
/** 只在开始下一次调用时检查；已返回的结果仍可落盘，避免暂停丢失成果。 */
export function controlledGateway(store:Store,id:string,gateway:ModelGateway,checkLease?:()=>void):ModelGateway {
  return new Proxy(gateway,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
    return (...args:unknown[])=>{checkLease?.();assertJobCanRun(store,id);return value.apply(target,args);};
  }});
}
/** 独立任务和队列任务共用持久租约，阻止两个进程恢复同一检查点。 */
export function beginJobRun(store:Store,id:string){
  assertJobCanRun(store,id);const owner=leaseOwner();store.acquireJobRun(id,owner,300_000);
  const assertLease=()=>{if(!store.ownsJobRun(id,owner))throw new JobLeaseError();};
  const timer=setInterval(()=>{try{store.heartbeatJobRun(id,owner,300_000);}catch{ /* 下一安全边界核对租约。 */ }},15_000);timer.unref();
  // 进程被中断时立即释放租约，下一次 resume 不必等租约自然过期。
  const detach=trackLeaseOnExit(()=>{clearInterval(timer);store.releaseJobRun(id,owner);});
  return Object.assign(()=>{detach();store.releaseJobRun(id,owner);},{assert:assertLease});
}
