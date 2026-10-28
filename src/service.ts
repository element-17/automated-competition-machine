import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import type { AppConfig } from './config.js';
import { authHeaders } from './opencode.js';

/** 本地未启动时复用项目自带 OpenCode；远端服务由用户管理。 */
export async function ensureService(cfg:AppConfig):Promise<()=>void>{
 const connect=async()=>OpenCode.make({baseUrl:cfg.opencodeUrl,headers:authHeaders()}).server.info({signal:AbortSignal.timeout(1500)});
 try{await connect();return ()=>{};}catch{}
 const url=new URL(cfg.opencodeUrl);if(!['localhost','127.0.0.1'].includes(url.hostname)||url.protocol!=='http:')throw Error('无法连接 OpenCode 服务；远端服务须先启动并配置认证');
 if(!process.env.OPENCODE_PASSWORD)process.env.OPENCODE_PASSWORD=randomBytes(24).toString('hex');
 const binary=fileURLToPath(new URL(`../node_modules/@opencode/cli/bin/${process.platform==='win32'?'opencode.exe':'opencode'}`,import.meta.url));
 if(!existsSync(binary))throw Error('缺少 OpenCode，请先运行 npm ci');
 let child:ChildProcess;try{child=spawn(binary,['serve','--hostname','127.0.0.1','--port',url.port||'80'],{stdio:'ignore',windowsHide:true,env:process.env});}catch(e){throw Error(`OpenCode 启动失败：${e instanceof Error?e.message:String(e)}`);}
 const onInterrupt=()=>{stop();process.exit(130);};const onTerminate=()=>{stop();process.exit(143);};
 const stop=()=>{process.off('exit',stop);process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);if(child.exitCode===null)child.kill();};
 process.once('exit',stop);process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate);
 let spawnError:Error|undefined;child.once('error',e=>{spawnError=e;});
 for(let i=0;i<30;i++){if(spawnError||child.exitCode!==null){stop();throw Error(`OpenCode 启动失败或端口被占用：${spawnError?.message||child.exitCode}`);}try{await connect();return stop;}catch{await new Promise(r=>setTimeout(r,500));}}
 stop();throw Error('OpenCode 启动超时，请检查端口、密码和网络配置');
}
