import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { queueSummary } from '../dist/ui.js';

test('终端队列概览按实际任务状态统计',()=>{assert.deepEqual(queueSummary([{state:'queued'},{state:'queued'},{state:'processing'},{state:'completed'},{state:'failed'}]),{queued:2,processing:1,completed:1,failed:1});});
test('非交互输入保留命令行帮助，显式界面给出清晰提示',async()=>{const run=promisify(execFile);const help=await run(process.execPath,['dist/cli.js'],{cwd:process.cwd()});assert.match(help.stdout,/ui/);await assert.rejects(run(process.execPath,['dist/cli.js','ui'],{cwd:process.cwd()}),/交互界面需要终端/);});
