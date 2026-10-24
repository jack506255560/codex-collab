# 旧中心服务模式（源码兼容）

日常团队接入请使用 [本机网页向导](onboarding.md)。本页保留旧 HTTP 服务操作，npm 包只分发 Peer 与本机向导；旧中心服务须从工具源码启动。

以下为保留的**旧中心服务模式**操作；不要与 Peer 混用机器人连接和命令。Peer 不使用 `localhost:38765`、HTTP 令牌或手工 `协作 分配` / `协作 交接` 命令。

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

演示目标仓库 `codex-collab-demo` 的 `main` 执行 `sh test.sh`，而任务事件在 `agent-collab`。示例任务 T-001 为故意未完成的编程任务；可用两个不同用户通过 API/MCP 和 Runner 测试。现有 T-001 未指定审核人，建议通过企微群命令创建**新任务**以获得默认管理员审核人。

## 本地启动

生成账号文件（不要放进 Git，执行完把终端输出的个人令牌安全地分发给对应用户）：

```sh
node scripts/create-accounts.mjs /tmp/collab-accounts.json alice:admin:wx_alice bob:member:wx_bob
COLLAB_REPO=/path/to/codex-collab-demo \
COLLAB_ACCOUNTS_FILE=/tmp/collab-accounts.json \
COLLAB_DATA_DIR=/tmp/collab-service \
COLLAB_REPO_ID=jack506255560/codex-collab-demo \
node apps/server/main.mjs
```

运行成功后 `curl http://127.0.0.1:38765/health`。`wx_alice` 与 `wx_bob` 需要换为企微成员的真实 `userid`，可用下方发现脚本获取。账号参数格式为 `id:role:wecom_userid`；暂时仅通过 API 使用时填 `id:role:-`。旧四段账号参数不再接受，已有账号文件与个人令牌可继续使用，补充企微身份时使用 `scripts/bind-wecom-users.mjs`。管理员身份为默认审核人；编码负责人不能与审核人为同一人。如需自动领取任务，同事机器运行：

```sh
COLLAB_REPO=/path/to/codex-collab-demo \
COLLAB_API=https://your-server \
COLLAB_TOKEN=<bob的个人令牌> COLLAB_USER_ID=bob \
COLLAB_DATA_DIR=/path/to/private-runner-data \
COLLAB_TEST_ARGV='["sh","test.sh"]' \
node apps/runner/main.mjs
```

`COLLAB_API` 单机实验可用 `http://127.0.0.1:38765`；不同机器应提供 HTTPS，且每台机器的目标仓库含 `main` 和 `agent-collab` 分支。若跨机器分发代码分支，需要在服务和 Runner 均设置 `COLLAB_PUSH=1`，保证 origin 可访问且个人 Git 凭据已配置。服务向 `agent-collab` 推送账本，Runner 向 `codex/task-*` 推送代码；**没有凭据会失败**。不能直接把 localhost 地址给其他同事。

## 企业微信群接入

1. 在企业微信创建支持 API 长连接的智能机器人，取得 Bot ID 和 Secret，并加入协作群。它通过官方 `@wecom/aibot-node-sdk` 建立出站 WebSocket，无需公网回调。一个 Bot 对应这一个中心服务，由私有账号文件区分成员。
2. 在本机交互终端设置 `WECOM_BOT_ID`、`WECOM_BOT_SECRET` 后，运行 `node scripts/discover-wecom.mjs`。等待认证成功，再在目标群 @机器人发送文本。脚本只输出 `chatid` 和 `userid`，不输出正文。记录群和成员 ID 后，按 `Ctrl-C` 停止发现脚本，再启动服务；同一个机器人只保留一个连接。
3. 新账号直接按上方三段格式生成；已有账号可运行 `node scripts/bind-wecom-users.mjs <旧账号文件> <新账号文件> 'alice:<真实userid>' 'bob:<真实userid>'`，再将 `COLLAB_ACCOUNTS_FILE` 指向新文件。此脚本保留个人令牌哈希，不改原文件。不同账号不能绑定相同 `userid`。
4. 启动中心服务时同时设置 `WECOM_BOT_ID`、`WECOM_BOT_SECRET` 和 `WECOM_CHAT_IDS`，多个群 ID 用逗号分隔。凭据保存在本机私有环境，群 ID 和成员 ID 不提交到 Git。未配置机器人时只启用 HTTP/MCP API。
5. 在允许的群由已映射成员依次验证：`协作 创建 写一个功能 | 验收一;验收二`、管理员 `协作 分配 T-... bob`、`协作 状态 T-...`。Bob 的 Runner 领取后，提交代码与测试证据并请求审查；指定审核人核对结果后执行 `协作 审核 T-... 通过` 或 `协作 审核 T-... 退回`，管理员最终执行 `协作 完成 T-...`。批准和完成均需真人明确操作。

认证成功、群消息到达、群回复和主动任务通知需分别验证。排查无回复时可临时设置 `COLLAB_WECOM_DIAGNOSTICS=1` 并重启服务；诊断不输出正文、凭据或群/成员 ID。Runner 需单独启动，HTTP 服务不会代为启动它。

当前只支持企微；新群任务明确写入 `channel: "wecom"`。历史任务的原始来源保留，不会被自动改写成企微来源；缺少通道或属于其他通道的任务不能在企微群查询，也不会向企微群发送通知。API 任务可继续通过已授权 API/MCP 操作。

## 同事接入 MCP 和 Skill

执行 `node scripts/install/install.mjs https://your-server/mcp`，将生成的 TOML 示例加入个人 Codex 配置，将 `COLLAB_TOKEN` 安全注入启动 Codex 的环境并重启。详见 `scripts/install/README.md`。安装 Skill 不会自动启动 Runner；只要桌面人工协作可不跑 Runner。MCP endpoint 用 Bearer 身份，未登录用户无法写任务。

实现细节和限制见 `docs/architecture.md`、`docs/protocol.md`、`apps/runner/README.md`。**单写服务**假设，不支持多个中心服务实例同时写 Git。
