# 旧中心服务（源码兼容）

日常接入使用 [本机网页向导](../../docs/onboarding.md)。本目录的旧中心服务从源码启动，不随 npm 包分发；完整配置见 [旧中心服务与企业微信接入](../../docs/legacy-center.md)。

`node apps/server/main.mjs` 提供 HTTP `GET /health`、`/mcp`（Streamable HTTP）、使用个人 Bearer token 的 `/api/tasks` 和 `/api/jobs/next`。企业微信是唯一支持的 IM，通过官方 Node SDK 的出站 WebSocket 接收智能机器人群消息，无需公网回调。只接受允许的群 ID 和私有 accounts 文件中映射的 `wecom_userid`；群命令以 `协作` 开头。

当前按单服务实例、单 Git 写入者设计，默认监听 `127.0.0.1:38765`。同事跨机器使用时，配置受信任的 HTTPS 反向代理并限制访问和请求大小。`COLLAB_PUSH=1` 要求服务的 Git origin 可访问；推送失败会报错并保留本地提交，需要管理员修复，没有自动冲突重放。

## 企业微信群连接

`WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`WECOM_CHAT_IDS` 成组设置，群 ID 可逗号分隔。使用智能机器人 API 长连接；发现群与成员的操作见中心服务指南。未配置机器人时只运行本地 HTTP/MCP API。看到 `authenticated` 后还需验证群消息和回复。SDK debug 可能打印整条消息，适配器显式禁用该日志；不要在其他地方打印帧或 Secret。

任务群来源必须明确标记 `channel: "wecom"`。缺少来源或属于其他通道的历史任务仍可通过已授权 API 读取，不向企微群发送通知，也不能通过企微群命令访问。

若已认证但群消息无回复，先核对 Git 账本是否产生任务，再临时设置 `COLLAB_WECOM_DIAGNOSTICS=1` 并重启。诊断只记录是否收到消息、允许的群和已映射成员、是否识别命令及处理结果，不输出正文、凭据、群 ID 或 userid。关闭诊断也需重启。
