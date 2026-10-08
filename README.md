# Codex Collab

让不同同事的 Codex 在各自的机器和 Git worktree 中协作；任务协议与事件保存在目标代码仓库的 `agent-collab` 分支。

> 当前状态：**初始脚手架**。已建立协议草案、协议状态机及测试、Skill 模板和演示仓库；MCP 服务、飞书接入、本机 Runner、身份认证及安装器**尚未实现**。不要把本仓库当成可以接收飞书消息的成品。

## 仓库结构

- `apps/server/`：待实现的协作服务（MCP、飞书网关、任务调度、权限）。
- `apps/runner/`：待实现的同事电脑本机 Runner（领取任务、独立 worktree、启动/监控 Codex）。
- `packages/protocol/`：可运行的任务事件状态机及单元测试。
- `packages/git-store/`：待实现的 Git 追加事件适配器。
- `packages/codex-kit/templates/`：目标仓库可复用的 AGENTS.md、Skill 和 MCP 配置示例。
- `schemas/`、`docs/`：任务和事件格式、协作规则。
- `tests/e2e/`：未来的双机、飞书及异常恢复联调测试。

## 本地验证

需要 Node.js 20+。执行 `node --test packages/protocol/test/*.test.mjs` 验证目前已实现的协议状态机。演示仓库的基础测试运行 `sh test.sh`。

## 预期拓扑

- 这个仓库保存工具源代码和协议定义。
- `codex-collab-demo` 是独立的测试仓库，其 `main` 存放演示代码，其 `agent-collab` 分支存放任务事件。业务仓库采用同样的约定。
- 任务数据以 Git 为审计来源；运行时租约和通知投递游标可以使用可恢复的运行时存储，不提交凭据、完整聊天记录或机器私有路径。

设计细节见 `docs/architecture.md` 与 `docs/protocol.md`。
