# Codex Collab

把企业微信群的任务交给指定的已有 Codex 对话：管理员统一创建并分配机器人，同事导入个人接入包、绑定对话，即可接单、提交结果并接力。每位成员只运行本机工具；共享任务协议和交接记录保存在业务仓库的 `agent-collab` 分支。

## 安装与入口

需要 Node.js 20+、Git、Codex 桌面应用，以及业务仓库的读取和 push 权限。先 clone 业务仓库；成员无需 clone 本工具源码。

```sh
npm install --global xuym-codex-collab
codex-collab setup
```

`setup` 打开本机网页工作台，所有接入操作集中在一个页面。管理员选择“初始化团队”，成员选择“加入团队”；已在使用旧配置的成员选择“导入已有配置”。终端保持运行即可继续使用工作台，关闭工作台后已启动的机器人连接仍运行。

| 谁 | 在工作台做什么 | 接入后需要保留什么 |
| --- | --- | --- |
| 管理员 | 初始化业务仓库；在群里验证自己；分配各成员机器人与职责；下载加密接入包；确认成员申请 | 本机身份、管理员配置和机器人连接 |
| 成员 | 导入个人接入包与密码；选择自己的业务仓库 clone；在群里发送验证码；等待管理员确认；复制启用指令到选定 Codex 对话 | 本机机器人连接，以及该对话的轮询自动化 |

管理员先在企业微信创建**独立智能机器人**并加入协作群，再填写 Bot ID/Secret。工具通过群验证码发现群 `chatid` 和真人 `userid`，不需要成员手工寻找这些 ID、生成密钥或编辑 JSON。机器人 Secret 通过加密接入包交给指定成员，密码单独传递。

完整步骤与旧配置迁移见 [团队接入指南](docs/onboarding.md)。

## 一次任务如何接力

```mermaid
sequenceDiagram
  participant H as 企业微信群
  participant A as Alice 本机工具
  participant C as Alice 已有 Codex 对话
  participant G as 业务仓库 agent-collab
  participant B as Bob 已有 Codex 对话
  H->>A: @Alice 协作 创建 [frontend>backend] ...
  A->>G: 签名任务与能力路由
  C->>G: heartbeat 轮询并原子认领
  C->>G: 代码 commit、测试证据、阶段总结
  A->>H: 完成结果与下一位执行者
  B->>G: 从交接 SHA 认领下一阶段
  B->>G: 提交结果，等待真人审核
```

例如在群里选中实际 Alice 机器人发送：

```text
@Alice 协作 创建 [frontend>backend] 给登录页增加密码显示切换 | npm test 通过
```

Alice 的绑定对话轮询到任务后在隔离 worktree 执行前端阶段，提交代码、运行固定验证命令、写入总结；群里收到完成通知和下一位执行者，Bob 的绑定对话按后端职责接力。候补从 Git 签名事件和租约判断，机器人 @ 消息本身不负责调度。群消息中的验收文字不会替换管理员设置的本机测试 argv。

代码保存在独立 `codex/*` 分支；任务和签名策略保存在 `agent-collab`，两者不自动合并到 `main`。最后由真人审核与完成任务。

## 状态与数据

工作台分别检查项目 MCP/Skill 配置、企微认证、目标对话绑定和实际轮询。机器人认证成功只能说明连接可用；还需要对话真实轮询才能执行任务。MCP 本身不能唤醒闲置对话，“启用指令”会要求在**当前选定对话**建立 heartbeat，应用需支持并运行该自动化。

成员私钥在成员本机生成。Git 记录公钥、成员职责、签名邀请/申请、任务事件、代码引用、测试和阶段总结；Secret、对话 ID、运行令牌及聊天全文留在本机。团队新增成员后会发布新的签名策略版本；旧任务继续遵循创建时的策略，避免改写已运行任务的权限和候补。

停止工作台或机器人连接不会自动暂停 Codex heartbeat；需要暂停协作时，应在对应对话暂停自动化，并检查在执行任务的状态。

## 开发与兼容

```sh
pnpm install --frozen-lockfile
npm test
node bin/codex-collab.mjs setup
```

保留 `codex-collab setup --terminal`、`setup --role admin|member` 和原有 `start` / `stop` / `status` 等命令。终端模式沿用旧 `team.json` 工作流，网页向导使用签名团队版本与加密个人接入包。不会改写全局 Codex、CC Switch 或模型账号设置。

- [接入、迁移和首次验收](docs/onboarding.md)
- [团队签名协议与目录](docs/team-registry.md)
- [Peer 机制与底层命令](docs/peer.md)
- [已有桌面对话轮询机制](docs/desktop-poll.md)
- [旧中心服务与飞书接入](docs/legacy-center.md)

2026-10-10 已由用户验证本机真实企业微信群 + Alice/Bob 两个已有 Codex 对话的接力闭环。新网页向导通过临时 Git 仓库、模拟机器人和实际浏览器操作验证；这轮测试没有连接真实机器人。跨两台机器的部署尚未验证。
