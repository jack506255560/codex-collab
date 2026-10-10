# E2E 测试范围

`node --test tests/e2e/*.test.mjs` 在临时 Git 仓库中运行：模拟飞书群消息、按用户身份调用 HTTP/MCP、两名模拟 Codex Runner（编码/审查）、真实 Git worktree 和本地任务账本、审核/完成。每次测试无需真实飞书凭据或 Codex 模型 API。另通过真实 `codex-collab-demo` 进行了 HTTP `/health` 与现有任务 T-001 读取的本机烟测。

未覆盖：真实飞书 WebSocket 群消息、真实 Codex SDK 模型调用、跨机器 Git push、长断线恢复/租约/重试、服务多实例并发写入。真实接入前按根目录 README 的接入步骤逐项验证，模拟成功不代表线上就绪。

Peer automatic validation is covered by `peer-automatic.test.mjs`: automatic setup and safe private Bot reuse, group task → Alice SDK mock → pinned handoff → Bob SDK mock, private session mapping, candidate fallback and explicit human approval. No real Bot connection/provider request is made by the suite. A separate local real-SDK smoke run was completed on 2026-10-09 in a private isolated test directory; it is not part of the deterministic suite and did not connect to WeCom.
