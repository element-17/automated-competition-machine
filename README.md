# Competition CLI

一个基于 OpenCode V2 和 LangGraph.js 的高校赛事 CLI。核心命令 `auto` 会自动搜索多类高校赛事、读取规则、追查往届作品、独立提出不同方案并比较，再根据交付要求尝试制作作品。作品文字由 Gemini 写作，另一个模型负责分析、编码和评审；比赛给定任务时不会强行编造选题。

## 一条命令运行

在项目目录安装并编译，设置 Gemini 和 Claude API 密钥后：

```powershell
npm ci
npm run build
$env:GOOGLE_GENERATIVE_AI_API_KEY = '<你的 Gemini API 密钥>'
$env:ANTHROPIC_API_KEY = '<你的 Claude API 密钥>'
node dist/cli.js auto
```

本地 OpenCode 未启动时，`auto` 会使用项目内安装的 OpenCode 自动启动服务，并在结束时关闭。默认从多个类别搜索，将发现的赛事加入持久队列，再按入队顺序逐个处理，默认每次最多处理 3 场，每场最多预留 30 次模型调用；可通过 `--limit 5 --budget 40` 修改。已经完成的赛事不会重复入队；需要重新处理时使用 `--redo`。这个次数限制并不等同于费用上限；OpenCode 可能在单次模型请求内部重试。

## 赛事队列

队列保存在数据目录的 `competition.sqlite`，重启进程或服务器不会丢失。`scan` 只发现并入队，`work` 不重新搜索，按先进先出顺序处理已入队赛事；`auto` 将发现和处理组合起来。每场赛事的任务、结果及 LangGraph 检查点也保存在数据目录中。

```powershell
node dist/cli.js scan --query '大学生 设计大赛 作品征集'
node dist/cli.js queue
node dist/cli.js work --limit 3 --budget 40
node dist/cli.js retry                  # 将所有失败项重新排队
node dist/cli.js retry <赛事ID>         # 仅重新排队一个失败项
node dist/cli.js enqueue --all          # 将以前发现的赛事加入队列
node dist/cli.js enqueue <赛事ID> --redo # 重新处理一场已完成赛事
```

队列状态为 `queued`（等待）、`processing`（处理中）、`completed`（流程已结束，不等于作品通过验收）或 `failed`（失败）。失败项保留错误和任务 ID，`retry` 后 `work` 使用原任务检查点继续；完成后的作品与待核实事项请查看 `status <任务ID>`。发现模型服务不可用时，尚未领取的赛事会继续留在队列。队列使用 SQLite 租约保证同一数据目录同时只有一个处理进程；若进程被强制终止，最多等约 5 分钟租约到期后再运行 `work`，处理中项目会重新排队并尝试恢复。正常运行期间租约会自动续期。

每个任务的输出、研究来源、方案和待确认项保存在 `data/jobs/<任务ID>`；`result.json` 的 `ready_for_review` 表示文件已生成且自动检查未发现待处理项，**不是获奖或符合所有参赛规则的保证**。`needs_review` 则列出尚未完成或需要核实的内容。`node dist/cli.js status <任务ID>` 查看状态；队列任务失败后用 `retry <赛事ID>` 和 `work --budget 40` 恢复，非队列任务可使用 `resume <任务ID> --budget 40`。

可以限定搜索方向或指定单条公告：

```powershell
node dist/cli.js auto --query '大学生 设计大赛 作品征集' --limit 3
node dist/cli.js auto --url 'https://主办方公告地址' --budget 40
```

自动路线支持文本、DOCX、文字型 PDF、PPTX、PNG/JPG、网页原型 HTML/ZIP，按当届交付清单选择，不使用固定作品模板。图片需要所配置的图片模型可用；软件原型由 OpenCode 代码 Agent 制作，目前只执行文件与 JavaScript 静态检查，尚未运行交互测试。PPT 会检查页数、边界和部分文本重叠，并尝试使用 LibreOffice 和 Poppler 渲染逐页预览；视觉内容的自动复核尚未实现，结果会标记为待检查。格式不支持、原题/真实数据缺失或官方模板无法识别时会保留缺口，不会伪造材料。含 `{字段}` 的官方 DOCX/PPTX 模板会尝试保留版式并填写；复杂表格、空白横线等模板尚不保证自动填写。

选题类赛事并发生成三个独立方向，再为每个方向检索相似作品，交给第二模型结合来源比较。任务目录的 `concept-diversity.json` 是词面重复提示，不代表原创性证明；`concept-review.json` 保存比较结果。`research-coverage.json` 保存搜索与来源访问记录，并区分已核对的往届获奖名单、公开作品和评分细则；资料不足会列为待核实。可在配置文件的 `sources` 中添加赛事资讯页，`auto` 会读取页面中的赛事链接并同时执行搜索。

全网赛事与参赛要求经常变化，搜索结果可能漏掉赛事或包含过期公告；不能保证覆盖所有比赛。系统不自动报名、支付或提交作品。

## 环境

