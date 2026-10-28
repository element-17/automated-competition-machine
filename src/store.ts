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
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,calls INTEGER NOT NULL DEFAULT 0,max_calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,model TEXT,created_at TEXT NOT NULL);
    `);
  }
  addCompetition(url: string, title: string): string { const id=randomUUID(), now=new Date().toISOString(); this.db.prepare('INSERT OR IGNORE INTO competitions(id,url,title,created_at) VALUES(?,?,?,?)').run(id,url,title,now); return String((this.db.prepare('SELECT id FROM competitions WHERE url=?').get(url) as any).id); }
  competition(id: string): any { const c=this.db.prepare('SELECT * FROM competitions WHERE id=?').get(id) as any; if (!c) throw Error(`找不到赛事：${id}`); return {...c, brief:c.brief ? JSON.parse(c.brief) : null}; }
  list(): any[] { return this.db.prepare('SELECT id,title,url,created_at,brief FROM competitions ORDER BY created_at DESC').all().map((c:any)=>({...c,brief:c.brief ? JSON.parse(c.brief):null})); }
  setBrief(id:string, brief:unknown) { this.db.prepare('UPDATE competitions SET brief=? WHERE id=?').run(JSON.stringify(brief),id); }
  putEvidence(e: Evidence) { this.db.prepare(`INSERT INTO evidence VALUES(?,?,?,?,?,?,?) ON CONFLICT(competition_id,url,kind) DO UPDATE SET title=excluded.title,text=excluded.text,fetched_at=excluded.fetched_at`).run(e.id,e.competitionId,e.url,e.title,e.text,e.fetchedAt,e.kind); }
  evidence(id:string): Evidence[] { return (this.db.prepare('SELECT * FROM evidence WHERE competition_id=? ORDER BY fetched_at').all(id) as any[]).map(x=>({id:x.id,competitionId:x.competition_id,url:x.url,title:x.title,text:x.text,fetchedAt:x.fetched_at,kind:x.kind})); }
  search(competitionId:string|null, query:string, results:unknown, error:string|null=null) { this.db.prepare('INSERT INTO searches VALUES(?,?,?,?,?,?)').run(randomUUID(),competitionId,query,JSON.stringify(results),new Date().toISOString(),error); }
  searches(id:string) { return this.db.prepare('SELECT query,results,searched_at,error FROM searches WHERE competition_id=? ORDER BY searched_at').all(id); }
  createJob(competitionId:string,kind:string,input:Record<string,unknown>,maxCalls:number):string { if(!Number.isInteger(maxCalls)||maxCalls<1) throw Error('预算必须为正整数'); const id=randomUUID(),now=new Date().toISOString(); this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,competitionId,kind,'pending',now,now,JSON.stringify(input),null,null,0,maxCalls); return id; }
  job(id:string): Job { const x=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any; if(!x) throw Error(`找不到任务：${id}`); return {id:x.id,competitionId:x.competition_id,kind:x.kind,state:x.state,createdAt:x.created_at,updatedAt:x.updated_at,input:JSON.parse(x.input),result:x.result?JSON.parse(x.result):null,error:x.error,calls:x.calls,maxCalls:x.max_calls}; }
  setJob(id:string,state:string,error:string|null=null,result:unknown=null) { this.db.prepare('UPDATE jobs SET state=?,error=?,result=COALESCE(?,result),updated_at=? WHERE id=?').run(state,error,result===null?null:JSON.stringify(result),new Date().toISOString(),id); }
  consumeCall(id:string) { const r=this.db.prepare('UPDATE jobs SET calls=calls+1 WHERE id=? AND calls<max_calls').run(id); if(!r.changes) throw Error('已达到模型调用次数上限；任务已保留，可调整预算后恢复'); }
  setBudget(id:string,max:number) { if(!Number.isInteger(max)||max<1) throw Error('预算必须为正整数'); this.db.prepare('UPDATE jobs SET max_calls=? WHERE id=?').run(max,id); }
  artifact(jobId:string,kind:string,path:string,model:string|null) { this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)').run(randomUUID(),jobId,kind,path,model,new Date().toISOString()); }
  artifacts(jobId:string) { return this.db.prepare('SELECT kind,path,model,created_at FROM artifacts WHERE job_id=? ORDER BY created_at').all(jobId); }
  close(){this.db.close();}
}
