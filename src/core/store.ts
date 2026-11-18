import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Evidence, Job } from "./types.js";
import { competitionCoreKey } from "../competition/dedupe.js";

/** 租约所有者带进程号：进程已退出时租约立即失效，不必等满 5 分钟。 */
export const leaseOwner = () => `${randomUUID()}:${process.pid}`;
/** 所有者进程是否还活着；没有进程号的旧记录无法判断，按存活处理。 */
function ownerAlive(owner: string) {
  const pid = Number(owner.split(":").at(-1));
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 退出时释放租约：Ctrl+C、关窗口或被 kill 时，租约不清理会让下一次 work/resume 白等 5 分钟。
 * 处理函数只做同步数据库删除，跑完立即按信号退出。
 */
const exitCleanups = new Set<() => void>();
let exitHandlersInstalled = false;
export function trackLeaseOnExit(release: () => void): () => void {
  if (!exitHandlersInstalled) {
    exitHandlersInstalled = true;
    const run = () => {
      for (const cleanup of [...exitCleanups]) {
        try {
          cleanup();
        } catch {
          /* 数据库可能已关闭。 */
        }
      }
      exitCleanups.clear();
    };
    process.once("exit", run);
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const)
      process.once(signal, () => {
        run();
        process.exit(code);
      });
  }
  exitCleanups.add(release);
  return () => {
    exitCleanups.delete(release);
    release();
  };
}