- Node.js 24；项目依赖中已固定 OpenCode CLI 2.2.0，无需另行全局安装。
- OpenCode 服务端能够访问 Gemini 和 Claude API，分别通过 `GOOGLE_GENERATIVE_AI_API_KEY` 及 `ANTHROPIC_API_KEY` 配置。具体凭据方式参见 [OpenCode providers](https://opencode.ai/v2/docs/providers/)。图片模型可在配置的 `image` 字段更改。
- 联网搜索默认复用 OpenCode 的 `tinyfish` 提供商；可在配置文件中改成 OpenCode 支持的其他提供商并配置对应密钥。
- 本地 PPT 预览需要安装 LibreOffice（`soffice`）和 Poppler（`pdftoppm`），可用 `COMPETE_SOFFICE` 和 `COMPETE_PDFTOPPM` 指定可执行文件路径；缺少时任务会记录缺口。容器镜像包含这两个工具及中文字体。

```powershell
npm ci
npm run build
Copy-Item config/config.example.json config/config.json
```

在 `config/config.json` 填写有效的模型 ID 和学校信息。写作模型必须为 Google Gemini；评审模型必须来自另一提供商。模型版本和可用性因账号而异，先以 `doctor` 和 OpenCode 模型列表确认；示例名称并不保证账号可用。

`auto` 不要求手动启动服务。其他命令或希望长时间复用服务时，也可在单独终端启动本项目内的 OpenCode 服务：

```powershell
$env:OPENCODE_PASSWORD = '<自行设置服务密码>'
$env:GOOGLE_GENERATIVE_AI_API_KEY = '<你的 Gemini API 密钥>'
$env:ANTHROPIC_API_KEY = '<你的 Anthropic API 密钥>'
./node_modules/.bin/opencode serve --hostname 127.0.0.1 --port 4096
```

另开一个终端，设置同一个 `OPENCODE_PASSWORD` 后运行 `node dist/cli.js doctor`。`doctor` 只检查服务连接和模型是否出现在目录，不会验证凭据有效性；真实调用还可能因为无效凭据、模型权限或配额失败。密钥仅保存在你选择的运行环境中，不要提交到版本库。`OPENCODE_TOKEN` 也可用于支持 bearer token 的服务器。项目不提供或保存 API 密钥。

## 命令

```powershell
node dist/cli.js doctor
node dist/cli.js scan --query '2026 大学生 翻译大赛 通知'
node dist/cli.js scan --url 'https://主办方公告地址'
node dist/cli.js list
node dist/cli.js research <赛事ID>
node dist/cli.js show <赛事ID>
node dist/cli.js produce <赛事ID> --type translation --source ./原文.txt --target 中文 --format docx
node dist/cli.js produce <赛事ID> --type report --source ./材料.txt --instructions '围绕社区问题提出方案' --format docx
node dist/cli.js status <任务ID>
node dist/cli.js resume <任务ID> --budget 20
```

`scan` 的结果只是待核查的候选，可能包含往届、重复、失效公告。用 `research` 检索当届规则和往届资料，并核实结果。研究报告引用来源；`show` 可查看证据摘要和查询日志。若搜索服务失败或资料未公开，结果记录缺口，不代表相关作品不存在。

手动 `produce` 目前支持翻译和报告；材料支持 `.txt`、`.md`、可提取文字的 `.pdf` 和 `.docx`，输出支持 `.txt`、`.md`、`.docx`。PDF 扫描件需要先 OCR。`auto` 的作品能力和限制见前文。报名及提交由用户完成。

任务的模型调用次数上限默认 12 次，可用 `--budget` 指定，并可在恢复时提高总上限。这个上限是**调用次数**，不是金额或 token 预算。模型请求失败也计入次数。初译、独立评审、Gemini 修订和最终文件保存在 `data/jobs/<任务ID>`；SQLite 检查点用于恢复失败的阶段。

## Linux 容器

```sh
docker build -t competition-cli .
docker run --rm -v "$PWD/data:/data" \
  -e OPENCODE_PASSWORD -e GOOGLE_GENERATIVE_AI_API_KEY -e ANTHROPIC_API_KEY \
  competition-cli doctor
docker run --rm -v "$PWD/data:/data" \
  -e OPENCODE_PASSWORD -e GOOGLE_GENERATIVE_AI_API_KEY -e ANTHROPIC_API_KEY \
  competition-cli scan --query '大学生 翻译比赛 征稿'
```

容器内 OpenCode 只监听本地地址，每次执行命令时启动；数据目录挂载后跨运行保留。可通过宿主机 cron 或 systemd 定时运行 `auto`。需要自定义配置时，将配置文件挂载到容器并传入 `--config`。不要让两个容器同时写入同一 SQLite 数据目录。中文 PDF 需要可嵌入的中文 TTF 字体：通过 `COMPETE_PDF_FONT` 指定字体文件的容器内路径并挂载该文件；图片中的中文也需要系统安装中文字体。

## 测试

```sh
npm test
```

自动测试使用模拟模型，不消耗 API 费用；真实模型及实际参赛作品仍需配置凭据后单独联调。Node 的内置 SQLite 在部分 Node 版本会显示 experimental 提示。
