/**
 * officecli 执行辅助：可执行文件约定与版面审查一致（COMPETE_OFFICECLI 覆盖），
 * 供需要真实读写 Office 文件的制作环节使用。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const officecliPath = () => process.env.COMPETE_OFFICECLI || "officecli";

/** 运行一条 officecli 命令，返回 stdout；超时或非零退出抛错。 */
export async function runOfficecli(args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await exec(officecliPath(), args, {
    timeout,
    windowsHide: true,
    maxBuffer: 16_000_000,
  });
  return stdout;
}

/** officecli 是否可用。 */
export async function officecliAvailable(): Promise<boolean> {
  try {
    await runOfficecli(["--version"], 15_000);
    return true;
  } catch {
    return false;
  }
}
