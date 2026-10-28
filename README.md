# Competition CLI

一个基于 OpenCode V2 和 LangGraph.js 的高校赛事 CLI。当前已实现公开赛事发现、资料检索与规则整理，以及翻译、文本报告的 Gemini 初稿 → Claude 评审 → Gemini 修订链路。它不假设所有比赛都提交 PPT，也不会为比赛强行套用统一作品模板。

## 环境

- Node.js 24；项目依赖中已固定 OpenCode CLI 2.2.0，无需另行全局安装。
- OpenCode 服务端能够访问 Gemini 和 Claude API，分别通过 `GOOGLE_GENERATIVE_AI_API_KEY` 及 `ANTHROPIC_API_KEY` 配置。具体凭据方式参见 [OpenCode providers](https://opencode.ai/v2/docs/providers/)。
- 联网搜索默认复用 OpenCode 的 `tinyfish` 提供商；可在配置文件中改成 OpenCode 支持的其他提供商并配置对应密钥。

```powershell
npm ci
npm run build
Copy-Item config/config.example.json config/config.json
```

在 `config/config.json` 填写有效的模型 ID 和学校信息。写作模型必须为 Google Gemini；评审模型必须来自另一提供商。模型版本和可用性因账号而异，先以 `doctor` 和 OpenCode 模型列表确认；示例名称并不保证账号可用。

设置必要环境变量，在单独终端启动本项目内的 OpenCode 服务：

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

翻译和报告的材料支持 `.txt`、`.md`、可提取文字的 `.pdf` 和 `.docx`；输出支持 `.txt`、`.md`、`.docx`。PDF 扫描件需要先 OCR。可识别到唯一受支持的类型时可省略 `--type`。格式通过 `--format` 指定；如赛事要求官方模板，目前会暂停并提示人工处理。PPT、代码、图片和其他作品的制作适配器尚未实现，赛事档案仍可保存。报名及提交由用户完成。

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

容器内 OpenCode 只监听本地地址，每次执行命令时启动；数据目录挂载后跨运行保留。可通过宿主机 cron 或 systemd 定时运行 `scan`。需要自定义配置时，将配置文件挂载到容器并传入 `--config`。不要让两个容器同时写入同一 SQLite 数据目录。

## 测试

```sh
npm test
```

自动测试使用模拟模型，不消耗 API 费用；真实模型及实际参赛作品仍需配置凭据后单独联调。Node 的内置 SQLite 在部分 Node 版本会显示 experimental 提示。
