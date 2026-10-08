# 本机 Runner

运行 `node apps/runner/main.mjs`，按个人令牌在服务端领取分配的任务。创建按 run ID 隔离的 Git worktree，通过 Codex SDK **新建 Runner 管理的会话**：编码采用 `workspace-write`、`approvalPolicy=never`，审查采用 `read-only`；均关闭网络访问。不会控制已经打开的 Codex 桌面会话。

编码成功的条件：Agent 自行提交、worktree clean、`COLLAB_TEST_ARGV` 指定的可信固定测试命令通过，推送代码分支（启用 `COLLAB_PUSH=1` 时）。之后发 `review_requested`；审查 Runner 将原始审查结果写入个人私有目录（权限 0600），Git 中只记录一条不含模型全文的 `review_note`；审核人查看私有结果及代码后，批准/退回必须由授权审核人明确执行。失败写 `run_failed` 并保留 worktree 供排查；需要管理员再次分配，**没有自动恢复/租约/心跳**。审查失败保留审查状态，管理员可取消并重建任务。

测试命令是 Runner 管理员配置的 argv JSON（默认 `["sh","test.sh"]`），**不**从飞书验收描述中执行字符串。代码和任务可能不可信：只对信任的仓库运行，建议独立低权限用户或容器部署；不要把高权限密钥传给 Agent 环境。
