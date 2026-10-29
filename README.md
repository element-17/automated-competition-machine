# Competition CLI

高校赛事发现、研究和作品制作 CLI。项目使用 TypeScript、LangGraph.js 和 SQLite，发现赛事后进入持久队列，逐个研究并按赛事交付要求制作；不自动报名或提交。

## 架构和分工

- Gemini 官方 SDK 负责参赛方案、译文、报告、PPT 文案及修订；Gemini 不可用时不会自动换模型。
- Claude 或 DeepSeek 官方 API 负责规则提取、独立评审和选题比较。使用 Claude 时，Claude Agent SDK 可使用 WebSearch / WebFetch 多步追查往届名单、作品及学校报道；Agent 返回的地址由程序重新获取后才能作为来源。选择 DeepSeek 时，需关闭 Claude 研究 Agent，常规搜索和往届追查仍会执行。
- Codex 官方 SDK 负责静态网页原型的代码。Gemini 先提供用户文案；编码完成后校验 `copy.js` 和 HTML 静态文案，代码仍需进一步人工检查。
- Brave Search API 或用户配置的 SearXNG 提供赛事发现与研究搜索；LangGraph 和 SQLite 保存流程、证据与队列。系统不再启动或依赖 OpenCode。

当前作品支持文本、DOCX、文字型 PDF、PPTX、PNG/JPG 和静态网页 HTML/ZIP。官方格式不清、材料缺失或作品类型不受支持时保留缺口；PPT 可渲染逐页预览，尚未实现自动视觉验收；软件尚未进行浏览器交互验收。真实材料、竞赛资格、AI 规则和最终作品仍须核实。

## 安装和配置

需要 Node.js 24，以及可访问相应服务的服务器和模型权限。模型 ID 只是示例，请按账户可用情况在 `config/config.json` 中配置。

```powershell
npm ci
npm run build
Copy-Item config/config.example.json config/config.json
$env:GEMINI_API_KEY = '<Gemini API key>'
$env:ANTHROPIC_API_KEY = '<Claude API key>'
$env:OPENAI_API_KEY = '<OpenAI API key>'
$env:BRAVE_SEARCH_API_KEY = '<Brave Search API key>'
node dist/cli.js doctor
```

`OPENAI_API_KEY` 仅在生成软件原型时必需。`doctor` 检查环境变量和配置是否存在，不验证密钥、账户权限、模型、网络或额度。

也可使用 DeepSeek 评审：设置 `DEEPSEEK_API_KEY`，并在配置中将 `reviewer` 设为 `{"providerID":"deepseek","id":"deepseek-flash"}`、将 `researchAgent.enabled` 设为 `false`。Gemini 仍是唯一的作品文字撰写模型。CLI 启动时会读取项目目录的 `.env`，该文件已被 Git 忽略；环境中已有变量优先。

搜索默认需要 Brave Search API；也可把配置里的 `search` 改成：

```json
{"provider":"searxng","url":"http://127.0.0.1:8080"}
```

SearXNG 服务须启用 JSON 输出。可在 `sources` 中配置赛事列表页；系统同时搜索并读取这些页面。使用 `scan --url` 导入公告不需要搜索密钥。旧配置中的 OpenCode 地址、密码和 `searchProvider` 不再生效，请参考新示例配置迁移。

也可设置 `"search":{"provider":"sources"}`，只监测 `sources` 中配置的高校通知列表，不需要搜索密钥。此模式不是全网搜索，不支持 `--query`，不能追查不在这些页面及公告链接中的往届作品；研究结果会记录检索范围受限。各校公告可能仅限本校参赛，也可能已经过期，入队前后仍须核验。

Claude 研究 Agent 默认启用，可在 `researchAgent` 设置 `enabled`、`maxTurns` 和 `maxBudgetUsd`。禁用后仍保留原来的搜索、Claude 规则提取和证据核验，但不进行 Claude Agent 多步追查。Agent 搜索能力受账号权限、地区与网络影响。若需通过代理访问 Gemini API，可设置 `COMPETE_GEMINI_BASE_URL`；Claude API SDK 支持 `ANTHROPIC_BASE_URL`。这些地址接收对应凭据，只能指向可信服务。

## 使用

在交互终端中直接运行 `npm start` 或 `node dist/cli.js ui`，可用方向键查看队列、搜索赛事、导入公告和逐个处理。终端界面使用开源的 `@clack/prompts` 和 `cli-table3`；原有命令仍适用于脚本和服务器。

```powershell
# 发现赛事并入队
node dist/cli.js scan --query '大学生 设计大赛 作品征集'
node dist/cli.js scan --url 'https://主办方公告地址'
node dist/cli.js queue

# 根据队列逐场处理
node dist/cli.js work --limit 3 --budget 40
node dist/cli.js status <任务ID>
node dist/cli.js retry <赛事ID>
node dist/cli.js enqueue --all

# 自动发现、入队、处理
node dist/cli.js auto --limit 3 --budget 40
node dist/cli.js auto --url 'https://主办方公告地址' --budget 40
```

`research <赛事ID>` 可单独研究，`show <赛事ID>` 查看档案与来源。手动 `produce` 支持翻译和报告，使用 `node dist/cli.js produce --help` 查看参数；不属于队列的失败任务可用 `resume <任务ID> --budget 40` 恢复。

队列存储在 `data/competition.sqlite`，每场任务的检查点和产物在数据目录中。`queued` 表示等待、`processing` 表示处理中、`completed` 表示流程结束、`failed` 表示失败；完成不代表作品符合全部要求。失败后 `retry` 再运行 `work`，继续原任务。进程被强制终止后，队列租约最长约 5 分钟过期，再运行 `work` 可恢复。不要同时让多个容器使用不支持 SQLite 锁语义的网络共享目录。

LangGraph 检查点和 Agent 会话 ID 分别保存。Claude 研究会话、事件保存在任务目录 `claude-research/`；Codex 工作区和线程位于该交付物的 `workspace/`，因此恢复依赖保留整个数据目录。Agent 输出和网页均为外部信息，来源可访问并不证明其内容真实。

`--budget` 是项目侧预算单位：普通 Gemini / Claude 请求每次消耗 1，Claude 研究 Agent 预留 `maxTurns`，Codex 每次执行预留 8。它不是严格的 API 请求总数或美元上限；Codex 一个执行过程可能进行多次内部模型请求。Claude Agent 另受 `maxTurns` 和 `maxBudgetUsd` 限制。各服务商仍可能分别计费，请在服务商侧设置预算及告警。

## Linux 部署

```sh
docker build -t competition-cli .
docker run --rm -v "$PWD/data:/data" \
  -e GEMINI_API_KEY -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e BRAVE_SEARCH_API_KEY \
  competition-cli auto --limit 3 --budget 40
```

使用自定义配置时挂载配置并传 `--config`。容器包含 LibreOffice、Poppler 和中文字体用于 PPT 预览；PDF 中文输出还需要通过 `COMPETE_PDF_FONT` 指定可嵌入的中文 TTF 字体。代码 Agent 使用 Codex 的 workspace-write 沙箱并关闭网络，运行依赖宿主机支持相应沙箱；部署时应验证容器权限和隔离配置，不应自动回退到完全开放的权限。将工作目录和凭据按最小权限隔离。可用 cron 或 systemd 定期运行 `auto` 和 `work`。

## 测试

```sh
npm test
```

测试使用模拟模型和搜索服务，不消耗 API 额度。真实 Gemini、Claude Agent、Codex、搜索服务及 Linux 沙箱仍需配置有效凭据和运行环境后联调。
