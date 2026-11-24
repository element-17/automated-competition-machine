# TODO（交给其他 AI 执行）

每项都写明了位置、做法和完成标准。做完一项跑一次 `npm test`，必须保持全绿。
不要改动“验收不兜底”的原则：实测失败（failed）必须阻塞；无法自动核对（unverified）交人工终审。

## A. 质量相关（已完成）

- [x] **A1. DOCX 排版样式升级**：已实现完整 Markdown 表格（`w:tbl`）、有序/无序列表、LaTeX 上下标公式清理、黑体标题/宋体小四/1.5 倍行距/2.54cm 页边距/页码、署名行不缩进、嵌入式图片与离线 Mermaid/Chart 高清渲染（见 `src/artifacts/artifacts.ts`、`src/artifacts/diagrams.ts`）。
- [x] **A2. PDF 导出与 DOCX 同等排版**：已导出 `docxToPdf` / `renderHtmlToPdf` / `renderPdf` / `countPdfImages`，支持正式文档同源转 PDF 与画册 `portfolio` 模式，并将 PDF 纳入 `checkLayout` 逐页视觉验收与实测图片数拦截。
- [x] **A3. 固定样本评测脚本**：已建成 `scripts/bench.mjs` 及 5 份标杆样本（`scripts/bench/cases/*.json`），移除旧版 `realrun.mjs` / `realwrite.mjs`，新增 `npm run bench` 与 `npm run typecheck`。
- [x] **A4. 报名表与扩展用户资料**：`UserProfile`、`config.ts`、`profile.ts`、`ui.ts` 已补齐身份证号、年级、班级、QQ、指导教师电话/邮箱/院系/职称与队员列表 `members`。
- [x] **A5. 社交平台查询可配置**：新增 `search.socialPlatforms`（默认 `false`），默认研究提示词不再包含小红书/贴吧查询，并移除硬编码闲鱼/淘宝查询。
- [x] **A6. PPT 语义化版式引擎与程序化检查**：新增 10 种语义化竞赛答辩母版 + 5 套主题（`src/artifacts/slide-templates.ts`），并在 `validateWork` 补齐标题字号、正文字号≥14、单页字数上限与 WCAG 对比度≥3.0 检查。

（其余额外落地的冲奖能力：数值仿真沙箱 `src/artifacts/simulation.ts`、两级评委打分卡与定向冲奖精修 `src/workflows/judge-rubric.ts`、Project Spec 单一事实源 `src/workflows/project-spec.ts`、跨赛事防撞题记忆与标杆解构、赛道可胜率前置拦截 `src/competition/winnability.ts`、可选人机协同卡点 `--interactive-gates` 及同源/轻量模型质量提醒 `modelWarnings`。）

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
