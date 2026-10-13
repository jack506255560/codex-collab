# 企业微信群触发 Alice → Bob 自动接力：本机验证

> 本页使用新后台 SDK 会话，不绑定已有桌面对话；指定已有对话轮询执行见 [desktop-poll.md](desktop-poll.md)。
这份文档用于你现在想验证的流程：**在群里 @ Alice 下任务，Alice 的本机 Runner 启动 Codex SDK 写功能，Bob 的 Runner 随后自动补测试**。中间不需要给 Bob 桌面对话手动发消息，不需要部署中心服务。

> Bot 绑定的是一个本地 agent 身份和它的 Runner；每次任务阶段启动新的 SDK 会话。不是接管、唤醒或向你已打开的 Codex Desktop 对话注入消息。两个 SDK 会话仍可分别使用 Alice/Bob 的项目和模型配置，但不要以 GUI 是否出现新消息判断自动执行是否成功。

## 自动模式和你之前的桌面模式

| 项目 | 之前的桌面测试 | 这次的自动测试 |
| --- | --- | --- |
| 私有目录 | `$HOME/.codex-collab-peer-test` | `$HOME/.codex-collab-auto-test`，必须是新目录 |
| Codex 执行者 | 两个桌面对话，真人发一次任务 ID | 两个 Runner 创建新的 Codex SDK 会话 |
| `auto_execute` | 两个都 `false` | 两个都 `true` |
| 第一阶段 `frontend` | 桌面 Alice 保留 | 优先 Alice，候补 Bob |
| 第二阶段 `backend` | 真人让 Bob 手动认领 | 优先 Bob，候补 Alice |
| 企微连接 | Alice 接命令；Bob 发通知 | Alice 接命令并执行；Bob 不接命令但可执行并发通知 |
| Git | 私有本机 bare remote | 另一个私有本机 bare remote，不推送 GitHub |

