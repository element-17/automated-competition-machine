import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, extname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { RuntimeName } from './models.js';

/** Agent 运行时。体积较大，不随 npm ci 安装：本机已装 CLI 时只需下载很小的 SDK，否则下载完整版到 runtimes/。 */
export const runtimes:Record<RuntimeName,{label:string;pkg:string;version:string;size:string;sdkSize?:string;note:string}>={
 'claude-code':{label:'Claude Code',pkg:'@anthropic-ai/claude-agent-sdk',version:'0.3.312',size:'约 290 MB',sdkSize:'约 55 MB',note:'Anthropic 协议，可接 Claude、DeepSeek 等兼容服务'},
 codex:{label:'Codex',pkg:'@openai/codex-sdk',version:'0.165.0',size:'约 470 MB',sdkSize:'约 1 MB',note:'OpenAI Responses API'},
 opencode:{label:'OpenCode',pkg:'opencode-ai',version:'1.19.5',size:'约 400 MB',note:'支持 Anthropic、OpenAI 兼容和 Gemini 协议'},
};
export const runtimeRoot=()=>resolve(process.env.COMPETE_RUNTIME_DIR||fileURLToPath(new URL('../../runtimes',import.meta.url)));
export const runtimeDir=(name:RuntimeName)=>join(runtimeRoot(),name);
const modules=(name:RuntimeName)=>join(runtimeDir(name),'node_modules');
const packageDir=(name:RuntimeName)=>join(modules(name),...runtimes[name].pkg.split('/'));
const readJSON=(file:string)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
const manifest=(name:RuntimeName)=>readJSON(join(packageDir(name),'package.json'));
/** SDK（或 OpenCode 包）是否已下载到 runtimes/。 */
export const isInstalled=(name:RuntimeName)=>!!manifest(name);
export const installedVersion=(name:RuntimeName)=>manifest(name)?.version as string|undefined;
const isFile=(path:string)=>{try{return statSync(path).isFile();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};

/** 完整下载时随 SDK 一起安装的平台可执行文件。 */
function bundledBinary(name:RuntimeName){const dirOf=(scope:string)=>{try{return readdirSync(join(modules(name),scope));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}};
 if(name==='claude-code')return dirOf('@anthropic-ai').some(x=>x.startsWith('claude-agent-sdk-'));if(name==='codex')return dirOf('@openai').some(x=>x.startsWith('codex-')&&x!=='codex-sdk');return isInstalled(name);}

const codexTriple=()=>({'win32-x64':['win32-x64','x86_64-pc-windows-msvc'],'win32-arm64':['win32-arm64','aarch64-pc-windows-msvc'],'linux-x64':['linux-x64','x86_64-unknown-linux-musl'],'linux-arm64':['linux-arm64','aarch64-unknown-linux-musl'],'darwin-x64':['darwin-x64','x86_64-apple-darwin'],'darwin-arm64':['darwin-arm64','aarch64-apple-darwin']} as Record<string,[string,string]>)[`${process.platform}-${process.arch}`];
let globalRoot:string|null|undefined;
/** npm 全局目录；COMPETE_NPM_GLOBAL_ROOT 可指定，避免每次都调用 npm。 */
function npmGlobalRoot(){
 if(process.env.COMPETE_NPM_GLOBAL_ROOT)return process.env.COMPETE_NPM_GLOBAL_ROOT;
 if(globalRoot!==undefined)return globalRoot;
 if(process.platform==='win32'){
  if(!process.env.APPDATA)throw Error('无法确定 npm 全局目录：缺少 APPDATA');
  globalRoot=join(process.env.APPDATA,'npm','node_modules');
  return globalRoot;
 }
 if(!process.env.npm_config_prefix)throw Error('无法确定 npm 全局目录：缺少 npm_config_prefix');
 globalRoot=join(process.env.npm_config_prefix,'lib','node_modules');
 return globalRoot;
}
/** 在 PATH 中找真正的可执行文件；跳过 Windows 上 npm 生成的 .cmd 包装脚本。 */
function onPath(names:string[]){for(const dir of (process.env.PATH||'').split(delimiter).filter(Boolean))for(const n of names){const file=join(dir,n);if(isFile(file))return file;}return null;}
const exe=(n:string)=>process.platform==='win32'?[`${n}.exe`]:[n];
/** 本机已安装的 CLI：先看 npm 全局包，再看 PATH。 */
function findSystem(name:RuntimeName):string|null{const root=npmGlobalRoot();
 if(name==='claude-code'){if(root){const m=readJSON(join(root,'@anthropic-ai','claude-code','package.json'));const bin=typeof m?.bin==='string'?m.bin:m?.bin?.claude;if(bin&&!/\.(c|m)?js$/.test(bin)&&isFile(join(root,'@anthropic-ai','claude-code',bin)))return join(root,'@anthropic-ai','claude-code',bin);}return onPath(exe('claude'));}
 if(name==='codex'){const t=codexTriple();if(root&&t){const file=join(root,'@openai','codex','node_modules','@openai',`codex-${t[0]}`,'vendor',t[1],'bin',exe('codex')[0]!);if(isFile(file))return file;}return null;}
 if(root){const m=readJSON(join(root,'opencode-ai','package.json'));const bin=typeof m?.bin==='string'?m.bin:m?.bin?.opencode;if(bin&&!/\.(c|m)?js$/.test(bin)&&isFile(join(root,'opencode-ai',bin)))return join(root,'opencode-ai',bin);}return onPath(exe('opencode'));}
const systemCache=new Map<RuntimeName,{path:string;version:string|null}|null>();
/** 重新检测本机运行时，例如用户刚安装了 CLI。 */
export const clearRuntimeCache=()=>{systemCache.clear();globalRoot=undefined;};
/** 本机可执行文件及版本；COMPETE_SYSTEM_RUNTIMES=0 时不检测（用于测试或强制使用下载版）。 */
export function systemRuntime(name:RuntimeName){if(process.env.COMPETE_SYSTEM_RUNTIMES==='0')return null;if(systemCache.has(name))return systemCache.get(name)!;const path=findSystem(name);let found=null;
 // Version probing starts a child process and blocks the interactive menu. The executable
 // path is enough for runtime selection; task execution still uses the actual binary.
 if(path)found={path,version:null};systemCache.set(name,found);return found;}

export type RuntimeMode='bundled'|'system'|'needs-sdk'|'missing';
/** bundled：完整下载；system：SDK 已下载并使用本机 CLI；needs-sdk：本机有 CLI 但缺 SDK；missing：都没有。 */
export function runtimeStatus(name:RuntimeName):{mode:RuntimeMode;ready:boolean;version:string|null;path:string|null}{
 const sys=systemRuntime(name);if(isInstalled(name)&&bundledBinary(name))return {mode:'bundled',ready:true,version:installedVersion(name)??null,path:null};
 if(sys)return name==='opencode'||isInstalled(name)?{mode:'system',ready:true,version:sys.version,path:sys.path}:{mode:'needs-sdk',ready:false,version:sys.version,path:sys.path};
 return {mode:'missing',ready:false,version:null,path:null};}
export const runtimeReady=(name:RuntimeName)=>runtimeStatus(name).ready;
/** 用于界面显示，不含易被终端按双宽字符渲染的符号。 */
export function runtimeStateText(name:RuntimeName){const s=runtimeStatus(name),v=s.version?` ${s.version}`:'';return s.mode==='bundled'?`已下载${v}`:s.mode==='system'?`使用本机${v}`:s.mode==='needs-sdk'?`本机已装${v}，缺 SDK`:'未下载';}
const missing=(name:RuntimeName)=>{const s=runtimeStatus(name);return Error(s.mode==='needs-sdk'?`${runtimes[name].label} 运行时未下载 SDK：已找到本机版本 ${s.version??''}，只需下载 SDK（${runtimes[name].sdkSize}）；请在“Agent 设置 → 运行时下载”中下载，或运行 compete runtime-install ${name}`:`${runtimes[name].label} 运行时未下载；请在“Agent 设置 → 运行时下载”中下载，或运行 compete runtime-install ${name}`);};

/** 在独立目录中用固定版本安装，不改动项目依赖。sdkOnly 时跳过平台可执行文件，改用本机 CLI。 */
export async function installRuntime(name:RuntimeName,onOutput?:(line:string)=>void,options:{sdkOnly?:boolean}={}){
 const dir=runtimeDir(name),r=runtimes[name];if(options.sdkOnly&&(name==='opencode'||!systemRuntime(name)))throw Error(`${r.label} 没有可用的本机版本，需下载完整版`);
 mkdirSync(dir,{recursive:true});if(!existsSync(join(dir,'package.json')))writeFileSync(join(dir,'package.json'),JSON.stringify({name:`compete-runtime-${name}`,private:true})+'\n');
 const args=['install','--no-audit','--no-fund','--save-exact',...(options.sdkOnly?['--omit=optional']:[]),`${r.pkg}@${r.version}`];const tail:string[]=[];
 // npm 遇到网络异常、代理或 registry 卡住时会长时间不输出；没有超时会让人以为程序死了。
 const timeoutMs=Number(process.env.COMPETE_INSTALL_TIMEOUT_MS||900_000);
 await new Promise<void>((done,fail)=>{
  const child=spawn(process.platform==='win32'?'npm.cmd':'npm',args,{cwd:dir,shell:process.platform==='win32',windowsHide:true,env:process.env});
  const read=(chunk:Buffer)=>{for(const line of chunk.toString().split(/\r?\n/).filter(Boolean)){tail.push(line);if(tail.length>20)tail.shift();onOutput?.(line);}};child.stdout.on('data',read);child.stderr.on('data',read);
  const timer=setTimeout(()=>{child.kill();fail(Error(`${r.label} 下载超过 ${Math.round(timeoutMs/60000)} 分钟，已中止；可设置 COMPETE_INSTALL_TIMEOUT_MS 延长，或先检查 npm 代理与网络`));},timeoutMs);timer.unref();
  const finish=(run:()=>void)=>{clearTimeout(timer);run();};
  child.once('error',e=>finish(()=>fail(e)));child.once('close',code=>finish(()=>code===0?done():fail(Error(`${r.label} 下载失败（npm 退出码 ${code}）：\n${tail.join('\n')}`))));});
 if(!isInstalled(name))throw Error(`${r.label} 安装后仍找不到 ${r.pkg}`);
}
export function removeRuntime(name:RuntimeName){rmSync(runtimeDir(name),{recursive:true,force:true});}

/** 从运行时目录加载 SDK 入口；不会回退到项目 node_modules，避免“未下载”判断失真。 */
export async function loadRuntime<T>(name:RuntimeName):Promise<T>{const m=manifest(name);if(!m)throw missing(name);const exp=m.exports?.['.']??m.exports;const entry=typeof exp==='string'?exp:exp?.import??exp?.default??m.module??m.main??'index.js';return await import(pathToFileURL(join(packageDir(name),entry)).href) as T;}
/** 没有完整下载时交给 SDK 的本机可执行文件路径；完整下载时返回 undefined，使用 SDK 自带的版本。 */
export const runtimeExecutable=(name:RuntimeName)=>{const s=runtimeStatus(name);return s.mode==='system'?s.path!:undefined;};
/** OpenCode 的启动命令：优先已下载版本，其次本机版本；JS 入口用当前 Node 执行，保证 Windows 可直接启动。 */
export function runtimeCommand(name:RuntimeName,bin:string):{command:string;args:string[]}{const m=manifest(name);if(!m){const sys=systemRuntime(name);if(sys)return {command:sys.path,args:[]};throw missing(name);}
 const rel=typeof m.bin==='string'?m.bin:m.bin?.[bin];if(!rel)throw Error(`${runtimes[name].label} 缺少可执行文件 ${bin}`);const file=join(packageDir(name),rel);return /\.(c|m)?js$/.test(extname(file))?{command:process.execPath,args:[file]}:{command:file,args:[]};}
/** 运行时共用的隔离主目录，存放其缓存和会话，不读取用户全局配置。 */
export const runtimeHome=(name:RuntimeName)=>{const dir=join(runtimeDir(name),'home');mkdirSync(dir,{recursive:true});return dir;};
