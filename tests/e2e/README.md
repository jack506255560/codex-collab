# E2E 测试范围

`node --test tests/e2e/*.test.mjs` 在临时 Git 仓库中验证企业微信与任务协作。旧中心服务测试模拟企微群消息、个人身份的 HTTP/MCP 调用、编码与审查 Runner，使用真实本地 Git worktree 和任务账本，覆盖审核、完成和固定 commit 的代码接力。无需真实企微凭据或模型 API。

Peer 测试覆盖签名任务与身份、任务基准、绑定桌面对话轮询、自动领取、Alice/Bob 接力与人工审核。`peer-automatic.test.mjs` 使用 SDK mock 验证自动配置、私有 Bot 复用、群任务处理、固定 SHA 交接、私有会话映射和候选执行方式回退。测试不连接真实机器人或模型服务。

这些测试不替代真实企业微信群收发、真实 Codex 执行、跨机器 Git 推送或长时间运行验收。单机 bare remote 用于验证 Git 推拉行为；不代表跨两台设备已经部署验证。接入步骤和历史人工验收范围见 [根 README](../../README.md) 与 [接入指南](../../docs/onboarding.md)。
