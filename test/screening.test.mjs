import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../dist/core/store.js";
import { screenQueue } from "../dist/competition/screening.js";
import { processQueue } from "../dist/competition/queue.js";

test("审核逐字核对证据、持久化结果，并阻止未通过赛事进入制作", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screening-"));
  const store = new Store(dir);
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      req.url === "/expired"
        ? "<title>比赛通知</title><p>报名截止2020年10月23日。</p>"
        : "<title>比赛通知</title><p>报名截止2099年12月31日。</p>",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const good = store.addCompetition(`${base}/good`, "有效比赛"),
      bad = store.addCompetition(`${base}/bad`, "虚构证据"),
      expired = store.addCompetition(`${base}/expired`, "过期比赛");
    for (const id of [good, bad, expired]) store.enqueue(id);
    const gateway = {
      search: async () => [],
      generate: async (_role, prompt) => {
        const url = prompt.includes(`${base}/expired`)
          ? `${base}/expired`
          : prompt.includes(`${base}/bad`)
            ? `${base}/bad`
            : `${base}/good`;
        const quote = url.endsWith("/bad")
          ? "捏造的比赛通知截止日期"
          : url.endsWith("/expired")
            ? "报名截止2020年10月23日"
            : "报名截止2099年12月31日";
        return JSON.stringify({
          decision: "valid",
          reason: "公告说明了报名时间",
          deadline: url.endsWith("/expired") ? "2020-10-23" : "2099-12-31",
          source_url: url,
          quote,
        });
      },
    };
    const cfg = {
      reviewer: { providerID: "deepseek", id: "test" },
      profile: {},
    };
    const reviewed = await screenQueue(cfg, store, gateway, { limit: 3 });
    assert.deepEqual(
      reviewed.map((x) => x.decision),
      ["valid", "needs_review", "invalid"],
    );
    assert.equal(store.queueReviewHistory(good).length, 1);
    const processed = [];
    await processQueue(store, {
      limit: 3,
      budget: 10,
      run: async (task) => {
        processed.push(task.competitionId);
        store.setJob(task.jobId, "completed");
        return {};
      },
    });
    assert.deepEqual(processed, [good]);
    assert.equal(
      store.queue().find((x) => x.competitionId === bad).state,
      "queued",
    );
    assert.equal(
      store.queue().find((x) => x.competitionId === expired),
      undefined,
      "审核没过就丢：过期无效的排队项已移出队列",
    );
    assert.equal(
      store.queueReviewHistory(expired).slice(-1)[0].decision,
      "invalid",
    );
  } finally {
    server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("修改后需重新审核，移除队列时保留任务与历史", async () => {
  const dir = await mkdtemp(join(tmpdir(), "queue-edit-"));
  const store = new Store(dir);
  try {
    const id = store.addCompetition("https://example.org/a", "原名称");
    store.enqueue(id);
    store.setQueueReview(id, {
      decision: "valid",
      reason: "人工检查",
      reviewer: "manual",
    });
    store.updateQueue(id, "新名称", "https://example.org/b");
    assert.equal(store.queue()[0].reviewStatus, "unreviewed");
    assert.equal(store.queueReviewHistory(id).length, 1);
    store.setQueueReview(id, {
      decision: "valid",
      reason: "已复核",
      reviewer: "manual",
    });
    let job;
    await processQueue(store, {
      limit: 1,
      budget: 5,
      run: async (task) => {
        job = task.jobId;
        store.setJob(job, "completed");
        return {};
      },
    });
    assert.throws(
      () => store.updateQueue(id, "新名称", "https://example.org/another"),
      /已有任务/,
    );
    store.deleteQueue(id);
    assert.equal(store.queue().length, 0);
    assert.equal(store.job(job).state, "completed");
    assert.equal(store.competition(id).title, "新名称");
    assert.equal(store.queueReviewHistory(id).length, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("已过截止时间或仅有比赛时间的审核结果不会进入制作", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screening-"));
  const store = new Store(dir);
  try {
    const expired = store.addCompetition("https://example.org/expired", "过期"),
      ambiguous = store.addCompetition(
        "https://example.org/ambiguous",
        "时间不明",
      );
    store.enqueue(expired);
    store.enqueue(ambiguous);
    store.setQueueReview(expired, {
      decision: "valid",
      reason: "原先可报名",
      sourceUrl: "https://example.org/expired",
      quote: "报名截止2020年10月23日",
      deadline: "2020-10-23",
      reviewer: "deepseek/test",
    });
    store.setQueueReview(ambiguous, {
      decision: "valid",
      reason: "比赛仍在举行",
      sourceUrl: "https://example.org/ambiguous",
      quote: "竞赛时间2099年12月31日",
      deadline: "2099-12-31",
      reviewer: "deepseek/test",
    });
    const result = await processQueue(store, {
      limit: 2,
      budget: 5,
      run: async () => {
        throw Error("不应制作");
      },
    });
    assert.equal(result.length, 0);
    // 审核没过就丢：过期的排队项移出队列；依据不足的保留待人工确认
    assert.deepEqual(
      store.queue().map((x) => x.reviewStatus),
      ["needs_review"],
    );
    assert.equal(
      store.queueReviewHistory(expired).slice(-1)[0].decision,
      "invalid",
      "过期改判记录保留在审核历史",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
