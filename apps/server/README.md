# 协作服务（单实例）

`node apps/server/main.mjs`：HTTP `GET /health`、`/mcp`（Streamable HTTP）、带个人 Bearer token 的 `/api/tasks` 和 `/api/jobs/next`；飞书使用官方 Node SDK WebSocket 事件订阅，无需公网回调 URL。仅接受配置的群 ID 与映射的飞书 open_id；群消息必须以“协作”开头。

当前按 **单服务实例、单 Git 写入者** 设计。默认监听 `127.0.0.1:38765`；若供同事使用，以受信任反向代理提供 HTTPS、限制访问和请求大小。不要把纯 HTTP 和令牌暴露到公网。`COLLAB_PUSH=1` 需服务的 Git origin 可访问，且 `agent-collab` 分支已推送；推送失败会报错并保留本地提交，需要管理员人工修复，**不实现自动冲突重放**。

环境变量见根目录 README；真实飞书应用的权限、事件订阅和群 ID 必须由应用管理员配置。未提供 App ID/Secret 时仅提供本地 API，不会接入飞书。

## 企业微信群连接

`WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`WECOM_CHAT_IDS` 必须成组设置，群 ID 可逗号分隔。仅接受允许的群的文本和已在私有 accounts 文件映射的 `wecom_userid`；命令以 `协作` 开头。使用企微智能机器人 API 长连接而不是 webhook 群机器人；发现群及本机重启具体命令见根目录 README 的「本机接企业微信群」。从未配置这些变量时仅运行本地 HTTP/MCP API；看到 `authenticated` 不等于已验证群消息收发。SDK 默认 debug 可能打印整条消息，适配器显式禁用该日志；不要在其他地方打印帧或 Secret。

接入诊断：若长连接已认证但群消息无回复，先核对 Git 账本是否产生新任务，再在启动中心服务时临时添加 `COLLAB_WECOM_DIAGNOSTICS=1`。该开关只打印是否收到消息、是否是允许的群/已映射成员、是否识别命令及是否被处理，不输出正文、凭据、群 ID 或 userid；需要重启服务才会生效。关闭诊断时再次重启服务即可。
