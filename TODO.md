# TODO（交给其他 AI 执行）

每项都写明了位置、做法和完成标准。做完一项跑一次 `npm test`，必须保持全绿。
不要改动“验收不兜底”的原则：实测失败（failed）必须阻塞；无法自动核对（unverified）交人工终审。

## A. 质量相关（优先）

### A1. DOCX 排版样式升级
- 位置：`src/artifacts/artifacts.ts` 的 `markdownParagraphs` 和 `renderWork` 的 docx 分支。
- 现状：只支持标题、无序列表、引用、加粗；全文宋体 12pt，没有页边距、页码设置。Markdown 表格、有序列表、`$公式$` 会原样变成普通文字（真实任务 f172ed60 的技术方案书里大量 `| a | b |` 表格和 LaTeX 公式都是这样坏掉的）。
- 做法：
  1. 解析 Markdown 表格（表头行 + `|---|` 分隔行 + 数据行）为 `docx` 的 `Table`，表头加粗、带边框、宽度 100%。
  2. 有序列表（`1. `）用 numbering。
  3. 标题用黑体，正文宋体小四、1.5 倍行距、首行缩进 2 字符；A4，页边距 2.54cm；页脚居中页码。
  4. 行内 `$...$` 公式：先做最简处理——去掉 `$`，把 `\text{x}`→x、`\le`→≤、`\ge`→≥、`\approx`→≈、`\times`→×、`_{x}`/`^{x}` 转下标/上标 run；无法转换的保留原文。
  5. 署名行（“作者：”“学校：”“联系电话：”这类短行）不首行缩进、右对齐或左对齐均可，但要一致。
- 完成标准：在 `test/` 新增测试，用 mammoth/JSZip 回读生成的 docx，断言表格生成了 `w:tbl`、没有残留 `|---|` 和 `$`；`npm test` 全绿。

### A2. PDF 导出与 DOCX 同等排版
- 位置：`renderWork` 的 pdf 分支，目前是 pdfkit 把纯文本一把写进去，没有标题层级。
- 做法：标题按层级用不同字号；段落首行缩进；表格至少按制表对齐输出。或者改为“先生成 docx，再用 `src/artifacts/doc-render.ts` 里的转换函数导出 PDF”（需要把 `viaWord`/`viaLibreOffice` 导出一个 `docxToPdf(file, out)`）。推荐后者，样式只维护一份。
- 完成标准：有测试断言 PDF 页数 ≥1 且能提取到正文结尾。

### A3. 固定样本评测脚本（最重要的长期项）
- 位置：新建 `scripts/bench.mjs`，把根目录的 `realrun.mjs`、`realwrite.mjs` 收编进去后删除这两个文件。
- 做法：
  1. `scripts/bench/cases/*.json`：每个文件是一份 brief + 若干 evidence（参考 `realwrite.mjs` 里构造 brief 和 `putEvidence` 的写法）。先做 5 个：散文 docx、技术方案书 docx（≥7000 字）、答辩 PPT、海报 png、官方报名表模板。
  2. 脚本对每个 case 用独立的临时 `dataDir` 跑 `runOrchestration`，输出一张表：是否成功、失败原因首句、每个任务用了几轮、总耗时、`model-calls.jsonl` 里的请求数和 token。结果写到 `bench-results/<日期>.json`（加入 .gitignore）。
  3. `package.json` 加 `"bench": "npm run build && node scripts/bench.mjs"`。
- 完成标准：`npm run bench -- --case essay` 能跑通一个 case 并打印结果表。注意它会消耗真实 API 额度，不要放进 `npm test`。

### A4. 报名表类任务：缺个人信息时不要空跑 4 轮
- 位置：`src/workflows/orchestrator.ts` 的 `fillTemplate` / `runTask`。
- 现状（真实任务 4195d01c、b63f1dd1）：官方报名表需要身份证号、指导教师工作证号等用户资料里没有的字段。现在已改成“留空并列入《需要你提供的资料》”，但 `src/core/profile.ts` 的资料字段太少。
- 做法：
  1. `UserProfile` 增加：身份证号 `idNumber`、年级 `grade`、班级 `className`、QQ `qq`、指导教师电话/邮箱/院系/职称（`advisorPhone` 等）、队员列表 `members: {name, studentId, idNumber, phone, major}[]`。
  2. `src/core/config.ts` 的 profile schema、`src/ui.ts` 的 `profileMenu` 同步加字段；`profileNote` 输出新字段。
  3. `fields` 正则表补上对应关键词。
- 完成标准：`test/profile.test.mjs` 补充新字段用例；UI 能编辑队员列表。

