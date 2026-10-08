# Git ledger

`src.mjs` 以目标仓库的 `agent-collab` 独立 worktree 为事件账本。进程内串行提交，校验任务协议、期望序号及幂等键；代码工作树不切换分支。可配置 `push: true` 推送到 origin，但要求先人工完成 Git 授权和远端 `agent-collab` 初始化；推送失败保留本地提交，不自动重放/解决远端冲突，也不支持多个中心服务同时写同一仓库。

测试：`node --test packages/git-store/test/*.test.mjs`。
