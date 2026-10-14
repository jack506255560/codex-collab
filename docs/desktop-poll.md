# 企业微信任务 → 指定 Codex 桌面对话轮询执行

日常团队使用 [本机网页接入向导](onboarding.md) 自动配置项目、群身份和机器人。本页保留隔离测试与底层轮询机制。已有配置可从网页导入，无需重绑对话。一个真人使用多个机器人建议走向导的“给自己增加机器人”，允许 Alice/Bob 共享 userid 并各自处理命令。本页的旧隔离测试脚本仍默认只给 Alice 设置群命令身份。

本模式是 `desktop_poll`，不是后台 SDK 自动模式，也不是旧的手动 `desktop` 保留。企业微信适配器负责入口/通知，Git 保存协议，**指定已有 Codex 对话的 heartbeat**负责调用 MCP 接单并在该对话执行。

```text
真人 @Alice Bot
  → Alice 本机适配器校验群/真人权限
  → Git agent-collab 写 desktop_poll 任务（open，未开始执行）
  → Alice 已有对话 heartbeat → MCP 原子认领、准备隔离工作树
  → 本对话修改/测试/明确提交 → finish_desktop_task
  → 固定测试 + 租约/祖先校验 + push → stage_review_requested（v3 默认）
  → Alice Bot 通知结果、本人审核与 R-版本号
  → 指定真人通过 → waiting（退回则原阶段从该 SHA 修改）
  → Bob 已有对话 heartbeat → 从准确 checkpoint SHA 接力
  → review_requested → Bob Bot 通知 → 指定真人审核 → 管理员完成
```

此图采用网页向导 v3 默认审核规则。下文 `setup-local` 创建的隔离静态策略仍为 v2，中间提交直接 handoff，最终由管理员审核；若需测试阶段审核，使用网页向导初始化新团队，或导入旧配置后保存审核规则。

通知不构成调度：机器人不必接收其他机器人的消息。下一位从 Git 发现工作，群里告知“优先 Bob”是人的可见提示，不是假冒成功 @ 或实时唤醒。

## 一次性配置

电脑、Codex 桌面应用和本机企微适配器需要保持可用。运行时不需要远程 HTTP 中心服务，但本机适配器仍要常驻。heartbeat 是否运行、目标对话是否实际调用本项目 MCP，以对话中的工具结果为准；MCP 本身不唤醒对话。不能以 standalone cron、新 SDK 对话或后台日志代替已有对话的验收。

### 1. 新建隔离环境，不改已有签名账本

同一个 Bot 不得同时连接旧服务/发现脚本/新适配器。先确认旧配置没有正在执行的任务；停止旧连接，再启动新连接。初始化本身不连接机器人，可以提前完成。

```sh
cd "$HOME/codex-collab"
root="$HOME/.codex-collab-desktop-poll-test"
node scripts/peer/setup-local.mjs --demo "$HOME/codex-collab-demo" \
  --out "$root" --mode desktop-poll \
  --wecom-from "$HOME/.codex-collab-auto-test"
```

`node` 需要 20+。可用自己的 Node 或 Codex bundled runtime，不修改 CC Switch。`--wecom-from` 安全复用本机两台不同 Bot 的配置/真人 owner，不打印 Secret、不复制签名私钥和旧任务；若没有旧配置，省略该参数并按 `docs/peer.md` 配置两个机器人。不要把 Secret 发到对话或提交 Git。

默认 frontend: Alice → Bob 候补；backend: Bob → Alice 候补。首选认领宽限 3 分钟（给一分钟轮询留余量），执行 lease 15 分钟；执行中建议至少每 5 分钟续租并限制单个长操作时长。修改策略必须在建立新账本之前完成，不能原地改签名任务的 team.json。

每份私有配置的关键项为：

```json
{
  "execution_mode": "desktop_poll",
  "auto_execute": false,
  "test_argv": ["sh", "test.sh"]
}
```

完整配置还包含身份、私钥、仓库、数据目录、团队策略和企微凭据。校验器拒绝 `desktop_poll` + `auto_execute=true`。SDK Runner 的默认接单入口也拒绝该模式，防止后台抢单。

