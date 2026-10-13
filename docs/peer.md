# Peer 模式：无中心服务的 Codex 协作

日常团队接入请使用 [本机网页向导](onboarding.md)：管理员分配机器人，成员导入加密包。本页保留底层静态策略与 CLI。新版签名团队历史及旧任务策略规则见 [团队登记协议](team-registry.md)。

Peer 模式不部署共享 HTTP 服务。每位同事在自己的电脑上运行同一份工具仓库中的两个本地进程：

1. **MCP stdio**：给当前桌面 Codex 调用，用于创建/读取/交接任务。
2. **Peer Runner**：持续读取目标仓库 `agent-collab` 分支，按能力和候补顺序认领任务，并通过 Codex SDK 启动一个新的隔离会话。

目标代码仓库的远程 Git 是唯一共享状态：

```text
main                         业务代码基线
codex/<agent>-...             各阶段代码分支
agent-collab                  .agent-collab/peer/tasks/... 签名任务账本
```

MCP/Skill 不能把消息注入一个已经打开的桌面 Codex 会话；自动接力由接收方电脑上的 Runner 创建新的 SDK 会话完成。

本机验证**群命令 → Alice SDK 执行 → Bob SDK 接力**见 [local-automatic-test.md](local-automatic-test.md)。这是自动执行验证，两个 Runner 都开启 `auto_execute`，不向已打开的 GUI 对话注入消息。

本机用两个桌面对话、两个企微机器人手动模拟两位同事的具体步骤见 [local-peer-test.md](local-peer-test.md)。该测试隔离 Git remote 与身份，不修改 CC Switch，Runner 仅中继通知；第二个对话由真人发送任务 ID 后手动认领。

## 参与者需要准备什么

- Node.js 20+、Git，以及目标仓库的 clone 和 push 权限。
- 一份公开的 `team.json`：仓库标识、角色、能力、候补顺序、管理员 reviewer、公钥和策略。
- 每位同事一份只留在本人电脑上的 `*.private.json`：Ed25519 私钥和 `agent_id`。
- 每位同事一份只留在本人电脑上的 `private-peer.json`：私钥、目标仓库路径、数据目录和 `team.json` 路径。
- 要自动运行同事 Codex 的电脑还要持续运行 Runner；只使用桌面手动交接时可以不开 Runner。

企业微信不是调度真相，只是命令和通知通道。可以每位同事配置一个智能机器人，也可以先只配置一个；**不能让两个 Runner 同时用同一个 Bot ID/Secret 建立连接**。

## 初始化团队

在工具仓库执行。命令会把私钥文件写入输出目录；实际团队中应通过安全渠道把每个人的私钥只交给对应成员，`team.json` 可以公开分发。

```sh
cd /path/to/codex-collab
pnpm peer:create-team \
  /abs/collab/team.json \
  jack506255560/codex-collab-demo \
  alice \
  frontend \
  alice:admin:frontend,backend:1 \
  bob:member:frontend,backend:1 \
  carol:member:backend:1
```

格式是 `agent_id:role:capability1,capability2:max_concurrent_tasks`；可选第五段是该成员的企业微信 `userid`。如果没有现成身份文件，也可单独运行：

```sh
pnpm peer:create-identity bob /abs/private/bob.private.json
```

创建脚本不会覆盖已存在的私钥、身份或团队文件。默认 route 候选按声明顺序包含所有具备能力的 agent（包括 reviewer）；要让 frontend 优先 Alice、backend 优先 Bob，在**首次创建任务前**设好对应 `routes` 的顺序。之后团队策略被事件签名固定，不能原地修改。

reviewer 管理员身份可以同时运行代码，但 `PeerRunner` 和 agent-facing MCP 都不提供批准/完成操作，最后仍由真人使用群命令或 CLI 显式审核。

## 每位同事初始化本机配置

目标仓库必须已经有 `origin/main`。每位同事在自己的 clone 上执行：

```sh
pnpm peer:init-agent \
  /abs/collab/team.json \
  /abs/private/bob.private.json \
  /abs/work/codex-collab-demo \
  /abs/private/bob-collab-data \
  /abs/private/bob-peer.json
```

配置文件会被设置为 `0600`。不要将它、私钥、Runner 日志、`.collab-data` 或企业微信 Secret 提交到任何 Git。

### 可选：配置企业微信机器人