**Bob 的 `commands_enabled=false` 只禁用群命令入口，不禁用自动执行。** 它不需要收到 Alice Bot 的 @ 消息，直接读取 Git 中的已签名 handoff 就会接力。本页旧测试脚本仅给 Alice 绑定 userid，Bob 保持通知模式。新网页向导支持同一个 userid 拥有多个独立 Agent，并同时开启各机器人的群命令；模拟既有 Codex 对话接力请使用 [向导中的本人多机器人流程](onboarding.md#一个人使用多个机器人或模拟两个同事)。

## 1. 生成新的自动测试环境

你已经配置好的两个 Bot ID/Secret、群 ID、Alice 的真人 userid 可以从旧私有配置复用，不用再在聊天里填写 Secret。脚本只复用 Bot 设置和显式 `codex_home`，生成新签名身份、Git 副本、数据目录；不复制旧任务，不修改原仓库或 CC Switch，不启动连接。

```sh
cd "$HOME/codex-collab"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
old="$HOME/.codex-collab-peer-test"
root="$HOME/.codex-collab-auto-test"
node scripts/peer/setup-local.mjs \
  --demo "$HOME/codex-collab-demo" \
  --out "$root" \
  --mode automatic \
  --wecom-from "$old"
node scripts/peer/cli.mjs doctor "$root/alice-peer.json"
node scripts/peer/cli.mjs doctor "$root/bob-peer.json"
```

如果输出目录已存在，不要删除或覆盖它的签名密钥/团队策略；换一个全新 `--out`，并同步修改下文的 `root`。

如果没有配置过旧环境，先按 [local-peer-test.md](local-peer-test.md) 发现群/真人 ID 并配置两个不同 Bot，或省略 `--wecom-from` 生成 automatic 配置后再配置 Bot。

生成器不会读取或改写你已有的 `$HOME/Documents/ChatGPT/alice-repo` 和 `$HOME/Documents/ChatGPT/bob-repo`；本次使用新目录下的 clone，任务执行在各自的私有 worktree 中。

## 2. 检查 Codex 模型配置

SDK 使用 Runner 的 `CODEX_HOME`，默认 `$HOME/.codex`；私有 `alice-peer.json` / `bob-peer.json` 可分别设置绝对路径 `codex_home`。未显式配置时，两者可以共用你当前 CC Switch 管理的模型/provider 配置；它们有独立任务目录和会话，不要求两套账号。

这一步**不会修改 CC Switch**。但是桌面 Codex 当前可以聊天，并不等于 SDK CLI 已验证同一 provider 可用；`doctor` 也不会发模型请求。可先运行下面的显式探测：只向当前 provider 发一条极小请求，不连 Bot、不修改任务账本或源代码，超时 120 秒；它会产生一次模型调用费用。

```sh
node scripts/peer/cli.mjs probe "$root/alice-peer.json"
```

返回 `status: passed` 才说明 SDK 的模型往返成功；若 Bob 使用不同 `codex_home`，再单独 `probe "$root/bob-peer.json"`。测试文件和原始响应不输出；仅在私有数据目录保存 `provider-probe.json` 的状态与 thread ID。探测成功也不等于整个代码执行/群通知成功。若 CC Switch 依赖本机代理，该代理要持续在线；模型/provider 是否接受 SDK 请求以实际运行结果为准。

不要打印 `auth.json`、整个 `config.toml`、私有 peer JSON 或环境变量。不要为了运行绕过 sandbox 或把 Bot Secret 传给 Codex；Runner 的子进程环境有 allowlist。

## 3. 停旧连接，再启动两位自动执行者

**同一个 Bot ID 不能让旧/新 Runner 或发现脚本同时建立连接。** 下面停止操作会中断旧目录的通知，先确认旧桌面测试已不需要通知；旧代码和账本都保留。如果还有旧中心服务/发现脚本，按原启动终端或 PID 核对后停止，勿盲目杀进程。

```sh
cd "$HOME/codex-collab"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
old="$HOME/.codex-collab-peer-test"
root="$HOME/.codex-collab-auto-test"
node scripts/peer/cli.mjs stop "$old/alice-peer.json"
node scripts/peer/cli.mjs stop "$old/bob-peer.json"
node scripts/peer/cli.mjs start "$root/alice-peer.json"
node scripts/peer/cli.mjs start "$root/bob-peer.json"
node scripts/peer/cli.mjs status "$root/alice-peer.json"
node scripts/peer/cli.mjs status "$root/bob-peer.json"
```

两个 Runner 的最新启动日志应显示 `automatic claim/fallback is Git-backed` 和 `Peer WeCom authenticated`：

```sh
tail -n 20 "$HOME/.codex-collab-auto-test/alice-data/runner.log"
tail -n 20 "$HOME/.codex-collab-auto-test/bob-data/runner.log"
```

只有认证成功还不算任务成功；继续发送下面的真实群命令。

## 4. 群里只下达一次任务

使用绑定给 Alice 的真人账号，在已允许的群 @ Alice Bot（不要 @ Bob Bot 创建）：

```text
@Alice 协作 创建 [frontend>backend] Alice阶段仅修改greet.sh支持--upper并保留默认和姓名参数，Bob阶段仅扩展test.sh覆盖四种新旧行为 | sh greet.sh输出hello, world;sh greet.sh Alice输出hello, Alice;sh greet.sh --upper输出HELLO, WORLD;sh greet.sh --upper Alice输出HELLO, ALICE;sh test.sh通过并覆盖四种行为
```

选择企业微信真实的 @，以当前机器人实际名称为准。每次验证创建**新任务**，保存回复中的 `T-...`。任务标题包含分工是因为 `frontend`/`backend` 是路由标签，不是限制某个文件的强制 ACL。

预期流程：

1. Alice Bot 回复已创建，workflow 是 `frontend → backend`。
2. Alice Runner 认领，Alice Bot 发 `claimed`；日志出现 `Peer SDK execution started`。
3. Alice SDK 完成、固定测试通过并提交推送后，Alice Bot 发 `handoff`。
4. Bob Runner 从 Alice 的 checkpoint 完整 SHA 创建 worktree，Bob Bot 发 `claimed`，随后 `review_requested`。
5. 最终状态 `review`，不会自动批准、完成或 merge main。不用在群里发旧中心模式的 `协作 分配` 或 `协作 交接`。

首选没认领时，候补需要等待默认 60 秒；执行失败后跳到下一位剩余候选，执行断线后等租约过期并经过 clock skew 才可接管。所以异常时可能由候补完成，而不是一定由 Alice/Bob 各自完成预设阶段。

## 5. 查看状态、会话记录和实际代码

```sh
cd "$HOME/codex-collab"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
root="$HOME/.codex-collab-auto-test"
printf '新任务 ID: '; IFS= read -r TASK_ID
node scripts/peer/cli.mjs read "$root/alice-peer.json" "$TASK_ID"
tail -n 30 "$root/alice-data/runner.log"
tail -n 30 "$root/bob-data/runner.log"
```

或者群里 `@Alice 协作 状态 T-真实ID`。`read` 返回任务摘要、事件和分支/SHA，不包含 Secret、完整 SDK 对话。

每个执行阶段还会保存 `0600` 私有会话映射：

```text
<root>/<agent>-data/jobs/<task-id>/<agent>-<epoch>.session.json
```

这里记录 SDK `thread_id`（SDK 返回后可用）、阶段、分支、执行状态，不包含私聊正文或异常原文，**不会进 Git 账本**。首次未开始/未返回时 thread_id 可以为空。它不是当前 GUI 对话的 ID；本实现没有桌面对话注入/自动续聊功能。

复制最终 `state.checkpoint.branch` 和 `commit` 后，核对并运行实际代码：

```sh
printf 'checkpoint.branch: '; IFS= read -r BRANCH
printf 'checkpoint.commit: '; IFS= read -r COMMIT
git -C "$root/bob-repo" fetch origin "refs/heads/$BRANCH"
git -C "$root/bob-repo" show --stat "$COMMIT"
git -C "$root/bob-repo" diff main "$COMMIT" -- greet.sh test.sh
git -C "$root/bob-repo" worktree add --detach "$root/verify-$TASK_ID" "$COMMIT"
(cd "$root/verify-$TASK_ID" && sh test.sh)
```

你应看到第一阶段功能提交和第二阶段测试提交。原 demo/main 和两个测试 clone 的 main 不会自动改变。

## 6. 真人审核，或失败后排查

实际验收通过后，群里分别发送：

```text
@Alice 协作 审核 T-真实ID 通过
@Alice 协作 完成 T-真实ID
```

失败时看最后一条 `Peer execution stopped`：`phase=sdk` 是模型运行阶段，`phase=tests` 是可信测试阶段，`phase=git` 是准备或提交推送阶段，`phase=protocol` 是发布协议阶段。错误原文会做脱敏；不要把完整 private log/auth 文件发到群里。

任务 `run_failed` 可能自动候补；所有候选都失败后会 `blocked`。修复 provider、Git 或测试配置后可由真人发送 `协作 重试 T-... 修复本机运行环境后重试`。不要改写历史事件，或对有签名任务的 team.json 修改路由/公钥。

停止本次测试：

```sh
node scripts/peer/cli.mjs stop "$HOME/.codex-collab-auto-test/alice-peer.json"
node scripts/peer/cli.mjs stop "$HOME/.codex-collab-auto-test/bob-peer.json"
```

需要回到旧桌面流程时，先确认自动连接全部停止，再 `start` 旧目录的两份配置。

## 已验证和仍需真实验证

自动化测试用模拟企业微信消息和模拟 SDK 执行，验证了独立 Git clone、Alice → Bob 接力、准确 SHA、测试后推送、故障候补、私有会话映射与人工审核边界；2026-10-09 全套 49 项通过。

同日还在本机实际验证了 SDK provider 探测与真实 Alice → Bob 接力：Alice 只改 `greet.sh`，Bob 从 Alice SHA 接续且只改 `test.sh`；四种真实输出及测试都通过，状态为 `review`，两个私有会话 ID 映射可用。结果保存在私有自动测试目录的 `sdk-smoke.json`；这条任务没有 source.chat_id，不会中继到群中，也没有自动批准或 merge main。

2026-10-09 后续已在真实企业微信群触发 automatic 任务，验证 Alice → Bob 的实际 SDK 接力、准确 SHA、四种输出和测试通过，最终为 review；两个通知游标均已收到成功发送回执。它仍是后台 SDK，不是用户已有桌面对话。跨两台独立机器尚未验证；切换 desktop_poll 时仍须停止 automatic Bot 连接以免冲突。