### A5. 研究提示词里的社交平台查询做成可配置
- 位置：`src/agents/prompts.ts` 的 `research` 提示词第 83–99 行（小红书/B站/知乎/贴吧 `site:` 查询）。
- 做法：从默认提示词中移出，改为配置项 `search.socialPlatforms: boolean`（默认 false），为 true 时才拼接这一段。原因：这些站点多数需要登录，程序重新抓取会失败，白白消耗研究轮数。
- 完成标准：`test/prompts.test.mjs` 断言默认提示词不含 `xiaohongshu`，开启后包含。

### A6. PPT 版面：补充程序化检查
- 位置：`src/artifacts/artifacts.ts` 的 `validateWork`。
- 做法：增加检查——每页至少一个标题级文本（fontSize ≥ 28）；正文字号不小于 14；单页文本元素总字数超过 220 字报“文字过多”；文字颜色与背景色对比度（WCAG 相对亮度公式）低于 3 报错。
- 完成标准：`test/` 新增对应用例。

## B. 工程清理

### B1. 拆分 `src/workflows/orchestrator.ts`（约 2300 行）
- 拆成 `workflows/orchestrator/` 目录：`plan.ts`（`planWork`、`planProblems`、Plan schema）、`produce.ts`（`fillTemplate`、`writeLong`、`writeWork`、`drawImage`、`buildApp`）、`verify.ts`（`verify`、`browserVerify`、`inspectShots`、`acceptanceChecks`、`fileAcceptanceChecks`、`splitClauses`）、`package.ts`（`buildPackages`、`buildFinalBundle`）、`index.ts`（`runTask`、`runOrchestration`，并 re-export 现有全部导出名）。
- 要求：纯移动，不改逻辑；`dist/workflows/orchestrator.js` 这个导入路径必须继续可用（测试和 `realrun.mjs` 在用），可以保留一个只做 re-export 的 `orchestrator.ts`。
- 完成标准：`npm test` 全绿，diff 中没有逻辑变化。

### B2. 拆分 `src/ui.ts`（约 2500 行）
- 按菜单拆到 `src/ui/`：队列、任务详情、Agent 设置、搜索设置、用户资料、长任务设置。同样纯移动。

### B3. CI
- 新建 `.github/workflows/test.yml`：Node 24，`npm ci`，`npm test`。`package.json` 加 `"typecheck": "tsc --noEmit"`。

### B4. 依赖与版本
- `package.json`：删除未使用的 `lodash`；`engines.node` 改为 `>=24`（用了 `node:sqlite`）。
- 确认 `cheerio` 是否仍被使用（`layout-check.ts` 已不再用它），没有引用就删除。

### B5. Dockerfile
- 多阶段构建，运行层 `npm ci --omit=dev`；新增非 root 用户；加 `ARG WITH_BROWSER=0`，为 1 时执行 `npx playwright install --with-deps chromium`。
- 容器里 DOCX 版面检查依赖 LibreOffice Writer：把 `libreoffice-impress` 改成同时安装 `libreoffice-writer`。

### B6. SQLite 迁移
- 位置：`src/core/store.ts:78` 附近用 `PRAGMA table_info` + `ALTER TABLE` 的临时迁移。
- 做法：改为 `PRAGMA user_version` 递增的迁移数组；现有库视为版本 1。
- 完成标准：`test/` 新增“旧库升级”用例。

### B7. 三处空 `catch {}`
- 位置：`src/competition/screening.ts:167`、`:206`，`src/competition/sources.ts:208`。
- 做法：读上下文；如果是预期内的可忽略错误，加一行注释说明原因；否则写入 `source_attempts` 或进度事件。

### B8. 文档
- `README.md`：
  1. 修正自相矛盾：“七个内置角色/七个角色”统一为八个；“导出四个可调试的图”与后文“两个图”统一（以 `src/studio.ts` 实际导出为准）；“需要 Node.js 24”与 engines 一致。
  2. 更新已变化的行为：DOCX 版面检查现在通过 Word/LibreOffice 转 PDF 后逐页渲染，并做全文文字比对（不再是 officecli 原生截图 + HTML 辅助比对）；无法自动核对的交付规则不再让任务失败，而是列入人工终审；作品正文不再留【待补充】占位；新增环境变量 `COMPETE_SOFFICE`。
  3. 把“架构和分工”里的长段实现细节移到 `docs/acceptance.md`、`docs/resume.md`、`docs/config.md`，README 保留定位、流程图、安装、常用命令；新增一张环境变量总表（`grep -rhoE "process\.env\.[A-Z_]+" src | sort -u` 可列全）。
- 删除根目录 `OPTIMIZATION_SUMMARY.md`（内容过时且与现行规则矛盾）。

### B9. 预算显示成本估算
- 位置：`src/core/model-metrics.ts`、`src/core/job-view.ts`。
- 做法：配置里加可选单价表 `pricing: { "<provider>/<model>": { inputPerMTok, outputPerMTok } }`；`status` 和任务详情在已有 token 用量旁显示估算费用，未配置单价时显示“未配置单价”。
