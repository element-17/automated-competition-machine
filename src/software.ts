import { mkdtemp, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load } from 'cheerio';
import JSZip from 'jszip';
import { z } from 'zod';
import type { ModelGateway } from './types.js';

const execFileAsync=promisify(execFile);
export const InterfaceCopy=z.object({title:z.string().min(1),strings:z.record(z.string(),z.string())});
export type InterfaceCopy=z.infer<typeof InterfaceCopy>;
function hash(s:string){return createHash('sha256').update(s).digest('hex');}
async function files(base:string,relative=''):Promise<string[]>{const paths:string[]=[];for(const name of await readdir(join(base,relative))){if(name==='.opencode'||name==='node_modules'||name.startsWith('.'))continue;const rel=join(relative,name);const st=await lstat(join(base,rel));if(st.isSymbolicLink())throw Error('软件作品包含符号链接，无法校验');if(st.isDirectory())paths.push(...await files(base,rel));else if(st.isFile()){if(st.size>2_000_000)throw Error('软件作品文件过大');paths.push(rel);}}return paths;}

/** 使用 OpenCode 编码 Agent；实际运行仍需后续沙箱验收。 */
export async function makeSoftware(gateway:ModelGateway,copy:InterfaceCopy,brief:unknown,idea:unknown,format:'zip'|'html',outputFolder:string):Promise<string>{
 if(!gateway.buildProject)throw Error('当前执行器不支持 OpenCode 代码 Agent');
 const workspace=await mkdtemp(join(tmpdir(),'competition-prototype-')); const copySource=`window.COMPETITION_COPY = ${JSON.stringify(copy).replace(/</g,'\\u003c')};\n`;await writeFile(join(workspace,'copy.js'),copySource,'utf8');
 const prompt=`请依据比赛要求制作可运行、无服务器依赖的静态网页软件原型。用户可见文案全部来自当前目录 copy.js 中的 window.COMPETITION_COPY，不得重写 copy.js，不得写入新的用户可见文案。生成 index.html；必须用 <script src="copy.js"></script> 引用文案。${format==='html'?'所有 CSS 和业务 JS 必须内嵌在 index.html，除了 copy.js 不依赖其他文件。':'可使用本地 CSS/JS 文件，但不得依赖在线资源或外部服务。'}不要调用 shell 或外部网络。竞赛要求：${JSON.stringify(brief)}；方案：${JSON.stringify(idea)}。`;
 await gateway.buildProject(workspace,prompt);
 if(hash(await readFile(join(workspace,'copy.js'),'utf8'))!==hash(copySource))throw Error('代码 Agent 修改了 Gemini 文案，已阻止导出');
 let html:string;try{html=await readFile(join(workspace,'index.html'),'utf8');}catch{throw Error('代码 Agent 没有生成 index.html');}
 const $=load(html);const script=$('script[src]').toArray().find(el=>/^(\.\/)?copy\.js$/.test($(el).attr('src')||''));if(!script)throw Error('网页没有引用 Gemini 文案 copy.js');
 const visible=$('body').clone();visible.find('script,style,noscript').remove();if(visible.text().trim())throw Error('网页包含未经过 Gemini 生成的静态可见文字，已阻止导出');
 const paths=await files(workspace);for(const path of paths.filter(p=>extname(p).toLowerCase()==='.js'))await execFileAsync(process.execPath,['--check',join(workspace,path)],{timeout:15_000,windowsHide:true});
 await import('node:fs/promises').then(fs=>fs.mkdir(outputFolder,{recursive:true}));
 if(format==='html'){$(script).replaceWith(`<script>${copySource.replace(/<\/script/gi,'<\\/script')}</script>`);if($('script[src],link[href]').length)throw Error('HTML 存在外部依赖，不能按单个 HTML 文件交付');const out=join(outputFolder,'submission.html');await writeFile(out,$.html(),'utf8');return out;}
 const zip=new JSZip();for(const path of paths){if(paths.length>100)throw Error('软件作品文件数量过多');zip.file(path.replace(/\\/g,'/'),await readFile(join(workspace,path)));}const out=join(outputFolder,'submission.zip');await writeFile(out,await zip.generateAsync({type:'nodebuffer'}));return out;
}