### 2. 接到两个已存在的桌面项目

项目应是干净的 demo clone，main 必须与本次隔离 remote 的 main 相同。脚本会保留无关 TOML/provider 设置，备份原 MCP/remote/exclude，只更新该成员项目级 MCP 和安装专用 skill，并把 origin 接到本次隔离 remote。**这会切换项目 origin**，是有意的本机测试配置；不推 GitHub、不改全局 Codex 配置、不覆盖代码和未提交改动。

```sh
node scripts/peer/setup-desktop-project.mjs "$root/alice-peer.json" /absolute/alice-repo
node scripts/peer/setup-desktop-project.mjs "$root/bob-peer.json" /absolute/bob-repo
```

返回 `*-desktop-peer.json`、`*-project-backup.json`、`*-bind-prompt.txt`。备份是 0600 本机文件，可能包含原项目配置，不能上传。脚本拒绝覆盖现有安装，重配置前先检查备份，不能盲目重复初始化。

重新加载目标项目 MCP；若已有进程仍使用旧配置，需要关闭旧连接并重新打开/重启桌面应用。`get_identity` 应分别返回 alice/bob 和 `execution_mode=desktop_poll`。

### 3. 在每个目标已有对话里绑定和创建 heartbeat

分别复制本机生成的 Alice/Bob 绑定提示词，发送到**各自实际对话**，不是工具开发对话：

```sh
cat "$root/alice-bind-prompt.txt"
cat "$root/bob-bind-prompt.txt"
```

提示词要求目标对话：确认 MCP 身份 → 获取当前真实 thread ID → `bind_desktop_thread` → 用应用 automation 工具在**这个已有对话**设置周期 heartbeat → 立即只读/无任务检查。不能仅凭项目目录猜对话 ID；若应用上下文/当前 shell 未暴露 ID，让用户提供目标对话 ID/链接，不读取或修改应用私有数据库。

每个 heartbeat 保存的提示词须含该身份、真实 thread_id、skill 路径；每次 `get_identity`、`poll_desktop_task`。只有 `job=null` 且 `requests` 为空时保持安静；有需求时先理解并调用 `resolve_desktop_request` 创建任务、追问或回答，有任务时在本对话完成当前阶段并交接。创建前查已有 automation，避免重复。默认尝试一分钟周期，只有工具接受且真实触发后才算启用；否则说明限制。应用工具不可用时只完成绑定，不能声称已自动轮询。

绑定和 app heartbeat 是两件事：MCP 返回 `automation_created=false`；只能由应用工具完成定时设置。桌面绑定 ID/执行路径/token 只存本机 `desktop-state.json`，不进 Git。

### 4. 切换 Bot 连接并启动通知适配器

```sh
node scripts/peer/cli.mjs stop "$HOME/.codex-collab-auto-test/alice-peer.json"
node scripts/peer/cli.mjs stop "$HOME/.codex-collab-auto-test/bob-peer.json"
node scripts/peer/cli.mjs start "$root/alice-peer.json"
node scripts/peer/cli.mjs start "$root/bob-peer.json"
```

日志应显示 `notifications only; automatic code execution disabled` 和两次各自的 `Peer WeCom authenticated`。本页旧脚本默认 Alice 接本人的群命令，Bob 只发送通知。这是测试夹具的默认设置；新网页向导支持同一真人拥有两个可接群命令的 Agent，各自用独立机器人和密钥。真实同事应验证各自本人账号。

可用 CLI 检查“进程在线”和“企微已鉴权”是否是两个独立状态：

```sh
node scripts/peer/cli.mjs status "$root/alice-peer.json"
node scripts/peer/cli.mjs status "$root/bob-peer.json"
```

必须同时看到 `"online": true` 和 `"wecom": "authenticated"`。只有 `online: true` 不能证明企微仍在线；适配器会把状态写入私有的 `wecom-health.json`，不进入 Git 账本。

## 验证完整闭环

所有绑定/heartbeat 就绪后，在群里选择真实 Alice @，发**新任务**：

