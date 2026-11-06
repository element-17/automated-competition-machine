import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../workflows/task-receipts.js';

export type JobProgress={stage:string;action:string;taskId?:string;round?:number;maxRounds?:number;elapsedSeconds?:number;budget?:{used:number;limit:number};at?:string};
const pending=new Map<string,Promise<void>>();
/** 串行保存最近状态与紧凑事件，不写入模型原文或凭据。 */
export function saveJobProgress(dataDir:string,jobId:string,event:JobProgress):Promise<void>{
  const folder=join(dataDir,'jobs',jobId);const entry={...event,at:event.at||new Date().toISOString()};
  const work=(pending.get(folder)||Promise.resolve()).catch(()=>{}).then(async()=>{
    await mkdir(folder,{recursive:true});await atomicWriteJson(join(folder,'runtime-progress.json'),entry);
    await appendFile(join(folder,'progress.jsonl'),JSON.stringify(entry)+'\n','utf8');
  });
  pending.set(folder,work);void work.then(()=>{if(pending.get(folder)===work)pending.delete(folder);},()=>{if(pending.get(folder)===work)pending.delete(folder);});
  return work;
}
