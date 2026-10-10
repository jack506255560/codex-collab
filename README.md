# Codex Collab

让同事的 Codex 通过一个 MCP + Skill 和可选本地 Runner 协作；使用**目标仓库** `agent-collab` 分支保存任务协议/事件，飞书/企业微信群通过一个 Bot 下达任务与查看状态。并不共享完整私有会话，也不能向任意已打开的桌面会话注入消息。

## 运行状况

已实现 Git 签名账本、MCP、企微/飞书适配、后台 Codex SDK Runner，以及桌面手动交接。2026-10-09 已在真实企业微信群完成后台 SDK Alice → Bob 的准确 SHA 接力，最终测试通过并等待真人审核；这不等于绑定已有桌面对话，跨两台机器仍未验证。

**指定已有桌面对话轮询模式 `desktop_poll` 已完成本机真实闭环验证**。据用户于 2026-10-10 确认，真实企业微信群任务已由 Alice 的既有 Codex 对话接单执行，再由 Bob 的既有 Codex 对话接力；本机适配器负责收群消息/发通知，MCP 提供对话绑定、原子接单、隔离工作树、续租、固定测试和交接，已有对话的 app heartbeat 负责轮询。跨两台机器部署仍未验证。当前全套自动测试 62 项通过。操作见 [`docs/desktop-poll.md`](docs/desktop-poll.md)。

## 推荐：Peer 模式（不部署中心服务）

如果不想运行共享 HTTP 服务，使用已实现的 Peer 模式：每位同事本机安装 Skill + stdio MCP，并运行自己的 Peer Runner；任务、签名事件、候补分配和交接 commit 直接写入目标仓库的 `agent-collab` 分支。企业微信机器人是可选的命令/通知适配器，不是调度真相。

面向团队成员的 npm CLI 接入说明见 [`docs/onboarding.md`](docs/onboarding.md)。公开 npm 包名为 `xuym-codex-collab`，安装后使用 `codex-collab` 命令：

```sh
npm install --global xuym-codex-collab
codex-collab --help
```

```sh
pnpm peer:create-team /abs/team.json repo-id alice frontend \
  alice:admin:frontend,backend bob:member:frontend carol:member:backend
pnpm peer:init-agent /abs/team.json /abs/bob.private.json \
  /abs/work/repo /abs/private/bob-data /abs/private/bob-peer.json
pnpm peer doctor /abs/private/bob-peer.json
pnpm peer start /abs/private/bob-peer.json
```

MCP 创建的任务默认保留给当前桌面 Codex，完成并 push 后调用 `handoff_task`；旧自动模式下群任务路由给本地 Runner；配置 `desktop_poll` 后群任务等待指定已有对话的 heartbeat 认领。完整初始化、企业微信配置、候补和故障恢复见 [`docs/peer.md`](docs/peer.md)。

**群 @ 后在新的后台 SDK 会话执行（不是已有桌面对话）**：见 [`docs/local-automatic-test.md`](docs/local-automatic-test.md)。新建 automatic 测试环境后，Alice/Bob Runner 都自动执行，按 frontend → backend 路由交接；可安全复用旧私有机器人配置，但启动前必须停旧连接。Bot 对应 Runner 创建的新 Codex SDK 会话，**不是已有桌面对话**。

**本机用两个 Codex 对话和两个企业微信机器人手动模拟同事**：见 [`docs/local-peer-test.md`](docs/local-peer-test.md)。`peer:setup-local` 一次生成隔离 demo、副本身份和项目 MCP，不改 CC Switch、不推送 GitHub；第二个对话可用 `claim_desktop_task` 手动接力。本页不自动唤起对话；要让指定已有对话轮询接单，使用 [`docs/desktop-poll.md`](docs/desktop-poll.md)。

以下为保留的**旧中心服务模式**操作；不要与上面的 Peer 测试混用机器人连接和命令。Peer 不使用 `localhost:38765`、HTTP 令牌或手工 `协作 分配` / `协作 交接` 命令。

## Codex 之间的代码接力

1. 已绑定身份的 Alice 在桌面 Codex 用 MCP `create_task` 创建任务（或在群里发 `协作 创建 ...`），无需先把任务分配给她；她也可以使用自己已被分配的任务。桌面 Codex 安装 Skill/MCP **不会自动被唤醒**。
2. Alice 在目标仓库 `codex/*` 分支完成自己的部分，执行可信测试并提交 Git commit；跨机器时还要将分支推送到共同的 `origin`。不要将密钥、聊天全文写入仓库。
3. Alice 用 `read_task` 获取最新 `state.seq`，调用 MCP `handoff_task`：传 `task_id`、`expected_seq`、`summary`（已完成与下一步）、`branch`、完整 `commit` SHA、真实 `tests` 结果。服务会核实分支 tip 与 commit，写入目标仓库的 `agent-collab` 账本，任务进入 `waiting`。
4. Alice 作为管理员在同一个企微群 @机器人，发送 `协作 交接 T-... bob`；服务器验证身份后分配任务。Bob 本机持续运行的个人 Runner 领取任务，从交接 commit 建独立 worktree 和新的 Codex SDK 会话；完成后写代码分支、测试证据和 `review_requested`。只有真人审核可批准/完成。

