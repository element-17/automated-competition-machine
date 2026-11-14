import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/core/store.js";
import { competitionCoreKey } from "../dist/competition/dedupe.js";
import { discoverCompetitions } from "../dist/competition/discovery.js";

test("competitionCoreKey 剥掉外壳后合并同一赛事的不同公告", () => {
  const base =
    "关于举办2026年 挑战杯 长春工业大学大学生创业计划竞赛的通知-共青团长春工业大学委员会";
  const key = competitionCoreKey(base);
  assert.equal(key, "2026挑战杯长春工业大学大学生创业计划竞赛");
  // 同一场比赛换个网站转发：外壳不同、核心相同
  assert.equal(
    competitionCoreKey(
      "转发：关于开展2026年“挑战杯”长春工业大学大学生创业计划竞赛的通知",
    ),
    key,
  );
  assert.equal(
    competitionCoreKey("2026年挑战杯长春工业大学大学生创业计划竞赛的预通知"),
    key,
  );
  // 没有赛事词或剥完太短：不构成合并依据
  assert.equal(competitionCoreKey("关于做好2026年春季学期教学安排的通知"), null);
  assert.equal(competitionCoreKey("竞赛"), null);
});

const TITLE = "关于举办2026年“挑战杯”长春工业大学大学生创业计划竞赛的通知";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "dedupe-"));
  const store = new Store(dir);
  return {
    store,
    add: (title, url) => store.addCompetition(url, title),
    done: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("活跃队列已有同核心名赛事时，另一链接的转发不再进候选或处理队列", async () => {
  const s = await setup();
  try {
    const first = s.add(TITLE, "https://a.edu.cn/notice");
    const second = s.add(TITLE, "https://b.edu.cn/repost");
    assert.ok(s.store.addCandidate(first));
    assert.ok(!s.store.addCandidate(second), "同核心名候选被拒绝");
    // 候选审核通过进入处理队列后，另一链接 enqueue 也被拒绝
    s.store.setQueueReview(first, {
      decision: "valid",
      reason: "人工确认",
      reviewer: "manual",
    });
    assert.ok(!s.store.enqueue(second), "同核心名已排队，不再入队");
    // 不同赛事不受影响
    const other = s.add(
      "2026年全国大学生数学建模竞赛通知",
      "https://c.edu.cn/cumcm",
    );
    assert.ok(s.store.addCandidate(other));
  } finally {
    await s.done();
  }
});

test("同核心名赛事已完成时，非 redo 不再排队；redo 显式放行", async () => {
  const s = await setup();
  try {
    const first = s.add(TITLE, "https://a.edu.cn/notice");
    const second = s.add(TITLE, "https://b.edu.cn/repost");
    assert.ok(s.store.enqueue(first));
    s.store.setQueueReview(first, {
      decision: "valid",
      reason: "通过",
      reviewer: "manual",
    });
    const owner = "worker-test";
    s.store.acquireWorker(owner, 300_000);
    const task = s.store.claimQueue(owner, 10);
    assert.ok(task);
    s.store.finishJob(task.jobId, "completed");
    s.store.finishQueue(owner, first, "completed");
    assert.ok(!s.store.enqueue(second), "同核心名已完成，不再入队");
    // 完成赛事的另一链接可作为新候选重新审核；活跃候选存在时非 redo 不会再排队
    assert.ok(s.store.addCandidate(second), "重新发现可作为候选重新审核");
    assert.ok(!s.store.enqueue(second), "候选已在队列，非 redo 不会重复排队");
    s.store.deleteQueue(second);
    assert.ok(s.store.enqueue(second, true), "redo 显式重新处理放行");
  } finally {
    await s.done();
  }
});

test("审核没过就丢：queued 状态未领取的条目判无效后也移出队列", async () => {
  const s = await setup();
  try {
    const first = s.add(TITLE, "https://a.edu.cn/notice");
    // CLI scan --url 的入口直接入队为 queued，不走候选态
    assert.ok(s.store.enqueue(first));
    s.store.setQueueReview(first, {
      decision: "invalid",
      reason: "资格不符",
      reviewer: "manual",
    });
    assert.equal(
      s.store.queue().filter((r) => r.competitionId === first).length,
      0,
      "无效的排队项已移出队列",
    );
  } finally {
    await s.done();
  }
});

test("discovery 对同核心名不同链接只保留一条", async () => {
  const s = await setup();
  try {
    const results = [
      {
        title: TITLE,
        url: "https://a.edu.cn/notice",
        snippet: "报名截止 2026-05-01",
      },
      {
        title: "关于开展2026年“挑战杯”长春工业大学大学生创业计划竞赛的通知",
        url: "https://b.edu.cn/repost",
        snippet: "报名截止 2026-05-01",
      },
      {
        title: "2026年全国大学生数学建模竞赛报名通知",
        url: "https://c.edu.cn/cumcm",
        snippet: "报名截止 2026-09-01",
      },
    ];
    const gateway = { search: async () => results };
    const ids = await discoverCompetitions(s.store, gateway, "测试", [], {
      screen: false,
    });
    const titles = ids.map((id) => s.store.competition(id).title);
    assert.equal(
      titles.filter((t) => t.includes("挑战杯")).length,
      1,
      "挑战杯两个链接只入库一条",
    );
    assert.equal(titles.filter((t) => t.includes("数学建模")).length, 1);
  } finally {
    await s.done();
  }
});