export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, "competition.sqlite"));
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS competitions(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,title TEXT NOT NULL,created_at TEXT NOT NULL,brief TEXT);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,fetched_at TEXT NOT NULL,kind TEXT NOT NULL, UNIQUE(competition_id,url,kind));
      CREATE TABLE IF NOT EXISTS searches(id TEXT PRIMARY KEY,competition_id TEXT,query TEXT NOT NULL,results TEXT NOT NULL,searched_at TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS source_attempts(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,url TEXT NOT NULL,kind TEXT NOT NULL,attempted_at TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,calls INTEGER NOT NULL DEFAULT 0,max_calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,model TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS competition_queue(competition_id TEXT PRIMARY KEY REFERENCES competitions(id),state TEXT NOT NULL,job_id TEXT REFERENCES jobs(id),redo INTEGER NOT NULL DEFAULT 0,added_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS queue_worker(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_controls(job_id TEXT PRIMARY KEY REFERENCES jobs(id),action TEXT NOT NULL,requested_at TEXT NOT NULL,prior_state TEXT NOT NULL DEFAULT 'failed');
      CREATE TABLE IF NOT EXISTS job_runs(job_id TEXT PRIMARY KEY REFERENCES jobs(id),owner TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_reviews(competition_id TEXT PRIMARY KEY REFERENCES competitions(id),decision TEXT NOT NULL,reason TEXT NOT NULL,source_url TEXT,quote TEXT,deadline TEXT,reviewer TEXT NOT NULL,reviewed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_review_history(id TEXT PRIMARY KEY,competition_id TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,source_url TEXT,quote TEXT,deadline TEXT,reviewer TEXT NOT NULL,reviewed_at TEXT NOT NULL);
    `);
    if (
      !(
        this.db.prepare("PRAGMA table_info(job_controls)").all() as {
          name: string;
        }[]
      ).some((c) => c.name === "prior_state")
    )
      this.db.exec(
        "ALTER TABLE job_controls ADD COLUMN prior_state TEXT NOT NULL DEFAULT 'failed'",
      );
  }
  addCompetition(url: string, title: string): string {
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO competitions(id,url,title,created_at) VALUES(?,?,?,?)",
      )
      .run(id, url, title, now);
    return String(
      (
        this.db
          .prepare("SELECT id FROM competitions WHERE url=?")
          .get(url) as any
      ).id,
    );
  }
  competition(id: string): any {
    const c = this.db
      .prepare("SELECT * FROM competitions WHERE id=?")
      .get(id) as any;
    if (!c) throw Error(`找不到赛事：${id}`);
    return { ...c, brief: c.brief ? JSON.parse(c.brief) : null };
  }
  list(): any[] {
    return this.db
      .prepare(
        "SELECT id,title,url,created_at,brief FROM competitions ORDER BY created_at DESC",
      )
      .all()
      .map((c: any) => ({ ...c, brief: c.brief ? JSON.parse(c.brief) : null }));
  }
  setBrief(id: string, brief: unknown) {
    this.db
      .prepare("UPDATE competitions SET brief=? WHERE id=?")
      .run(JSON.stringify(brief), id);
  }
  putEvidence(e: Evidence) {
    this.db
      .prepare(
        `INSERT INTO evidence VALUES(?,?,?,?,?,?,?) ON CONFLICT(competition_id,url,kind) DO UPDATE SET title=excluded.title,text=excluded.text,fetched_at=excluded.fetched_at`,
      )
      .run(e.id, e.competitionId, e.url, e.title, e.text, e.fetchedAt, e.kind);
  }
  evidence(id: string): Evidence[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM evidence WHERE competition_id=? ORDER BY fetched_at",
        )
        .all(id) as any[]
    ).map((x) => ({
      id: x.id,
      competitionId: x.competition_id,
      url: x.url,
      title: x.title,
      text: x.text,
      fetchedAt: x.fetched_at,
      kind: x.kind,
    }));
  }
  search(
    competitionId: string | null,
    query: string,
    results: unknown,
    error: string | null = null,
  ) {
    this.db
      .prepare("INSERT INTO searches VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        competitionId,
        query,
        JSON.stringify(results),
        new Date().toISOString(),
        error,
      );
  }
  searches(id: string | null) {
    return this.db
      .prepare(
        "SELECT query,results,searched_at,error FROM searches WHERE competition_id IS ? ORDER BY searched_at",
      )
      .all(id);
  }
  sourceAttempt(
    id: string,
    url: string,
    kind: string,
    error: string | null = null,
  ) {
    this.db
      .prepare("INSERT INTO source_attempts VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), id, url, kind, new Date().toISOString(), error);
  }
  sourceAttempts(id: string) {
    return this.db
      .prepare(
        "SELECT url,kind,attempted_at,error FROM source_attempts WHERE competition_id=? ORDER BY attempted_at",
      )
      .all(id);
  }
  createJob(
    competitionId: string,
    kind: string,
    input: Record<string, unknown>,
    maxCalls: number,
  ): string {
    if (!Number.isInteger(maxCalls) || maxCalls < 1)
      throw Error("预算必须为正整数");
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        competitionId,
        kind,
        "pending",
        now,
        now,
        JSON.stringify(input),
        null,
        null,
        0,
        maxCalls,
      );
    return id;
  }
  job(id: string): Job {
    const x = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any;
    if (!x) throw Error(`找不到任务：${id}`);
    return {
      id: x.id,
      competitionId: x.competition_id,
      kind: x.kind,
      state: x.state,
      createdAt: x.created_at,
      updatedAt: x.updated_at,
      input: JSON.parse(x.input),
      result: x.result ? JSON.parse(x.result) : null,
      error: x.error,
      calls: x.calls,
      maxCalls: x.max_calls,
    };
  }
  latestJob(competitionId: string, kind: string): Job | null {
    const x = this.db
      .prepare(
        "SELECT id FROM jobs WHERE competition_id=? AND kind=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(competitionId, kind) as { id: string } | undefined;
    return x ? this.job(x.id) : null;
  }
  setJob(
    id: string,
    state: string,
    error: string | null = null,
    result: unknown = null,
  ) {
    this.db
      .prepare(
        "UPDATE jobs SET state=?,error=?,result=COALESCE(?,result),updated_at=? WHERE id=?",
      )
      .run(
        state,
        error,
        result === null ? null : JSON.stringify(result),
        new Date().toISOString(),
        id,
      );
  }
  consumeCall(id: string) {
    const r = this.db
      .prepare("UPDATE jobs SET calls=calls+1 WHERE id=? AND calls<max_calls")
      .run(id);
    if (!r.changes)
      throw Error("已达到模型调用次数上限；任务已保留，可调整预算后恢复");
  }
  reserveCalls(id: string, count: number) {
    if (!Number.isInteger(count) || count < 1) throw Error("预算必须为正整数");
    const r = this.db
      .prepare(
        "UPDATE jobs SET calls=calls+? WHERE id=? AND calls+?<=max_calls",
      )
      .run(count, id, count);
    if (!r.changes)
      throw Error(`剩余预算不足，本阶段需要预留 ${count} 个预算单位`);
  }
  setBudget(id: string, max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw Error("预算必须为正整数");
    this.job(id);
    const changed = this.db
      .prepare(
        "UPDATE jobs SET max_calls=?,updated_at=? WHERE id=? AND calls<=?",
      )
      .run(max, new Date().toISOString(), id, max);
    if (!changed.changes) throw Error("预算总上限不能低于已消耗量");
  }
  jobControl(id: string) {
    this.job(id);
    return this.db
      .prepare(
        "SELECT action,requested_at AS requestedAt,prior_state AS priorState FROM job_controls WHERE job_id=?",
      )
      .get(id) as
      | { action: "pause" | "stop"; requestedAt: string; priorState: string }
      | undefined;
  }
  private activeJob(id: string) {
    const now = new Date().toISOString();
    return !!this.db
      .prepare(
        "SELECT 1 FROM job_runs WHERE job_id=? AND expires_at>? UNION ALL SELECT 1 FROM competition_queue q,queue_worker w WHERE q.job_id=? AND q.state='processing' AND w.expires_at>? LIMIT 1",
      )
      .get(id, now, id, now);
  }
  requestJobControl(id: string, action: "pause" | "stop") {
    if (!["pause", "stop"].includes(action)) throw Error("任务控制动作无效");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.job(id);
      if (["completed", "stopped"].includes(job.state))
        throw Error("已完成或已停止的任务不能更改；重新制作请创建新任务");
      if (this.jobControl(id)?.action === "stop" && action === "pause")
        throw Error("已请求停止，不能改为暂停");
      const now = new Date().toISOString(),
        prior = this.jobControl(id)?.priorState || job.state;
      this.db
        .prepare("INSERT OR REPLACE INTO job_controls VALUES(?,?,?,?)")
        .run(id, action, now, prior);
      const pending = this.activeJob(id);
      if (!pending) {
        const state = action === "pause" ? "paused" : "stopped";
        this.setJob(id, state);
        this.db
          .prepare(
            "UPDATE competition_queue SET state=?,updated_at=?,error=NULL WHERE job_id=?",
          )
          .run(state, now, id);
      }
      this.db.exec("COMMIT");
      return {
        action,
        pending,
        state: pending
          ? action === "pause"
            ? "pause_requested"
            : "stop_requested"
          : action === "pause"
            ? "paused"
            : "stopped",
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  resumeJob(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.job(id);
      if (
        job.state === "completed" ||
        job.state === "stopped" ||
        this.jobControl(id)?.action === "stop"
      )
        throw Error("已完成或已停止的任务不能继续；重新制作请创建新任务");
      if (this.activeJob(id))
        throw Error("任务仍在执行或等待暂停，请等待安全边界后继续");
      const resume =
        (this.jobControl(id)?.priorState || job.state) !== "pending";
      this.db.prepare("DELETE FROM job_controls WHERE job_id=?").run(id);
      const queued = !!this.db
        .prepare("SELECT 1 FROM competition_queue WHERE job_id=?")
        .get(id);
      if (queued)
        this.db
          .prepare(
            "UPDATE competition_queue SET state='queued',updated_at=?,error=NULL WHERE job_id=?",
          )
          .run(new Date().toISOString(), id);
      this.setJob(id, resume ? "failed" : "pending");
      this.db.exec("COMMIT");
      return { queued, resume };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  acquireJobRun(id: string, owner: string, leaseMs: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      // 上一次执行被强制终止时进程已不存在，租约虽未到期也不能继续拦住恢复。
      const current = this.db
        .prepare("SELECT owner,expires_at FROM job_runs WHERE job_id=?")
        .get(id) as { owner: string; expires_at: string } | undefined;
      if (current && current.expires_at > now && ownerAlive(current.owner))
        throw Error("该任务已有执行进程，请勿重复恢复");
      const job = this.job(id);
      if (
        ["completed", "paused", "stopped"].includes(job.state) ||
        this.jobControl(id)
      )
        throw Error("任务当前不可执行，请先检查状态");
      this.db
        .prepare("INSERT OR REPLACE INTO job_runs VALUES(?,?,?)")
        .run(id, owner, new Date(Date.now() + leaseMs).toISOString());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  ownsJobRun(id: string, owner: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM job_runs WHERE job_id=? AND owner=? AND expires_at>?",
      )
      .get(id, owner, new Date().toISOString());
  }
  heartbeatJobRun(id: string, owner: string, leaseMs: number) {
    return !!this.db
      .prepare(
        "UPDATE job_runs SET expires_at=? WHERE job_id=? AND owner=? AND expires_at>?",
      )
      .run(
        new Date(Date.now() + leaseMs).toISOString(),
        id,
        owner,
        new Date().toISOString(),
      ).changes;
  }
  releaseJobRun(id: string, owner: string) {
    this.db
      .prepare("DELETE FROM job_runs WHERE job_id=? AND owner=?")
      .run(id, owner);
  }
  /** 最终状态与控制请求在同一事务决定，避免完成与暂停请求竞态。 */
  finishJob(
    id: string,
    state: "completed" | "failed",
    error: string | null = null,
    result: unknown = null,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const action = this.jobControl(id)?.action;
      const actual =
        action === "pause" ? "paused" : action === "stop" ? "stopped" : state;
      this.setJob(id, actual, error, result);
      this.db.exec("COMMIT");
      return actual;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  artifact(jobId: string, kind: string, path: string, model: string | null) {
    this.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), jobId, kind, path, model, new Date().toISOString());
  }
  artifacts(jobId: string) {
    return this.db
      .prepare(
        "SELECT kind,path,model,created_at FROM artifacts WHERE job_id=? ORDER BY created_at",
      )
      .all(jobId);
  }
  recentSubmissionArtifacts(jobId: string, limit = 21) {
    const job = this.job(jobId);
    return this.db.prepare(
      `SELECT a.job_id AS jobId,a.path,a.created_at AS createdAt,c.title
       FROM artifacts a JOIN jobs j ON j.id=a.job_id
       JOIN competitions c ON c.id=j.competition_id
       WHERE a.kind='submission' AND j.state='completed'
         AND j.competition_id<>?
       GROUP BY a.job_id,a.path
       ORDER BY MAX(a.created_at) DESC,a.path LIMIT ?`,
    ).all(job.competitionId, Math.max(1, Math.min(100, Math.floor(limit)))) as
      { jobId: string; path: string; createdAt: string; title: string }[];
  }
  enqueue(id: string, redo = false): boolean {
    this.competition(id);
    const existing = this.db
      .prepare("SELECT state FROM competition_queue WHERE competition_id=?")
      .get(id) as { state: string } | undefined;
    if (existing) {
      if (
        !redo ||
        existing.state === "processing" ||
        existing.state === "queued"
      )
        return false;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const changed = !!this.db
          .prepare(
            "UPDATE competition_queue SET state='queued',job_id=NULL,redo=1,added_at=?,updated_at=?,error=NULL WHERE competition_id=? AND state IN ('completed','failed','stopped')",
          )
          .run(new Date().toISOString(), new Date().toISOString(), id).changes;
        if (changed)
          this.db
            .prepare("DELETE FROM queue_reviews WHERE competition_id=?")
            .run(id);
        this.db.exec("COMMIT");
        return changed;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    if (
      !redo &&
      ["completed", "paused", "stopped"].includes(
        this.latestJob(id, "automatic")?.state || "",
      )
    )
      return false;
    // 不同链接转发的同一场比赛：活跃队列有就不重复排队；已完成的非 redo 也不再排队。
    if (this.activeCoreConflict(id)) return false;
    if (!redo && this.finishedCoreConflict(id)) return false;
    const now = new Date().toISOString();
    return !!this.db
      .prepare("INSERT OR IGNORE INTO competition_queue VALUES(?,?,?,?,?,?,?)")
      .run(id, "queued", null, redo ? 1 : 0, now, now, null).changes;
  }
  /** 发现阶段只保存为候选；候选必须审核通过后才会转入可处理队列。 */
  addCandidate(id: string): boolean {
    this.competition(id);
    const existing = this.db
      .prepare("SELECT state FROM competition_queue WHERE competition_id=?")
      .get(id) as { state: string } | undefined;
    if (existing) return false;
    // 同一场比赛常被多所学校转发：标题剥壳后相同就不再重复入候选。
    if (this.activeCoreConflict(id)) return false;
    const now = new Date().toISOString();
    return !!this.db
      .prepare("INSERT OR IGNORE INTO competition_queue VALUES(?,?,?,?,?,?,?)")
      .run(id, "candidate", null, 0, now, now, null).changes;
  }
  /** 活跃队列（候选/等待处理/处理中）里同核心名的其他赛事；用于防止同一赛事经不同链接重复入队。 */
  private activeCoreConflict(id: string): string | null {
    const key = competitionCoreKey(this.competition(id).title);
    if (!key) return null;
    const rows = this.db
      .prepare(
        "SELECT q.competition_id AS cid, c.title FROM competition_queue q JOIN competitions c ON c.id=q.competition_id WHERE q.state IN ('candidate','queued','processing')",
      )
      .all() as { cid: string; title: string }[];
    return (
      rows.find(
        (r) => r.cid !== id && competitionCoreKey(r.title) === key,
      )?.cid || null
    );
  }
  /** 已收尾（完成/暂停/停止）的同核心名赛事；防止另一链接的转发把已经做完的比赛再次排队。 */
  private finishedCoreConflict(id: string): string | null {
    const key = competitionCoreKey(this.competition(id).title);
    if (!key) return null;
    const rows = this.db
      .prepare(
        "SELECT q.competition_id AS cid, c.title FROM competition_queue q JOIN competitions c ON c.id=q.competition_id WHERE q.state IN ('completed','paused','stopped')",
      )
      .all() as { cid: string; title: string }[];
    return (
      rows.find(
        (r) => r.cid !== id && competitionCoreKey(r.title) === key,
      )?.cid || null
    );
  }
  private queueSelect(search?: string, reviewStatus?: string) {
    const clauses: string[] = [],
      params: string[] = [];
    if (search?.trim()) {
      clauses.push("instr(lower(c.title || ' ' || c.url), lower(?)) > 0");
      params.push(search.trim());
    }
    if (reviewStatus) {
      clauses.push("COALESCE(r.decision,'unreviewed') = ?");
      params.push(reviewStatus);
    }
    return {
      sql: `FROM competition_queue q JOIN competitions c ON c.id=q.competition_id LEFT JOIN queue_reviews r ON r.competition_id=q.competition_id${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`,
      params,
    };
  }
  queue() {
    const base = this.queueSelect();
    return this.db
      .prepare(
        `SELECT q.competition_id AS competitionId,c.title,c.url,q.state,q.job_id AS jobId,q.added_at AS addedAt,q.updated_at AS updatedAt,q.error,COALESCE(r.decision,'unreviewed') AS reviewStatus,r.reason AS reviewReason,r.source_url AS reviewUrl,r.quote AS reviewQuote,r.deadline AS reviewDeadline,r.reviewer AS reviewedBy,r.reviewed_at AS reviewedAt ${base.sql} ORDER BY q.added_at,q.rowid`,
      )
      .all(...base.params);
  }
  queueStats() {
    const row = this.db
      .prepare(
        `SELECT count(*) AS total,sum(q.state='candidate') AS candidate,sum(q.state='queued') AS queued,sum(q.state='processing') AS processing,sum(q.state='completed') AS completed,sum(q.state='failed') AS failed,sum(q.state='paused') AS paused,sum(q.state='stopped') AS stopped,sum(CASE WHEN q.state IN ('candidate','queued') AND r.decision IS NULL THEN 1 ELSE 0 END) AS unreviewed,sum(CASE WHEN q.state='queued' AND r.decision='valid' THEN 1 ELSE 0 END) AS valid,sum(CASE WHEN q.state IN ('candidate','queued') AND r.decision='needs_review' THEN 1 ELSE 0 END) AS needs_review,sum(CASE WHEN q.state IN ('candidate','queued') AND r.decision='invalid' THEN 1 ELSE 0 END) AS invalid FROM competition_queue q LEFT JOIN queue_reviews r ON r.competition_id=q.competition_id`,
      )
      .get() as Record<string, number | null>;
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value || 0]),
    ) as {
      total: number;
      candidate: number;
      queued: number;
      processing: number;
      completed: number;
      failed: number;
      paused: number;
      stopped: number;
      unreviewed: number;
      valid: number;
      needs_review: number;
      invalid: number;
    };
  }
  queueReviewCandidates(limit: number, id?: string, force = false) {
    if (!Number.isInteger(limit) || limit < 1)
      throw Error("审核数量必须为正整数");
    const condition = id ? " AND q.competition_id=?" : "";
    const review = force ? "" : " AND r.decision IS NULL";
    const params = id ? [id, limit] : [limit];
    return this.db
      .prepare(
        `SELECT q.competition_id AS competitionId,c.title,c.url,q.state,COALESCE(r.decision,'unreviewed') AS reviewStatus FROM competition_queue q JOIN competitions c ON c.id=q.competition_id LEFT JOIN queue_reviews r ON r.competition_id=q.competition_id WHERE q.state IN ('candidate','queued')${review}${condition} ORDER BY q.added_at,q.rowid LIMIT ?`,
      )
      .all(...params);
  }
  countQueueForReview() {
    return Number(
      (
        this.db
          .prepare(
            "SELECT count(*) AS count FROM competition_queue q JOIN queue_reviews r ON r.competition_id=q.competition_id WHERE q.state='queued' AND r.decision='valid'",
          )
          .get() as { count: number }
      ).count,
    );
  }
  queuePage(limit: number, offset: number, search?: string, reviewStatus?: string) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw Error("队列分页参数无效");
    const base = this.queueSelect(search, reviewStatus);
    return this.db
      .prepare(
        `SELECT q.competition_id AS competitionId,c.title,c.url,q.state,q.job_id AS jobId,q.added_at AS addedAt,q.updated_at AS updatedAt,q.error,COALESCE(r.decision,'unreviewed') AS reviewStatus,r.reason AS reviewReason,r.source_url AS reviewUrl,r.quote AS reviewQuote,r.deadline AS reviewDeadline,r.reviewer AS reviewedBy,r.reviewed_at AS reviewedAt ${base.sql} ORDER BY q.added_at,q.rowid LIMIT ? OFFSET ?`,
      )
      .all(...base.params, limit, offset);
  }
  queueCount(search?: string, reviewStatus?: string) {
    const base = this.queueSelect(search, reviewStatus);
    return Number(
      (
        this.db
          .prepare(`SELECT count(*) AS count ${base.sql}`)
          .get(...base.params) as { count: number }
      ).count,
    );
  }
  queueReviewHistory(id: string) {
    return this.db
      .prepare(
        "SELECT decision,reason,source_url AS sourceUrl,quote,deadline,reviewer,reviewed_at AS reviewedAt FROM queue_review_history WHERE competition_id=? ORDER BY reviewed_at,rowid",
      )
      .all(id);
  }
  expireQueueReviews(today: string) {
    const rows = this.db
      .prepare(
        "SELECT r.competition_id,r.deadline,r.source_url,r.quote,r.reason,r.reviewer FROM queue_reviews r JOIN competition_queue q ON q.competition_id=r.competition_id WHERE q.state='queued' AND r.decision='valid'",
      )
      .all() as {
      competition_id: string;
      deadline: string | null;
      source_url: string | null;
      quote: string | null;
      reason: string;
      reviewer: string;
    }[];
    for (const row of rows) {
      if (row.reviewer === "manual") continue;
      if (row.deadline && row.deadline < today)
        this.setQueueReview(row.competition_id, {
          decision: "invalid",
          reason: `已确认的报名或作品提交截止日期 ${row.deadline} 已过`,
          sourceUrl: row.source_url,
          quote: row.quote,
          deadline: row.deadline,
          reviewer: "system:deadline",
        });
      else if (
        !row.deadline ||
        row.deadline === today ||
        // 与 screening 的认可词表一致：截稿时间/征稿截止同样表明这是提交截止日。
        !/报名|投稿|截稿|作品.{0,5}(?:提交|征集)|提交.{0,5}作品|(?:提交|征集).{0,5}截止|征文.{0,6}止/.test(
          row.quote || "",
        ) ||
        /开始前|尚未开放|未开放报名/.test(row.reason)
      )
        this.setQueueReview(row.competition_id, {
          decision: "needs_review",
          reason: `报名或作品提交截止依据不明确，或尚未开放报名：${row.reason}`,
          sourceUrl: row.source_url,
          quote: row.quote,
          deadline: row.deadline,
          reviewer: "system:evidence",
        });
    }
  }
  setQueueReview(
    id: string,
    review: {
      decision: "valid" | "invalid" | "needs_review";
      reason: string;
      sourceUrl?: string | null;
      quote?: string | null;
      deadline?: string | null;
      reviewer: string;
    },
    expected?: { url: string; title: string },
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT c.url,c.title,q.state,q.job_id AS jobId FROM competition_queue q JOIN competitions c ON c.id=q.competition_id WHERE q.competition_id=?",
        )
        .get(id) as {
        url: string;
        title: string;
        state: string;
        jobId: string | null;
      } | undefined;
      if (!row) throw Error("赛事不在队列中");
      if (row.state === "processing")
        throw Error("赛事正在处理中，不能修改审核结果");
      if (
        expected &&
        (row.url !== expected.url || row.title !== expected.title)
      )
        throw Error("公告信息已修改，审核结果未保存，请重新审核");
      const now = new Date().toISOString(),
        args = [
          id,
          review.decision,
          review.reason,
          review.sourceUrl || null,
          review.quote || null,
          review.deadline || null,
          review.reviewer,
          now,
        ] as const;
      this.db
        .prepare("INSERT OR REPLACE INTO queue_reviews VALUES(?,?,?,?,?,?,?,?)")
        .run(...args);
      this.db
        .prepare("INSERT INTO queue_review_history VALUES(?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), ...args);
      if (row.state === "candidate" && review.decision === "valid")
        this.db
          .prepare(
            "UPDATE competition_queue SET state='queued',updated_at=?,error=NULL WHERE competition_id=?",
          )
          .run(now, id);
      else if (
        (row.state === "candidate" || row.state === "queued") &&
        !row.jobId &&
        review.decision === "invalid"
      )
        // 审核没过就丢：候选和还没被领取的排队项直接移出队列；
        // 已领取或已结束的保留队列记录，作品与历史不受影响。
        this.db
          .prepare("DELETE FROM competition_queue WHERE competition_id=?")
          .run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  updateQueue(id: string, title: string, url: string) {
    if (!title.trim()) throw Error("赛事名称不能为空");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw Error("公告地址无效");
    }
    if (!["http:", "https:"].includes(parsed.protocol))
      throw Error("公告地址必须是 HTTP 或 HTTPS");
    parsed.hash = "";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.db
        .prepare(
          "SELECT q.state,q.job_id,c.url,c.brief,EXISTS(SELECT 1 FROM jobs j WHERE j.competition_id=c.id) AS has_jobs,EXISTS(SELECT 1 FROM evidence e WHERE e.competition_id=c.id) AS has_evidence FROM competition_queue q JOIN competitions c ON c.id=q.competition_id WHERE q.competition_id=?",
        )
        .get(id) as
        | {
            state: string;
            job_id: string | null;
            url: string;
            brief: string | null;
            has_jobs: number;
            has_evidence: number;
          }
        | undefined;
      if (!item) throw Error("赛事不在队列中");
      if (item.state === "processing") throw Error("赛事正在处理中，不能修改");
      if (
        (item.job_id || item.has_jobs || item.has_evidence || item.brief) &&
        item.url !== parsed.toString()
      )
        throw Error("已有任务或来源的赛事不能更改公告地址，请新增一条赛事");
      this.db
        .prepare("UPDATE competitions SET title=?,url=? WHERE id=?")
        .run(title.trim(), parsed.toString(), id);
      this.db
        .prepare("DELETE FROM queue_reviews WHERE competition_id=?")
        .run(id);
      this.db
        .prepare(
          "UPDATE competition_queue SET updated_at=? WHERE competition_id=?",
        )
        .run(new Date().toISOString(), id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      if (String(e).includes("UNIQUE constraint"))
        throw Error("该公告地址已存在");
      throw e;
    }
  }
  deleteQueue(id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT state FROM competition_queue WHERE competition_id=?")
        .get(id) as { state: string } | undefined;
      if (!row) throw Error("赛事不在队列中");
      if (row.state === "processing") throw Error("赛事正在处理中，不能删除");
      this.db
        .prepare("DELETE FROM queue_reviews WHERE competition_id=?")
        .run(id);
      this.db
        .prepare("DELETE FROM competition_queue WHERE competition_id=?")
        .run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  retryQueue(id?: string) {
    const now = new Date().toISOString();
    return id
      ? this.db
          .prepare(
            "UPDATE competition_queue SET state='queued',updated_at=?,error=NULL WHERE state='failed' AND NOT EXISTS (SELECT 1 FROM job_controls WHERE job_id=competition_queue.job_id) AND competition_id=?",
          )
          .run(now, id).changes
      : this.db
          .prepare(
            "UPDATE competition_queue SET state='queued',updated_at=?,error=NULL WHERE state='failed' AND NOT EXISTS (SELECT 1 FROM job_controls WHERE job_id=competition_queue.job_id)",
          )
          .run(now).changes;
  }
  acquireWorker(owner: string, leaseMs: number) {
    const now = new Date().toISOString(),
      expires = new Date(Date.now() + leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lock = this.db
        .prepare("SELECT owner,expires_at FROM queue_worker WHERE id=1")
        .get() as { owner: string; expires_at: string } | undefined;
      // 上次处理进程被强制终止时，租约还没到期也应允许立刻接管，否则只能干等 5 分钟。
      if (lock && lock.expires_at > now && ownerAlive(lock.owner))
        throw Error("已有队列处理进程正在运行");
      this.db
        .prepare("INSERT OR REPLACE INTO queue_worker VALUES(1,?,?)")
        .run(owner, expires);
      this.db
        .prepare(
          "UPDATE competition_queue SET state=CASE (SELECT action FROM job_controls WHERE job_id=competition_queue.job_id) WHEN 'pause' THEN 'paused' WHEN 'stop' THEN 'stopped' ELSE 'queued' END,updated_at=?,error='上次处理进程中断，等待从检查点恢复' WHERE state='processing'",
        )
        .run(now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  heartbeatWorker(owner: string, leaseMs: number): boolean {
    return !!this.db
      .prepare(
        "UPDATE queue_worker SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?",
      )
      .run(
        new Date(Date.now() + leaseMs).toISOString(),
        owner,
        new Date().toISOString(),
      ).changes;
  }
  releaseWorker(owner: string) {
    this.db
      .prepare("DELETE FROM queue_worker WHERE id=1 AND owner=?")
      .run(owner);
  }
  claimQueue(
    owner: string,
    budget: number,
  ): { competitionId: string; jobId: string; resume: boolean } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const lock = this.db
        .prepare("SELECT owner FROM queue_worker WHERE id=1 AND expires_at>?")
        .get(now) as { owner: string } | undefined;
      if (lock?.owner !== owner) throw Error("队列处理锁已失效");
      const q = this.db
        .prepare(
          "SELECT q.competition_id,q.job_id,q.redo FROM competition_queue q JOIN queue_reviews r ON r.competition_id=q.competition_id WHERE q.state='queued' AND r.decision='valid' AND NOT EXISTS (SELECT 1 FROM job_controls jc WHERE jc.job_id=q.job_id) AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=q.job_id AND j.state IN ('paused','stopped')) ORDER BY q.added_at,q.rowid LIMIT 1",
        )
        .get() as
        | { competition_id: string; job_id: string | null; redo: number }
        | undefined;
      if (!q) {
        this.db.exec("COMMIT");
        return null;
      }
      const prior = q.job_id
        ? this.job(q.job_id)
        : q.redo
          ? null
          : this.latestJob(q.competition_id, "automatic");
      const jobId =
        prior?.id || this.createJob(q.competition_id, "automatic", {}, budget);
      if (prior && budget > prior.maxCalls) this.setBudget(jobId, budget);
      this.db
        .prepare(
          "UPDATE competition_queue SET state='processing',job_id=?,updated_at=?,error=NULL WHERE competition_id=?",
        )
        .run(jobId, now, q.competition_id);
      this.db.exec("COMMIT");
      return {
        competitionId: q.competition_id,
        jobId,
        resume: !!prior && prior.state !== "pending",
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  finishQueue(
    owner: string,
    id: string,
    state: "completed" | "failed" | "paused" | "stopped",
    error: string | null = null,
  ) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE competition_queue SET state=?,error=?,updated_at=? WHERE competition_id=? AND state='processing' AND EXISTS (SELECT 1 FROM queue_worker WHERE id=1 AND owner=? AND expires_at>?)",
      )
      .run(state, error, now, id, owner, now);
    if (!result.changes) throw Error("队列处理锁已失效，不能更新任务状态");
  }
  close() {
    this.db.close();
  }
}
