# 协作服务（单实例）

`node apps/server/main.mjs`：HTTP `GET /health`、`/mcp`（Streamable HTTP）、带个人 Bearer token 的 `/api/tasks` 和 `/api/jobs/next`；飞书使用官方 Node SDK WebSocket 事件订阅，无需公网回调 URL。仅接受配置的群 ID 与映射的飞书 open_id；群消息必须以“协作”开头。

当前按 **单服务实例、单 Git 写入者** 设计。默认监听 `127.0.0.1:38765`；若供同事使用，以受信任反向代理提供 HTTPS、限制访问和请求大小。不要把纯 HTTP 和令牌暴露到公网。`COLLAB_PUSH=1` 需服务的 Git origin 可访问，且 `agent-collab` 分支已推送；推送失败会报错并保留本地提交，需要管理员人工修复，**不实现自动冲突重放**。

环境变量见根目录 README；真实飞书应用的权限、事件订阅和群 ID 必须由应用管理员配置。未提供 App ID/Secret 时仅提供本地 API，不会接入飞书。
