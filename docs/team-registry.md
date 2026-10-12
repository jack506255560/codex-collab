# 签名团队登记与接入包 v1

新网页向导采用管理员签名的团队版本链，在业务仓库 `agent-collab` 上保存公开记录；工作台是本机 HTTP 界面，仅监听 `127.0.0.1`，不是共享调度服务。

```text
.agent-collab/team/versions/000001.json
.agent-collab/team/versions/000002.json
.agent-collab/team/invitations/<invite-uuid>.json
.agent-collab/team/requests/<request-uuid>.json
.agent-collab/peer/tasks/<task-id>/spec.json
.agent-collab/peer/tasks/<task-id>/events/<sequence>-<event-uuid>.json
```

## 团队版本

`schema_version: 1` 包含 `version`、`parent_hash`、`team_hash`、v2/v3 `team` 策略、`actor_id`、可选的 `enrollment` 和 Ed25519 `signature`。根的 `parent_hash` 为 null；后续记录指向前一条去掉 signature 后 canonical JSON 的 SHA-256。签名覆盖其余全部字段。

客户端通过加密接入包或明确导入的旧可信策略 pin 根 hash。本机保存最高版本与对应 hash，拒绝回滚和从已观察版本分叉。后续版本须由上一策略中的管理员签名；已有成员公钥、角色和 userid 不可偷偷替换。

每个新任务的 created 事件 pin 当时的 `team_hash`。重放、claim、续租、审核和候补均使用那个版本，而不是直接把最新路由用于旧任务。因此加入新成员或更新审核规则影响此后创建的任务，旧任务不改变授权或候补。

## 真人审核策略 v3

新网页团队初始化使用 `team.schema_version: 3`；团队版本记录的 schema 仍为 1，任务 spec/event 的 schema 仍为 2。v3 策略必须为每个 route 设置一条规则：

```json
{
  "frontend": { "required": true, "reviewer": "owner", "notify": "owner" },
  "backend": { "required": true, "reviewer": "member:alice", "notify": "reviewer" }
}
```

`required` 控制中间阶段审核。`reviewer` 支持实际执行者本人 `owner`、团队指定管理员 `admin`、`member:<id>`；`notify` 支持本人、审核人、不额外通知 `none`、指定成员。指定成员必须已验证企业微信本人身份；默认 owner 没有群命令身份时回落到团队管理员。选择 `none` 仅关闭额外通知，当前审核人仍会出现在通知中。最终阶段始终需要审核；规则关闭时最终审核人是团队指定管理员。

管理员保存时检查最新策略版本，经签名版本链发布。新增 route 自动补齐默认审核规则。v2 禁止附加 review_rules；旧客户端不支持 v3 时应升级后再参与，不能靠忽略规则继续运行。升级不能降回 v2。新规则只用于新任务。

中间提交会发布 `stage_review_requested`，将状态置为 `stage_review`，锁定本次实际执行者、审核人和下一阶段。`reviewed: approved` 才开放下一阶段；`changes_requested` 回到同一阶段并保留 checkpoint 和修改意见。最后提交的 `review_requested` 进入 `review`，通过后为 `approved`，仍须管理员 `completed`。审核入口需要当前 `R-<seq>`，退回必须有修改意见，防止旧通知被用于批准后来重新提交的结果。完整审核事件保存在任务账本。

## 邀请、申请、批准

公开邀请由管理员签名，包含成员名称、职责、机器人 Bot ID、允许的群 ID、群命令开关、首选/候补、到期时间、邀请 claim 公钥和引用的团队 hash。默认 7 天有效。它不包含机器人 Secret、claim 私钥或成员私钥。

成员的私钥在成员本机生成。通过群验证码得到 userid/chatid 后，申请包括成员公钥和这些公开绑定，并由成员密钥与邀请 claim 密钥分别签名。管理员核对后发布新的团队版本；版本的 enrollment 包含对应 invite_id 和 request_id。相同申请重试幂等，另一个身份复用已消费邀请会被拒绝。已经批准的同一身份恢复本机配置不受后续邀请过期影响。

目前版本链用于追加成员、能力路由、审核规则和本机恢复。机器人轮换、密钥轮换、成员撤销与群迁移没有网页操作；不要手改签名文件实现这些动作。多个管理员同时写入时，经本机锁、Git fast-forward push 与重新校验重试处理。

## 加密接入包

分发文件 `kind: codex-collab-encrypted-invite`，含 schema_version、随机 salt、随机 iv、GCM tag 和 ciphertext；scrypt 派生密钥，AES-256-GCM 加密内部 JSON。内部包包含公开签名历史、邀请、root_hash、remote、固定 test_argv、专用 claim 私钥及分配的机器人 Secret。密码至少 12 字符，文件与密码分开传递。

管理员保存可再次下载的密文。成员的签名私钥始终在成员机器上，管理员不会代为生成。包仍是敏感凭据，持有包和密码的人能连接该机器人并申请入队；管理员最终批准用于核对申请身份。

本机向导使用随机打开链接交换 HttpOnly SameSite=Strict cookie；检查 Host、Origin、JSON 内容类型和请求长度，避免其他网站直接操作本机配置。SDK/Git 错误经脱敏，不把异常中的凭据返回网页。

Schemas：`team-policy.schema.json`、`team-version.schema.json`、`team-invitation.schema.json`、`team-enrollment.schema.json`、`encrypted-invite.schema.json`。运行时另外校验签名、完整历史链、root/checkpoint、成员唯一性、邀请时效、群绑定、Git 权限与任务创建时策略。