先通过企业微信管理后台创建智能机器人，发现真实 `chatid` 和每个真人的 `userid`，并在 `team.json` 的对应 agent 上填好 `wecom_userid`。Secret 只通过当前进程环境传入：

```sh
printf '新 Secret（不回显）: '; IFS= read -rs WECOM_BOT_SECRET; printf '\n'
export WECOM_BOT_SECRET
pnpm peer:configure-wecom \
  /abs/private/bob-peer.json \
  BOT_ID \
  'chatid-1,chatid-2'
unset WECOM_BOT_SECRET
```

不要把上面的真实 Secret 放在命令历史、聊天或 Git 中；如果曾经泄露，先在企业微信后台轮换，再使用新 Secret。

同一个真人可以拥有多个独立 Agent，并使用同一个已验证 `userid`；每个 Agent 仍需独立机器人、签名身份、clone 和对话。推荐通过 [网页向导](onboarding.md#一个人使用多个机器人或模拟两个同事) 添加。旧隔离测试也可以给第二个 Bot 加 `--notify-only`，让它只发送通知；这属于测试脚本的默认设置。不要手改既有签名任务的所有者绑定，旧客户端需要统一升级后再采用多 Agent 所有权。

## 安装当前 Codex 的 Skill 和 MCP

在每位同事的电脑上执行：

```sh
pnpm peer install /abs/private/bob-peer.json
```

这个命令只复制 Skill，并生成 `~/.codex/team-collab-peer.toml.example`；它**不会覆盖 CC Switch 或现有 Codex 配置**。把示例区块人工合并到当前使用的 Codex `config.toml`，然后重启 Codex。MCP 进程使用配置文件中的私钥，不需要环境变量令牌。

## 启动和验证 Runner

```sh
pnpm peer doctor /abs/private/bob-peer.json
pnpm peer start /abs/private/bob-peer.json
pnpm peer status /abs/private/bob-peer.json
tail -f /abs/private/bob-collab-data/runner.log
```

每个 agent 使用自己的 `data_dir`。同一个 `data_dir` 会有 PID 锁，防止重复启动两个机器人连接。停止：

```sh
pnpm peer stop /abs/private/bob-peer.json
```

如果本机默认 `node` 不在 PATH，使用当前机器的 Node 20+ 或 Codex bundled Node；例如本机测试环境：

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
```

## 两种任务入口

### A. 桌面 Codex 先做自己的部分，再交给同事

通过 MCP 创建时默认是 `execution_mode=desktop`，当前桌面 Codex 保留第一阶段，不会被 Runner 抢走。工作流必须包含下一阶段，例如 `frontend > backend`：

1. `create_task` 创建任务，传入 `workflow: ["frontend", "backend"]`。
2. 当前 Codex 在自己的工作区完成 frontend，运行可信测试。
3. 在目标仓库创建并 push `codex/*` 分支。
4. `read_task` 获取最新 `seq`，调用 `handoff_task`，传完整 commit SHA、分支、测试证据和下一步摘要。
5. v3 必须审核的职责先进入 `stage_review`，由通知中的指定真人通过后才进入 `waiting`；关闭中间审核或 v2 时直接交接。Bob Runner 看到 `waiting` 状态，按 route 顺序和 lease 规则自动认领并创建新 Codex 会话。
6. Bob 完成后若还有阶段继续 handoff；最后阶段调用 `request_review`。
7. 最终指定审核人用自己的机器人或 CLI `review approved R-<seq>` 审核，再由管理员 `complete`。v2 最终审核人仍为管理员。

### B. 两个桌面对话手动接力

给两个 agent 私有配置设置 `auto_execute: false`，Runner 仍可连接不同 Bot 中继通知，但不认领/执行代码。MCP 用 `get_identity` 确认本对话身份。Alice 创建 `desktop` 任务，push 后 handoff（v3 必须审核时先由真人通过）；Bob 在第二个项目对话读取最新任务，用 `claim_desktop_task(task_id, expected_seq)` 原子保留下一阶段，随后从准确 checkpoint SHA 创建自己的分支，完成并 `request_review`。

桌面手动认领仅接受等待中的 `desktop` 工作流；遵循路由、候选顺序和并发容量。保留成功后状态为 `desktop`、assignee 为 Bob，不再由 Runner 自动认领。**此保留没有执行 lease，也没有下线自动候补**；需要真人继续对话，或管理员取消后创建新任务。若需要 lease/自动候补，使用自动 Runner 模式。

### C. 企业微信群自动分配

群中由有权限的真人向自己的机器人发送：

```text
@机器人 协作 创建 [frontend>backend] 增加登录页 | npm test 通过;登录页可访问
@机器人 协作 状态 T-...
@审核人自己的机器人 协作 审核 T-... R-7 通过
@审核人自己的机器人 协作 审核 T-... R-7 退回 | 修改意见
@机器人 协作 完成 T-...
```

本节默认底层 SDK 配置，群创建的任务是 `automatic`；网页向导的 `desktop_poll` 则由绑定的已有对话轮询。SDK 配置中，两个接收方配置必须允许 `auto_execute`（默认开启；`false` 会禁用执行）。`commands_enabled=false` 只禁用 Bot 群命令入口，不禁用 Runner 执行。任务会按 `team.json` 的 route 自动分配，不需要手工 @ Bob 的机器人。候补规则是：首选 agent 在 claim timeout 内没有成功认领，或租约到期/运行失败，就由下一位候选人接管；所有候选失败后任务进入 `blocked`。管理员可发：

```text
@机器人 协作 重试 T-... 修复测试环境后重新执行
```

## CLI 审核和排查

```sh
pnpm peer list /abs/private/alice-peer.json
pnpm peer read /abs/private/alice-peer.json T-...
pnpm peer review /abs/private/reviewer-peer.json T-... approved R-7
pnpm peer review /abs/private/reviewer-peer.json T-... changes_requested R-7 '请补充键盘操作和测试'
pnpm peer complete /abs/private/alice-peer.json T-...
pnpm peer reopen /abs/private/alice-peer.json T-... '修复测试环境后重试'
```

v3 审核需要最新审核通知中的 R-版本号，退回必须附修改意见；旧 v2 任务仍兼容省略版本号。阶段审核规则、owner 回落和新旧任务策略见 [团队登记协议](team-registry.md)。

`probe` 通过新建临时只读 SDK 会话向当前 provider 发一条极小请求（会产生一次模型调用），不连接机器人或写任务账本；结果保存在私有 `provider-probe.json`。例如 `pnpm peer probe /abs/private/bob-peer.json`。

`doctor` 只检查本地配置和 Git 访问，不会把 Secret 打印出来；真实企业微信认证仍需看 Runner 私有日志中的 `Peer WeCom authenticated`。

每个 Runner 执行阶段保存私有 `jobs/<task-id>/<agent>-<epoch>.session.json`，关联任务与 SDK thread ID/阶段状态，不包含完整对话，也不进共享 Git。日志中的 `Peer SDK execution started` / `Peer stage published` 分别表示模型执行开始 / 通过测试后发布交接或审核事件，不要只看到 WeCom authenticated 就认定代码已执行。

## 安全与边界

- 任务事件使用团队 pinned Ed25519 公钥验证；Git commit author 不是身份认证。
- 事件只保存任务摘要、测试证据、分支和 SHA，不保存完整 Codex 私聊、SDK 输出、异常栈、凭据或本机绝对路径。
- Runner 的测试命令来自本机 `test_argv` 配置，不直接执行群消息中的命令；目标仓库和测试脚本仍必须被团队信任。
- 每次交接都校验分支 tip 必须等于声明的完整 commit SHA，并从该 SHA 创建隔离 worktree。
- 旧 lease 失效后不能继续写入；所有通知失败不会回滚已经提交的 Git 事件，Runner 会通过账本重试。
- 当前方案仍依赖共享 Git remote；如果同事没有目标仓库的 fetch/push 权限，不能完成跨机器接力。

Peer v2 JSON Schemas 为 `schemas/peer-task.schema.json` 与 `schemas/peer-event.schema.json`；旧 `task.schema.json` / `event.schema.json` 只描述中心服务 v1。运行时进一步校验签名、team hash、路由/身份、并发容量、状态机和远程分支 tip。

## 指定已有桌面对话自动轮询

新模式 `desktop_poll` 使用与 automatic 相同的签名租约/候补，但执行者是绑定的已有 Codex 对话。企微适配器配置 `auto_execute=false`；app heartbeat 调用 `poll_desktop_task`，对话执行并显式续租，`finish_desktop_task` 固定验证、推送和交接。默认 SDK 接单入口排除此模式；不使用旧 `claim_desktop_task` 的无期限手动保留。绑定/heartbeat 是不同步骤，不支持由 MCP 直接注入/实时唤醒任意桌面对话。完整配置、权限边界和验收见 [desktop-poll.md](desktop-poll.md)。
