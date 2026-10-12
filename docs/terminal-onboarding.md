# 旧终端接入工作流

新团队建议使用 [本机网页向导](onboarding.md)。本页保留旧静态 `team.json` 与终端命令；在此工作流加入成员应先收集公钥，并在创建任务前定好策略。

## 成员先生成公钥

管理员创建团队策略前，需要收齐每位成员的公钥。每位成员（包括管理员）在自己的电脑、自己的 npm 安装环境运行：

```sh
codex-collab identity create alice
```

默认生成到 `~/.config/codex-collab/identities/`。命令显示两个文件路径：

- `alice.private.json` 是本机签名私钥，权限为 `0600`。不要发送、提交 Git 或复制到其他成员电脑。
- `alice.public.pem` 是公钥，只把这个文件通过团队认可的安全渠道交给管理员。

agent ID 是任务协议里的稳定成员标识，应由团队统一命名，且只能包含英文字母、数字、下划线和连字符。创建后不要为同一 ID 重新生成身份。

## 管理员初始化团队

确认每位成员都完成上一步，并收齐所有 `.public.pem` 文件后，管理员运行：

```sh
codex-collab setup --role admin
```

向导会依次询问管理员 agent ID、能力标签、成员 agent ID 和公钥文件、每种能力的首选/候补顺序、人工审核管理员、默认能力、共享仓库标识（例如 `jack506255560/codex-collab-demo`），以及目标仓库 clone 路径。

企业微信 userid 可在初始化团队时填写，用来授权该真人通过群机器人发送协作命令。暂时没有 userid 时可以留空；该成员机器人只能发通知，不能处理群命令。不要把不同成员的真人 userid 填成同一个值。

向导在本机创建公开团队策略文件（`team.json`）和管理员自己的私钥，不会替其他成员生成私钥。团队策略在首个签名任务写入账本后就被固定；新增成员、更换公钥或调整候补顺序应在正式建任务前完成。

通过团队认可的渠道分发 `team.json`。它包含成员公钥、能力路由和仓库标识，不含私钥或企业微信 Secret。

## 成员加入团队

每位成员先 clone 目标仓库，确认 `origin/main` 可读且本机 Git 凭据有协作分支 push 权限。然后运行：

```sh
codex-collab setup --role member
```

输入管理员提供的 `team.json` 路径、本机私钥文件、目标仓库 clone 路径和固定验证命令 argv。验证命令必须是 JSON 字符串数组，例如 `["npm","test"]`；默认值是 `["sh","test.sh"]`。它不会经过 shell 拆词，群消息不能改变这条命令。

向导会生成 `0600` 本机配置和私有数据目录，检查 Git root、`origin/main` 与 push dry-run，可选写入该 clone 的本地 Codex MCP 配置和 Skill，并把本地文件加入 `.git/info/exclude`。不会改写 `origin`、全局 Codex 配置、CC Switch、业务文件或提交任何内容。

若该项目已有 `.codex/config.toml` 被 Git 跟踪，向导会拒绝自动接入；不要强行取消跟踪，应让管理员检查项目配置，再采用个人 Codex 配置中的 MCP 示例。

## 连接企业微信

每台需要接收群通知的电脑都配置自己的机器人。不要让同一个 Bot ID 同时连发现命令和 Runner。

1. 在企业微信管理端创建智能机器人，取得 Bot ID 和 Secret，并把机器人加入目标群。
2. 在本机运行 `codex-collab wecom discover`，按提示在终端输入 Bot ID 和 Secret。Secret 不回显、不进入 shell history，也不会打印消息正文。
3. 在目标群向机器人发送一条普通文本；发现命令只会显示真实 `chatid` 和发送人的 `userid`。按 `Ctrl-C` 关闭发现连接。
4. 在成员的 `codex-collab setup --role member` 向导中输入群 `chatid`，并在管理员初始化团队时为有命令权限的真人 pin 对应 `userid`。

Secret 仅在交互终端隐藏输入并保存到个人 `0600` 配置。不要将 Secret 发送到 Codex 对话、群聊或 Git。若曾泄漏，先在企业微信后台重置，再更新本机配置。

群 ID 可在同一配置中添加多个，以逗号分隔。机器人认证成功只代表连接可用；要确认群接通，需要在目标群发消息并看到该群 `chatid`。

## 绑定 Codex 对话并启动

成员向导结束时会生成私有 `bind-prompt.txt`。分别在准备代表该成员执行任务的**已有 Codex 对话**中打开目标项目、重载 MCP，并按文件内容完成：

1. 调用 `get_identity`，确认身份、项目和 `desktop_poll` 模式正确。
2. 获取该对话真实 thread ID；不可猜测或读取 Codex 私有数据库。
3. 调用 `bind_desktop_thread`，并在当前对话创建 heartbeat automation。MCP 不能自行唤醒闲置对话。
4. 立即执行一次无任务轮询，确认绑定和工具可用。

完成绑定后，成员可以在向导中选择立即启动 Runner；也可以之后在终端执行：

```sh
codex-collab start /absolute/path/to/private-peer.json
codex-collab status /absolute/path/to/private-peer.json
codex-collab doctor /absolute/path/to/private-peer.json
```

desktop_poll 下 Runner 负责本机企业微信收发和 Git 事件通知，不启动另一个 Codex SDK 会话。实际代码由 heartbeat 所属的已有 Codex 对话执行。机器人和本机网络必须保持在线，Codex 应用也要能运行 heartbeat。

同一个机器人不可同时被旧服务、发现命令和新 Runner 连接。重复启动前先检查状态；停止命令是：

```sh
codex-collab stop /absolute/path/to/private-peer.json
```

## 首次验收

确认所有成员都完成 `get_identity`、绑定真实对话、heartbeat 无任务轮询和 Runner 状态检查后，在目标群由授权真人 @ 已配置为命令入口的机器人，发一条新任务：

```text
@Alice 协作 创建 [frontend>backend] 给登录页增加密码显示切换 | npm test
```

完整验收至少检查：群回复任务 ID；Alice 的指定已有对话出现任务并提交阶段结果；Git 账本记录准确 commit SHA；下一位候补对话从该 SHA 接力；群里收到阶段通知；最终任务等待真人审核。不要把机器人在线或“任务已创建”误判为 Codex 已经开始执行。

跨机器任务依赖同一可读写 Git remote。任务不会共享完整聊天记录，不自动批准、不合并 `main`。管理员仍需人工审查最终提交并决定是否合并。
