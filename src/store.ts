import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Evidence, Job } from './types.js';

export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, 'competition.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS competitions(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT NOT NULL,created_at TEXT NOT NULL,brief TEXT);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,fetched_at TEXT NOT NULL,kind TEXT NOT NULL, UNIQUE(competition_id,url,kind));
      CREATE TABLE IF NOT EXISTS searches(id TEXT PRIMARY KEY,competition_id TEXT,query TEXT NOT NULL,results TEXT NOT NULL,searched_at TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS source_attempts(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,url TEXT NOT NULL,kind TEXT NOT NULL,attempted_at TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,calls INTEGER NOT NULL DEFAULT 0,max_calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,model TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS competition_queue(competition_id TEXT PRIMARY KEY REFERENCES competitions(id),state TEXT NOT NULL,job_id TEXT REFERENCES jobs(id),redo INTEGER NOT NULL DEFAULT 0,added_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS queue_worker(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at TEXT NOT NULL);
    `);
  }
  addCompetition(url: string, title: string): string { const id=randomUUID(), now=new Date().toISOString(); this.db.prepare('INSERT OR IGNORE INTO competitions(id,url,title,created_at) VALUES(?,?,?,?)').run(id,url,title,now); return String((this.db.prepare('SELECT id FROM competitions WHERE url=?').get(url) as any).id); }
  competition(id: string): any { const c=this.db.prepare('SELECT * FROM competitions WHERE id=?').get(id) as any; if (!c) throw Error(`找不到赛事：${id}`); return {...c, brief:c.brief ? JSON.parse(c.brief) : null}; }
  list(): any[] { return this.db.prepare('SELECT id,title,url,created_at,brief FROM competitions ORDER BY created_at DESC').all().map((c:any)=>({...c,brief:c.brief ? JSON.parse(c.brief):null})); }
  setBrief(id:string, brief:unknown) { this.db.prepare('UPDATE competitions SET brief=? WHERE id=?').run(JSON.stringify(brief),id); }
  putEvidence(e: Evidence) { this.db.prepare(`INSERT INTO evidence VALUES(?,?,?,?,?,?,?) ON CONFLICT(competition_id,url,kind) DO UPDATE SET title=excluded.title,text=excluded.text,fetched_at=excluded.fetched_at`).run(e.id,e.competitionId,e.url,e.title,e.text,e.fetchedAt,e.kind); }
  evidence(id:string): Evidence[] { return (this.db.prepare('SELECT * FROM evidence WHERE competition_id=? ORDER BY fetched_at').all(id) as any[]).map(x=>({id:x.id,competitionId:x.competition_id,url:x.url,title:x.title,text:x.text,fetchedAt:x.fetched_at,kind:x.kind})); }
  search(competitionId:string|null, query:string, results:unknown, error:string|null=null) { this.db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?)').run(randomUUID(),competitionId,query,JSON.stringify(results),new Date().toISOString(),error); }
  searches(id:string|null) { return this.db.prepare('SELECT query,results,searched_at,error FROM searches WHERE competition_id IS ? ORDER BY searched_at').all(id); }
  sourceAttempt(id:string,url:string,kind:string,error:string|null=null) { this.db.prepare('INSERT INTO source_attempts VALUES(?,?,?,?,?,?)').run(randomUUID(),id,url,kind,new Date().toISOString(),error); }
  sourceAttempts(id:string) { return this.db.prepare('SELECT url,kind,attempted_at,error FROM source_attempts WHERE competition_id=? ORDER BY attempted_at').all(id); }
  createJob(competitionId:string,kind:string,input:Record<string,unknown>,maxCalls:number):string { if(!Number.isInteger(maxCalls)||maxCalls<1) throw Error('预算必须为正整数'); const id=randomUUID(),now=new Date().toISOString(); this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,competitionId,kind,'pending',now,now,JSON.stringify(input),null,null,0,maxCalls); return id; }
  job(id:string): Job { const x=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any; if(!x) throw Error(`找不到任务：${id}`); return {id:x.id,competitionId:x.competition_id,kind:x.kind,state:x.state,createdAt:x.created_at,updatedAt:x.updated_at,input:JSON.parse(x.input),result:x.result?JSON.parse(x.result):null,error:x.error,calls:x.calls,maxCalls:x.max_calls}; }
  latestJob(competitionId:string,kind:string):Job|null {const x=this.db.prepare('SELECT id FROM jobs WHERE competition_id=? AND kind=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(competitionId,kind) as {id:string}|undefined;return x?this.job(x.id):null;}
  setJob(id:string,state:string,error:string|null=null,result:unknown=null) { this.db.prepare('UPDATE jobs SET state=?,error=?,result=COALESCE(?,result),updated_at=? WHERE id=?').run(state,error,result===null?null:JSON.stringify(result),new Date().toISOString(),id); }
  consumeCall(id:string) { const r=this.db.prepare('UPDATE jobs SET calls=calls+1 WHERE id=? AND calls<max_calls').run(id); if(!r.changes) throw Error('已达到模型调用次数上限；任务已保留，可调整预算后恢复'); }
  reserveCalls(id:string,count:number) { if(!Number.isInteger(count)||count<1)throw Error('预算必须为正整数');const r=this.db.prepare('UPDATE jobs SET calls=calls+? WHERE id=? AND calls+?<=max_calls').run(count,id,count);if(!r.changes)throw Error(`剩余预算不足，本阶段需要预留 ${count} 个预算单位`); }
  setBudget(id:string,max:number) { if(!Number.isInteger(max)||max<1) throw Error('预算必须为正整数'); this.db.prepare('UPDATE jobs SET max_calls=? WHERE id=?').run(max,id); }
  artifact(jobId:string,kind:string,path:string,model:string|null) { this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)').run(randomUUID(),jobId,kind,path,model,new Date().toISOString()); }
  artifacts(jobId:string) { return this.db.prepare('SELECT kind,path,model,created_at FROM artifacts WHERE job_id=? ORDER BY created_at').all(jobId); }
  enqueue(id:string,redo=false):boolean {
    this.competition(id);
    const existing=this.db.prepare('SELECT state FROM competition_queue WHERE competition_id=?').get(id) as {state:string}|undefined;
    if(existing){if(!redo||existing.state==='processing'||existing.state==='queued')return false;return !!this.db.prepare("UPDATE competition_queue SET state='queued',job_id=NULL,redo=1,added_at=?,updated_at=?,error=NULL WHERE competition_id=? AND state IN ('completed','failed')").run(new Date().toISOString(),new Date().toISOString(),id).changes;}
    if(!redo&&this.latestJob(id,'automatic')?.state==='completed')return false;
    const now=new Date().toISOString();return !!this.db.prepare('INSERT OR IGNORE INTO competition_queue VALUES(?,?,?,?,?,?,?)').run(id,'queued',null,redo?1:0,now,now,null).changes;
  }
  queue() {return this.db.prepare(`SELECT q.competition_id AS competitionId,c.title,c.url,q.state,q.job_id AS jobId,q.added_at AS addedAt,q.updated_at AS updatedAt,q.error FROM competition_queue q JOIN competitions c ON c.id=q.competition_id ORDER BY q.added_at,q.rowid`).all();}
  retryQueue(id?:string) {const now=new Date().toISOString();return id?this.db.prepare("UPDATE competition_queue SET state='queued',updated_at=?,error=NULL WHERE state='failed' AND competition_id=?").run(now,id).changes:this.db.prepare("UPDATE competition_queue SET state='queued',updated_at=?,error=NULL WHERE state='failed'").run(now).changes;}
  acquireWorker(owner:string,leaseMs:number) {const now=new Date().toISOString(),expires=new Date(Date.now()+leaseMs).toISOString();this.db.exec('BEGIN IMMEDIATE');try{const lock=this.db.prepare('SELECT owner,expires_at FROM queue_worker WHERE id=1').get() as {owner:string;expires_at:string}|undefined;if(lock&&lock.expires_at>now)throw Error('已有队列处理进程正在运行');this.db.prepare('INSERT OR REPLACE INTO queue_worker VALUES(1,?,?)').run(owner,expires);this.db.prepare("UPDATE competition_queue SET state='queued',updated_at=?,error='上次处理进程中断，等待从检查点恢复' WHERE state='processing'").run(now);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  heartbeatWorker(owner:string,leaseMs:number):boolean {return !!this.db.prepare('UPDATE queue_worker SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?').run(new Date(Date.now()+leaseMs).toISOString(),owner,new Date().toISOString()).changes;}
  releaseWorker(owner:string){this.db.prepare('DELETE FROM queue_worker WHERE id=1 AND owner=?').run(owner);}
  claimQueue(owner:string,budget:number):{competitionId:string;jobId:string;resume:boolean}|null {
    this.db.exec('BEGIN IMMEDIATE');try{const now=new Date().toISOString();const lock=this.db.prepare('SELECT owner FROM queue_worker WHERE id=1 AND expires_at>?').get(now) as {owner:string}|undefined;if(lock?.owner!==owner)throw Error('队列处理锁已失效');const q=this.db.prepare("SELECT competition_id,job_id,redo FROM competition_queue WHERE state='queued' ORDER BY added_at,rowid LIMIT 1").get() as {competition_id:string;job_id:string|null;redo:number}|undefined;if(!q){this.db.exec('COMMIT');return null;}const prior=q.job_id?this.job(q.job_id):q.redo?null:this.latestJob(q.competition_id,'automatic');const jobId=prior?.id||this.createJob(q.competition_id,'automatic',{},budget);if(prior&&budget>prior.maxCalls)this.setBudget(jobId,budget);this.db.prepare("UPDATE competition_queue SET state='processing',job_id=?,updated_at=?,error=NULL WHERE competition_id=?").run(jobId,now,q.competition_id);this.db.exec('COMMIT');return {competitionId:q.competition_id,jobId,resume:!!prior&&prior.state!=='pending'};}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  finishQueue(owner:string,id:string,state:'completed'|'failed',error:string|null=null){const now=new Date().toISOString();const result=this.db.prepare("UPDATE competition_queue SET state=?,error=?,updated_at=? WHERE competition_id=? AND state='processing' AND EXISTS (SELECT 1 FROM queue_worker WHERE id=1 AND owner=? AND expires_at>?)").run(state,error,now,id,owner,now);if(!result.changes)throw Error('队列处理锁已失效，不能更新任务状态');}
  close(){this.db.close();}
}