```text
@Alice 给 greet.sh 增加 --upper 选项，默认和姓名参数的行为保持不变。
你只修改 greet.sh，Bob 接着扩展 test.sh，覆盖默认、姓名、大写默认、大写姓名四种行为。
sh test.sh 要通过，完成后在群里发总结。
```

不用填写工作流语法、分隔符或任务 ID。先配置 Alice 的 frontend 职责和 Bob 的 backend 职责；绑定对话根据团队路由解释这条消息，把职责与验收保存在结构化任务中。没有对应同事或分工不清时先在群里追问；不能只凭显示名猜测分配。旧 `协作 创建 [frontend>backend] ... | ...` 命令仍可直接创建任务。

验收要看到同一个新任务 ID：

1. 群先回复“已收到你的需求”，给出 `N-需求ID`；下一次 Alice 对话轮询后，群里收到任务与分工确认及 `T-任务ID`。从此检查同一个 T-ID。
2. 指定 Alice 对话出现任务 ID、当前阶段和实际修改/测试记录；Alice Bot 发 claimed。
3. Alice `finish_desktop_task` 固定验证通过并 push；群里给出结果、SHA、测试。v3 默认先等待 Alice 本人审核，通过后才显示下一阶段优先 Bob；v2 或关闭中间审核时直接交接。
4. 指定 Bob 对话从 Alice 的准确 SHA 执行；Bob Bot 发 claimed、review_requested，并给出实际审核人与版本号。
5. 四种行为通过，最终 checkpoint 包含两阶段代码；main 未自动改变，等待真人审核。

仅测试通过、后台日志出现 claimed、或群里有回复，都不能代替“实际指定已有桌面对话自动执行”的验收。应用是否自动切到该对话不是验收条件，打开该对话应看到执行记录。

审核仍由真人群命令完成：

```text
@审核人自己的机器人 协作 审核 T-真实任务ID R-7 通过
@审核人自己的机器人 协作 审核 T-真实任务ID R-7 退回 | 修改意见
@Alice 协作 完成 T-真实任务ID
```

示例 `R-7` 替换为最新通知版本；v2 任务仍兼容省略版本号的旧命令。本页旧夹具中没有群命令身份的 Bob 由 Alice 管理员审核；新向导中用相同本人账号验证的 Bob 默认通过 Bob 机器人审核，按当前通知操作。原生 @ 提醒需实群确认；审核与 Git 接力不依赖原生 @。

## 已有项目启用自然语言入口

已有绑定不需要重新创建身份。先处理正在执行的任务，再对每个 Agent 用其**项目 MCP 实际使用的私有配置路径**操作：

```sh
npm install --global xuym-codex-collab@0.4.1
codex-collab stop /absolute/private-peer.json
codex-collab refresh-project /absolute/private-peer.json
codex-collab start /absolute/private-peer.json
```

自然语言入口和 `refresh-project` 从 `0.4.0` 开始提供。从源码测试时，可将 `codex-collab` 替换为 `node /absolute/codex-collab/bin/codex-collab.mjs`。

`refresh-project` 更新可识别的项目 MCP 和 Skill，保留 provider、其他 MCP、签名身份和本机对话绑定，生成私有备份，并返回 `binding_prompt` 文件路径。重新加载该项目 MCP，把这个文件里的启用指令发送到**原绑定对话**，让它更新原协作 heartbeat 的提示词，再立即轮询一次。升级命令本身不操作应用 heartbeat。

网页工作台中继续检查/导入已有配置也会刷新可识别的安装；随后重新复制启用指令到原对话。定制 Skill、MCP、已提交的项目配置或其他身份配置不会被覆盖，提示手动合并后再继续。

新一次群消息到达后，Runner 先把需求保存到业务仓库 `agent-collab` 的 `.agent-collab/peer/inbox/N-ID/`，使用签名与消息 ID 去重。MCP 轮询返回原文、追问/回复历史和团队职责，由绑定对话理解；任务与解读结果在同一次 Git 提交中发布。原始群需求和处理结果由团队共享，完整私有 Codex 对话和绑定 ID 不写入 Git。

