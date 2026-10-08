# Codex Collab

让同事的 Codex 通过一个 MCP + Skill 和可选本地 Runner 协作；使用**目标仓库** `agent-collab` 分支保存任务协议/事件，飞书群通过一个 Bot 下达任务与查看状态。并不共享完整私有会话，也不能向任意已打开的桌面会话注入消息。

## 运行状况

已实现：Git 账本、版本化任务状态机、身份校验的 HTTP/MCP 服务、飞书长连接适配、Runner 托管的 Codex SDK 会话、模拟飞书和模拟 Codex 的端到端自动测试。**没有真实飞书应用凭据、群权限和远端 Git 登录，尚未做真实群端到端联调或真实 Codex SDK 执行验证。**

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

## 同事接入 MCP 和 Skill

执行 `node scripts/install/install.mjs https://your-server/mcp`，将生成的 TOML 示例加入个人 Codex 配置，将 `COLLAB_TOKEN` 安全注入启动 Codex 的环境并重启。详见 `scripts/install/README.md`。安装 Skill 不会自动启动 Runner；只要桌面人工协作可不跑 Runner。MCP endpoint 用 Bearer 身份，未登录用户无法写任务。

实现细节和限制见 `docs/architecture.md`、`docs/protocol.md`、`apps/runner/README.md`。**单写服务**假设，不支持多个中心服务实例同时写 Git。
