# 两个桌面 Codex 对话 + 两个企业微信机器人：本机验证

如果你要的是“群里 @ 后在指定已有 Codex 对话自动干活”，请看 [desktop-poll.md](desktop-poll.md)。若接受新后台 SDK 会话，再看 [local-automatic-test.md](local-automatic-test.md)。本页是保留的**桌面手动接力**测试，不能把 `auto_execute=false` 的通知 Runner 当作自动执行者。

本次验证让你用一个真人账号模拟两位同事。Alice 在一个 Codex 对话写功能，Bob 在另一个对话补测试；两个机器人在同一个群展示各自的交接和进度。Git 是调度与任务真相，不依赖机器人能否收到另一台机器人的消息。

**不能自动唤醒已打开的桌面对话。** Alice 交接后，你需要给 Bob 对话发送一次任务 ID。自动执行由 Runner 创建新的 SDK 会话，属于另一种测试，不能称为接管已有桌面对话。

## 本次配置

| 对象 | 用途 |
| --- | --- |
| `alice-repo` | 第一个桌面 Codex 对话，Alice 的项目级 MCP |
| `bob-repo` | 第二个桌面 Codex 对话，Bob 的项目级 MCP |
| `alice-peer.json` / `bob-peer.json` | 不同身份、私钥和本地数据目录 |
| Alice 机器人 | 接收你本人的状态/审核/完成命令，发送 Alice 通知 |
| Bob 机器人 | 只发送 Bob 通知，不接收群命令 |
| 两个本地 Runner | `auto_execute=false`，只连接机器人和中继通知 |
| `origin.git` | 本机共享 bare Git remote，不连接 GitHub |