目前 `协作 交接` 只路由给一个已配置的企微 Bot；仅在**更新并重启中心服务**后生效。要显示两个不同的机器人身份并分别接受 @ 消息，还需增加同一中心服务的双 Bot 路由；不要运行两个服务并发写同一账本。MCP/Skill 负责桌面 Codex **主动发布交接**，Runner 才负责同事端的**自动领取和新建会话**。

## 两个仓库本地测试

Node.js >= 20，pnpm 11；在本仓库执行：

```sh
pnpm install --frozen-lockfile
pnpm test
```

演示目标仓库 `codex-collab-demo` 的 `main` 执行 `sh test.sh`，而任务事件在 `agent-collab`。示例任务 T-001 为故意未完成的编程任务；可用两个不同用户通过 API/MCP 和 Runner 测试。现有 T-001 未指定审核人，建议通过飞书命令创建**新任务**以获得默认管理员审核人。

## 本地启动

生成账号文件（不要放进 Git，执行完把终端输出的个人令牌安全地分发给对应用户）：

```sh
node scripts/create-accounts.mjs /tmp/collab-accounts.json alice:admin:ou_alice bob:member:ou_bob
COLLAB_REPO=/path/to/codex-collab-demo \
COLLAB_ACCOUNTS_FILE=/tmp/collab-accounts.json \
COLLAB_DATA_DIR=/tmp/collab-service \
COLLAB_REPO_ID=jack506255560/codex-collab-demo \
node apps/server/main.mjs
```

运行成功后 `curl http://127.0.0.1:38765/health`。`ou_alice` 与 `ou_bob` 需要换为飞书用户的**真实** `open_id`。管理员身份为默认审核人；编码负责人不能与审核人为同一人。如需自动领取任务，同事机器运行：

```sh
COLLAB_REPO=/path/to/codex-collab-demo \
COLLAB_API=https://your-server \
COLLAB_TOKEN=<bob的个人令牌> COLLAB_USER_ID=bob \
COLLAB_DATA_DIR=/path/to/private-runner-data \
COLLAB_TEST_ARGV='["sh","test.sh"]' \
node apps/runner/main.mjs
```

`COLLAB_API` 单机实验可用 `http://127.0.0.1:38765`；不同机器应提供 HTTPS，且每台机器的目标仓库含 `main` 和 `agent-collab` 分支。若跨机器分发代码分支，需要在服务和 Runner 均设置 `COLLAB_PUSH=1`，保证 origin 可访问且个人 Git 凭据已配置。服务向 `agent-collab` 推送账本，Runner 向 `codex/task-*` 推送代码；**没有凭据会失败**。不能直接把 localhost 地址给其他同事。

## 飞书接入

1. 飞书开放平台创建企业自建应用，启用机器人、申请“以应用身份发送消息”和接收群消息所需权限；启用 `im.message.receive_v1` 事件，选择**长连接**接收并发布/授权应用（具体权限以飞书控制台当前要求为准）。
2. 将 Bot 加到群中，先在本机设置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 并运行 `node scripts/discover-feishu.mjs`；在目标群发一条普通消息，终端只打印 `chat_id` 和 `sender_open_id`（不会保存正文），确认所有同事的 open_id 后停止该脚本，再填入账号文件与 `FEISHU_CHAT_IDS` 允许列表。**不要**写死或提交 App Secret。
3. 启动中心服务时追加：`FEISHU_APP_ID=... FEISHU_APP_SECRET=... FEISHU_CHAT_IDS=oc_...`。看到 WebSocket 订阅日志后，在允许的群由已映射成员发：`协作 创建 写一个功能 | 验收一;验收二`，管理员 `协作 分配 T-... bob`，所有人 `协作 状态 T-...`。Runner 提交审核请求后审核人 `协作 审核 T-... 通过` 或 `协作 审核 T-... 退回`，最后管理员 `协作 完成 T-...`。
4. 检查群回复、服务日志、目标仓库 `agent-collab` 事件与本机代码分支。未配置飞书凭据时可以跑本地模拟 E2E；模拟通过**不等于**真实群接通。

## 本机接企业微信群（已有隔离 demo 和两个 Runner 时）

**先在企业微信管理端创建/配置支持 API 长连接的智能机器人**，获取 Bot ID 和**新** Secret，加入测试群。此前曾在聊天里暴露的 Secret 已不安全：必须先重置，不要再次发送到聊天或提交 Git。此处用的是「智能机器人 API 模式」，不是只有 webhook URL 的群机器人；连接通过官方 `@wecom/aibot-node-sdk` WebSocket 出站发起，不需要公网地址。确认组织管理员允许此类型机器人、目标群确实能收到其群消息。一个 Bot 足够；它通过账号映射和本地两个 Runner 分配身份，不对应两个桌面 Codex 会话。群消息能否到达以真机发现为准，尝试在群内 @ 机器人发送文本。

