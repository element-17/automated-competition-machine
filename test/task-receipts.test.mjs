import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  checkTaskReceipt,
  createTaskReceipt,
  taskInputHash,
} from "../dist/workflows/task-receipts.js";

test("恢复收据核对输入与实际文件，键顺序不影响身份", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-"));
  try {
    const file = join(root, "entry.txt");
    await writeFile(file, "真实作品");
    const task = { id: "a", format: "txt" },
      context = { brief: { title: "竞赛", formats: ["txt"] } };
    const receipt = await createTaskReceipt(task, context, [file], root);
    assert.equal(
      (
        await checkTaskReceipt(
          receipt,
          { format: "txt", id: "a" },
          { brief: { formats: ["txt"], title: "竞赛" } },
          [file],
          root,
        )
      ).valid,
      true,
    );
    assert.equal(
      taskInputHash(task, context),
      taskInputHash({ format: "txt", id: "a" }, context),
    );
    assert.equal(
      (await checkTaskReceipt(undefined, task, context, [file], root)).valid,
      false,
    );
    assert.equal(
      (
        await checkTaskReceipt(
          receipt,
          { ...task, format: "pdf" },
          context,
          [file],
          root,
        )
      ).valid,
      false,
    );
    assert.equal(
      (
        await checkTaskReceipt(
          receipt,
          task,
          { brief: { title: "新规则" } },
          [file],
          root,
        )
      ).valid,
      false,
    );
    assert.equal(
      (await checkTaskReceipt(receipt, task, context, [], root)).valid,
      false,
    );
    await writeFile(file, "被替换的作品");
    assert.equal(
      (await checkTaskReceipt(receipt, task, context, [file], root)).valid,
      false,
    );
    await rm(file);
    assert.equal(
      (await checkTaskReceipt(receipt, task, context, [file], root)).valid,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("拒绝任务目录外的产物及通过父目录链接绕过边界", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-boundary-"));
  try {
    const job = join(root, "job"),
      outside = join(root, "outside");
    await mkdir(job);
    await mkdir(outside);
    const file = join(outside, "entry.txt");
    await writeFile(file, "outside");
    await assert.rejects(
      createTaskReceipt({}, {}, [file], job),
      /超出任务目录/,
    );
    // Windows directory junction does not require symlink creation privileges.
    await symlink(
      outside,
      join(job, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      createTaskReceipt({}, {}, [join(job, "linked", "entry.txt")], job),
      /符号链接/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("原子保存可替换旧记录且不遗留临时文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-atomic-"));
  try {
    const path = join(root, "state.json");
    await atomicWriteJson(path, { value: 1 });
    await atomicWriteJson(path, { value: 2 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { value: 2 });
    assert.deepEqual(await readdir(root), ["state.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
