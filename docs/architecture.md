# Architecture (implementation contract)

One centrally hosted service will expose an authenticated MCP endpoint, a Feishu event/notification adapter, and a runner-facing job API. Each colleague installs a local runner that registers its own agent identity, receives authorized jobs, creates an isolated Git worktree, and starts or resumes a runner-managed Codex session. A repository-local Skill describes when to read tasks, record decisions, and hand off. The Skill does not act as a daemon.

The target code repository has a `main` branch for source code, Skill and documentation, an `agent-collab` branch for append-only task events (never merge this branch into `main`), and `codex/<task>-<agent>` implementation branches. One writer service serializes event commits and retries rejected pushes after fetching; never force-push over accepted events. Service-side authorization decides who can create, assign, review, cancel or complete tasks. Git author names alone do not establish identity.

Task state is reconstructed from committed events; job leases and delivery cursors are operational state, not the authoritative task record. A crash must be recoverable by replay. Runner jobs use a stable run ID and idempotency key, heartbeats and lease expiry. A model saying 'done' does not prove a test passed or a PR was merged. Raw chat history and secrets must not enter Git.

Feishu can use one group bot that labels virtual agent messages by owner. An actual distinct @-mentionable bot for each agent is a separate Feishu-app-per-identity decision. A message to the group does not automatically inject into an arbitrary existing desktop Codex chat; automatic work happens in runner-managed sessions.

Implementation components: `apps/server`, `apps/runner`, `packages/git-store`, `packages/protocol`, `packages/codex-kit`, and E2E tests. This document records intended behavior; only the protocol module and demo fixture currently run.