当前单机测试目录可以这样找（不要打印里面的令牌或环境文件）：

```sh
cd "$HOME/codex-collab"
# 确保 Node.js >= 20 已安装并且 node 位于 PATH。
root="$(cat "$HOME/.codex-collab-local-test/current")"
# 仅在你的本机交互终端输入；不要把实际值放在命令行参数或聊天中。
printf 'Bot ID: '; IFS= read -r WECOM_BOT_ID
printf '新 Bot Secret（不回显）: '; IFS= read -rs WECOM_BOT_SECRET; echo
export WECOM_BOT_ID WECOM_BOT_SECRET
node scripts/discover-wecom.mjs
```

等待输出 `WeCom authenticated`，在目标群里向机器人发送文本，例如 `@机器人 协作 状态 T-NONE`；发现脚本仅输出 `{"chatid":"...","userid":"..."}`，**不会输出正文**。这一步如果只有认证而没有群消息，不代表群已接通：检查群是否已加入机器人、消息触发方式和企业管理员配置。在发现脚本按 `Ctrl-C` 关闭连接，再继续下面步骤；**同一个机器人不要让发现脚本和服务同时建立连接**。至少记下一个真实群 `chatid` 及你（管理员 alice）的 `userid`，若同事要在群里发命令，再收集其 `userid`。不要猜 ID、不要贴到 Git。以下命令的引号和交互输入要保留：

```sh
printf '刚发现的群 chatid: '; IFS= read -r WECOM_CHAT_IDS
printf '你自己的 userid（alice）: '; IFS= read -r ALICE_WECOM_USERID
export WECOM_CHAT_IDS
node scripts/bind-wecom-users.mjs "$root/accounts.json" "$root/accounts.wecom.json" "alice:$ALICE_WECOM_USERID"
# 可选：另一位真人需在群里操作时，用他的 userid 重建私有文件；不要把两人的 userid 填成同一个。
# node scripts/bind-wecom-users.mjs "$root/accounts.json" "$root/accounts.team.json" "alice:$ALICE_WECOM_USERID" 'bob:<同事的真实userid>'
# 新文件只保留原有的个人 token 哈希，原有 Runner 令牌不会变化。
. "$root/private.env"
export COLLAB_ACCOUNTS_FILE="$root/accounts.wecom.json"
# 仅停原中心服务，保持两个 Runner；先确认旧 PID 确实是本工具的服务。
old="$(cat "$root/server.pid")"
ps -p "$old" -o command=
# 仅在确认该进程属于当前仓库的 apps/server/main.mjs 后，才手动执行：kill "$old"
node apps/server/main.mjs
```

上面最后一条**前台运行**，该终端不要退出；另开终端 `curl http://127.0.0.1:38765/health` 检查服务。若提示端口占用，先核对旧服务 PID，勿盲目杀其他进程。若群中收到真实回复才算接通。群里的任务示例：

1. `协作 创建 给 greet.sh 增加 --upper 行为 | sh test.sh 通过;sh greet.sh --upper 输出 HELLO, WORLD;保留原有默认输出`，记下新任务 `T-...`；不要重复使用历史任务。
2. `协作 分配 T-... bob`；本机 Bob Runner 自动领取并在隔离副本创建 `codex/task-*` 代码分支。Alice Runner 可读取审查任务并写私有审查记录。
3. `协作 状态 T-...`；人工核对 `git -C "$root/demo" branch --list 'codex/task-*'`、`sh test.sh`（需要在**任务分支**的 worktree 执行；`main` 故意未完成，不能直接把它的失败当任务失败）和 `$root/server-data` 的 Git 账本；不能把 Runner 记录当人工批准。
4. 确认代码和测试证据后，由 **alice 真人**发 `协作 审核 T-... 通过`，再发 `协作 完成 T-...`；这两个动作不会由 Runner 自动执行。失败就 `协作 审核 T-... 退回`。

**注意**：发现、认证、模拟 E2E、真实群消息送达、群回复、主动任务通知是不同的成功条件；逐项核实。这里使用 `$root/demo` 隔离副本，不修改或推送原始 demo 仓库。`COLLAB_PUSH` 单机保持默认关闭；源仓库与真实企业账号信息勿放入 Git。若之前本机 Runner 不在运行，查看 `ps` 与 `apps/runner/README.md`；不要以为启动 HTTP 服务就会自动启动 Runner。

## 同事接入 MCP 和 Skill

执行 `node scripts/install/install.mjs https://your-server/mcp`，将生成的 TOML 示例加入个人 Codex 配置，将 `COLLAB_TOKEN` 安全注入启动 Codex 的环境并重启。详见 `scripts/install/README.md`。安装 Skill 不会自动启动 Runner；只要桌面人工协作可不跑 Runner。MCP endpoint 用 Bearer 身份，未登录用户无法写任务。

实现细节和限制见 `docs/architecture.md`、`docs/protocol.md`、`apps/runner/README.md`。**单写服务**假设，不支持多个中心服务实例同时写 Git。