需求不清时机器人会追问：只有一条待补充需求，可直接 @它回复；多条时带上对应 N-ID。澄清等待中不产生执行任务；状态问题使用回答，不创建新任务。自然语言“通过／完成”只作为请求文字处理，审核、完成仍由真人发明确命令。运行中的任务优先恢复，新的需求会等活跃阶段结束后处理。响应时间取决于 heartbeat 实际轮询周期、对话是否可用和 Git 同步。

## MCP 与运行约束

| 工具 | 作用 |
| --- | --- |
| get_identity | 核对身份与模式 |
| bind_desktop_thread / desktop_status | 本机绑定与检查；不创建 app automation |
| poll_desktop_task | 恢复活跃任务；否则返回待理解 requests，或原子认领任务；两者都无时 notify=false |
| resolve_desktop_request | 绑定对话按最新 expected_seq 创建结构化任务、追问或回答；不批准、完成或取消任务 |
| renew_desktop_task | 活跃执行时显式续租 |
| finish_desktop_task | 验证已提交代码、跑固定测试、push、发布下一阶段或待审核 |
| fail_desktop_task | 简洁脱敏失败；候补接力；保留工作树 |
| unbind_desktop_thread | 没有有效执行租约时解除绑定；仍须另外停 heartbeat |

- 工作树在项目内的 `.codex-collab-worktrees/`（本地 Git ignore），各阶段独立 `codex/desktop-*` 分支。当前项目工作区不切分支，手头改动不被覆盖。
- 认领/续租/发布沿用签名事件和 Git fast-forward CAS；finish 核对 lease_id/epoch。迟到执行者不能发布；推送代码还须包含前一 checkpoint 的祖先。
- 编辑阶段没有无限续租定时器。定时 app heartbeat 只是唤起检查；必须由活跃对话显式调用续租。只有有超时的前台固定测试/发布调用会在调用期间续租。Bot 在线不是对话活着的证据。
- 首选不接单，3 分钟后候补可接；执行掉线，15 分钟 lease 过期加 clock skew 后可接管。旧进程/对话应停止，不改写已交接内容。没有签名成功 checkpoint 的未提交进度不会自动恢复给另一台机器。
- 本机绑定使用调用参数 thread_id 与私有绑定比对，是工具路由与防误操作措施，**不是由 Codex 宿主认证的调用者身份**。同一台机器上能访问同一私钥/配置的其他对话不构成安全隔离边界；真正成员授权靠独立签名私钥和团队策略。
- MCP 不发完整对话，不自动审核，不 merge main；群通知失败不回滚 Git 事件，适配器按成功回执持久化游标重试。

## 停止、状态和重新绑定

```sh
node scripts/peer/cli.mjs desktop-status "$root/alice-desktop-peer.json"
node scripts/peer/cli.mjs desktop-status "$root/bob-desktop-peer.json"
node scripts/peer/cli.mjs read "$root/alice-peer.json" T-真实任务ID
node scripts/peer/cli.mjs stop "$root/alice-peer.json"
node scripts/peer/cli.mjs stop "$root/bob-peer.json"
```

停止适配器不等于停止 app heartbeat，后者仍可访问 Git：要暂停协作，应在两个目标对话分别暂停 heartbeat；若有正在编辑的任务，还需停止/报告失败或等待租约失效。重新绑定前先停旧 heartbeat、确认没有有效租约，再显式 `desktop-unbind /abs/peer.json 旧真实thread_id`；不要手改私有 job token 或已签名事件。

## 验证范围

2026-10-10 完成首批桌面对话轮询验证；2026-10-12 增加阶段审核、退回修订、过期审核拒绝和旧策略升级测试。本项目自动测试覆盖模拟群命令、真实 stdio MCP、真实 Git/worktree/固定测试、绑定防误用、双对话身份接力、精确 SHA、无闲置续租、过期候补及迟到发布拒绝；模型修改由测试夹具模拟，不冒充真实 Codex 桌面会话。据用户同日确认，本机真实企业微信群 + Alice/Bob 既有 Codex 对话的完整轮询接力已验证；跨两台机器部署尚未验证。