本页保留的旧测试脚本只给 Alice 绑定真人 `userid`，Bob 用 `--notify-only` 保持通知模式。新工具允许同一个真人拥有多个独立 Agent，并分别通过自己的机器人处理群命令；建议使用 [网页向导中的“给自己增加机器人”](onboarding.md#一个人使用多个机器人或模拟两个同事)，按新流程建立身份绑定，不直接修改旧任务的签名策略。真实同事使用各自的企业微信账号。

## 1. 只初始化一次

你已经把两个不同的企业微信「智能机器人 API 模式」机器人放进群，分别记为 Alice Bot / Bob Bot。一个 Bot 的发现脚本、旧中心服务、Peer Runner 不能同时连接；先在旧连接终端按 Ctrl-C，或按旧运行文档确认进程身份后停止。不要盲目杀其他进程。

之前在聊天里贴过的 Secret 必须先在企业微信后台轮换。本次只在本机输入新 Secret，不要发给 Codex，也不要写进 shell 命令文本。

若助手已经生成 `$HOME/.codex-collab-peer-test`，跳过初始化。否则先输入之前发现的你自己的真人 userid，再运行：

```sh
cd "$HOME/codex-collab"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
printf '你自己的企业微信 userid: '; IFS= read -r WECOM_OWNER_USERID
export WECOM_OWNER_USERID
node scripts/peer/setup-local.mjs --demo "$HOME/codex-collab-demo" --mode desktop
unset WECOM_OWNER_USERID
```

如果 Node 不在这个位置，用你安装的 Node 20+。脚本不覆盖已有目录；确实需要重做时指定一个全新的 `--out /abs/new-directory`，不要覆盖已签名任务使用的 `team.json`。现有任务签名固定了整份团队策略，不能事后改 owner/公钥/路由。

脚本只复制 demo **本地 main 的已提交代码**；不会复制未提交改动，也不会推送或修改原 demo/tool 仓库，不修改 CC Switch、全局 Codex 配置或登录凭据。

## 2. 在终端绑定两个机器人

下面的输入每次只存在于本机终端。`read -s` 隐藏 Secret，配置保存为 `0600` 私有文件。不要打印整份配置、私钥或环境。若不知道群 chatid，用原来的 `scripts/discover-wecom.mjs` 发现后 Ctrl-C 关闭，再回来配置。

```sh
cd "$HOME/codex-collab"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
root="$HOME/.codex-collab-peer-test"
node scripts/peer/cli.mjs stop "$root/alice-peer.json"
node scripts/peer/cli.mjs stop "$root/bob-peer.json"
printf '群 chatid: '; IFS= read -r CHAT_ID
printf 'Alice Bot ID: '; IFS= read -r BOT_ID
printf 'Alice 新 Secret（不回显）: '; IFS= read -rs WECOM_BOT_SECRET; printf '\n'
export WECOM_BOT_SECRET
node scripts/peer/configure-wecom.mjs "$root/alice-peer.json" "$BOT_ID" "$CHAT_ID"
unset WECOM_BOT_SECRET
printf 'Bob Bot ID（不同于 Alice）: '; IFS= read -r BOT_ID
printf 'Bob 新 Secret（不回显）: '; IFS= read -rs WECOM_BOT_SECRET; printf '\n'
export WECOM_BOT_SECRET
node scripts/peer/configure-wecom.mjs "$root/bob-peer.json" "$BOT_ID" "$CHAT_ID" --notify-only
unset WECOM_BOT_SECRET BOT_ID
node scripts/peer/cli.mjs doctor "$root/alice-peer.json"
node scripts/peer/cli.mjs doctor "$root/bob-peer.json"
node scripts/peer/cli.mjs start "$root/alice-peer.json"
node scripts/peer/cli.mjs start "$root/bob-peer.json"
```

分别看私有日志，两个进程都应出现 `Peer WeCom authenticated` 和 `notifications only; automatic code execution disabled`：

```sh
tail -n 15 "$HOME/.codex-collab-peer-test/alice-data/runner.log"
tail -n 15 "$HOME/.codex-collab-peer-test/bob-data/runner.log"
```

`doctor` 不验证真实机器人登录，也不验证 CC Switch 模型访问。本次桌面测试不调用 SDK，因此通过测试不代表自动 Runner 的模型认证已经验证。

### 认证失败时先停下来，不要继续创建任务

日志文件会追加旧记录。只判断最近一次启动之后的消息：

| 日志 | 含义 / 下一步 |
| --- | --- |
| `Runner started` / `runner online` | 本机进程启动，不代表机器人登录成功 |
| `WebSocket connected; awaiting authentication` | 传输连接已建立，仍在等待认证 |
| `Peer WeCom authenticated` | SDK 确认这次连接认证成功；断线后需再次确认 |
| `认证被企微拒绝（错误码 …）` | 收到了认证拒绝响应；核对智能机器人 API 模式、同一机器人的 Bot ID 与当前 Secret，必要时重置后重新输入 |
| `连接失败（ETIMEDOUT / ENOTFOUND / …）` | 检查本机网络、代理、DNS 与证书，不要关闭 TLS 证书验证 |
| `disconnected` / `reconnecting` | 连接已中断或正在重连，不是在线认证成功 |

遇到认证拒绝，先按文末的停止命令关闭两个测试 Runner，再重新执行本节配置步骤。每组 ID/Secret 都应从对应机器人页面获取，不要混用，也不要把 Secret、整份配置或原始 SDK 错误对象贴到聊天。错误码本身不应被当作足以确定根因的证据。

两个机器人都出现最新的 `Peer WeCom authenticated` 后，再进行下面的桌面对话操作。Bob 的只通知模式不会回复群命令，这是预期行为。


## 3. 创建两个不同项目的 Codex 对话

在 Codex 添加两个本地项目，分别选择：

- `$HOME/.codex-collab-peer-test/alice-repo`
- `$HOME/.codex-collab-peer-test/bob-repo`

每个项目已生成 `.codex/config.toml` 和本地 `team-collab-peer` Skill。不要在同一个项目里开两个对话然后假设身份自动分开；身份取决于 MCP 配置，不取决于对话名字。不要将两份 peer 配置轮流安装到同一个全局 MCP 名称。

如果当前 Codex 构建支持可信项目级配置，信任这两个本机测试项目后创建新对话；否则先停在身份检查这一步。可能需要重新打开项目/重启应用。不要为了解决发现问题覆盖 CC Switch 的全局 `config.toml` 或复制真实密钥到项目。

**先发给 Alice 对话：**

```text
这次我是 Alice。请调用 team-collab-alice 的 get_identity，只报告 agent_id、repo；先不要改文件。若未找到工具或身份不是 alice，停止并说明。
```

**再发给 Bob 对话：**

```text
这次我是 Bob。请调用 team-collab-bob 的 get_identity，只报告 agent_id、repo；先不要改文件。若未找到工具或身份不是 bob，停止并说明。
```

只有两个身份分别返回 `alice` / `bob`，才能继续。若旧全局 MCP 也可见，明确只使用对应的 `team-collab-alice` / `team-collab-bob`，不要调用旧中心服务。

## 4. Alice 写功能并交接

发给 Alice 对话。把 `chat_id` 的占位文字换成你真实的群 ID；它不是 Secret，但不要提交到业务仓库。

```text
使用本项目的 team-collab-peer Skill 和 team-collab-alice MCP，确认 get_identity 是 alice。
创建一个新任务：title 为“为 greet.sh 增加 --upper 并补回归测试”，workflow 为 ["frontend","backend"]，execution_mode 为 "desktop"，chat_id 为“这里换成真实群 chatid”。
description：Alice 第一阶段只实现 greet.sh 的 --upper；Bob 第二阶段只扩展 test.sh 的回归测试。
acceptance：sh greet.sh 输出 hello, world；sh greet.sh Alice 输出 hello, Alice；sh greet.sh --upper 输出 HELLO, WORLD；sh greet.sh --upper Alice 输出 HELLO, ALICE；sh test.sh 通过并覆盖新旧行为。
在当前 Alice 仓库的新 codex/* 分支上只实现 greet.sh，保留原行为，先不改 test.sh。不修改 main、协议、私有配置或项目 MCP。运行现有 sh test.sh，并实际检查四个输出。提交并 push 到本机 origin。
read_task 获取最新 seq，再 handoff_task，传准确 branch、完整 commit SHA、真实 tests 和交接摘要，让 Bob 从该 SHA 补测试。最后报告 task_id 和下一步，不批准或完成任务。
```

注意 demo 的 main 本来就能通过旧测试，只执行旧测试不能证明本次功能已完成。Alice handoff 后群中应由 **Alice Bot** 发出 `handoff` 通知，状态为 `waiting`。保存新的 `T-...` 任务 ID。

## 5. Bob 在第二个桌面对话手动接力

可在群里 @ Alice Bot 发 `协作 状态 T-...` 查看等待状态；@ Bob Bot 不会唤醒桌面对话，也不会回复群命令。把真实任务 ID 发给 Bob 对话：

```text
使用本项目的 team-collab-peer Skill 和 team-collab-bob MCP，get_identity 必须是 bob。
接力任务 T-这里换成真实任务ID。read_task 后核对 stage 为 backend、状态为 waiting；使用最新 state.seq 调用 claim_desktop_task。若认领被拒绝，不改文件，先报告。
认领成功后，从 checkpoint.branch fetch 本机 origin，核对 checkpoint.commit 可用，在 Bob 仓库从准确的完整 SHA 建立新的 codex/* 分支。不要从 main 开始，也不要修改 Alice 的工作目录。
这一阶段只扩展 test.sh，覆盖默认 world、普通姓名 Alice、--upper 默认 world、--upper Alice；保留原测试。执行 sh test.sh 并确认通过，提交并 push Bob 分支到本机 origin。
read_task 获取最新 seq，再 request_review，提供准确 branch、完整 commit SHA、真实测试证据和简短总结。不要批准或完成任务。
```

群里应由 **Bob Bot** 先发 `desktop_claimed`，再发 `review_requested`；最终状态是 `review`，代码证据指向 Bob 的提交。两台机器人不需要互相 @。

## 6. 真人验收并完成

在终端读取签名账本，复制 `state.checkpoint.branch` / `commit`，查看 Bob 提交；这些都是本机 Git 的分支，不在 GitHub：

```sh
cd "$HOME/codex-collab"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
root="$HOME/.codex-collab-peer-test"
printf '任务 ID: '; IFS= read -r TASK_ID
node scripts/peer/cli.mjs read "$root/alice-peer.json" "$TASK_ID"
printf 'checkpoint.branch: '; IFS= read -r BRANCH
printf 'checkpoint.commit: '; IFS= read -r COMMIT
git -C "$root/alice-repo" fetch origin "refs/heads/$BRANCH"
git -C "$root/alice-repo" show --stat "$COMMIT"
git -C "$root/alice-repo" diff main "$COMMIT" -- greet.sh test.sh
git -C "$root/alice-repo" worktree add --detach "$root/verify-$TASK_ID" "$COMMIT"
(cd "$root/verify-$TASK_ID" && sh test.sh)
```

确认改动正确后，在群里用你自己的真人账号发送：

```text
@Alice机器人 协作 审核 T-真实任务ID 通过
@Alice机器人 协作 完成 T-真实任务ID
```

再发 `协作 状态 T-...` 应返回 `completed`。完成不会自动 merge main。成功条件是：两种 MCP 身份正确、Alice 功能提交、精确 SHA 交接、Bob 独立提交测试、两个 Bot 通知、最终提交测试通过、真人批准和完成。

## 停止与排查

```sh
cd "$HOME/codex-collab"
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node scripts/peer/cli.mjs stop "$HOME/.codex-collab-peer-test/alice-peer.json"
node scripts/peer/cli.mjs stop "$HOME/.codex-collab-peer-test/bob-peer.json"
```

- 两个 Bot 无回复：先看是否认证、群 ID、Alice 的 pinned userid；Bob 本来就是只通知、不回复模式。
- 有 Git 任务但无通知：检查创建时是否传 `chat_id`、Bot 群 allowlist、Runner 是否在线及网络。Git 事件不会因通知失败回滚。
- Bob 认领失败：重新 read_task 检查身份、状态、最新 seq、route 与并发容量。不要绕过授权修改账本。
- 任务卡在 `desktop`：人工继续对应对话；手动桌面保留没有 lease，不会自动候补。确实放弃时由真人 @ Alice Bot `协作 取消 T-...` 后建新任务。
- 要测试群消息自动运行：另用全新 `--out` 与 `--mode automatic` 初始化环境，使用新 Bot 或停止本次连接再切换。本次桌面目录不必改动；自动流程启动的是新的 SDK 会话，需另验证 CC Switch/provider；完整操作见 [local-automatic-test.md](local-automatic-test.md)。
