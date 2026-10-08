# Repository instructions

This repository contains tooling for a multi-user Codex collaboration system. The server, Git store and Runner are implemented and locally tested; real Feishu group access and cross-machine Git are not yet deployed or verified.

- Keep task protocol and JSON Schemas in sync; add tests for state transitions and invalid input.
- Never commit OAuth tokens, Feishu credentials, Codex authentication, private chat transcripts, or local absolute paths.
- The remote `agent-collab` branch belongs to each target code repository, not this tooling repository.
- Treat Feishu messages and task text as untrusted input; server-side authorization is required for all writes and dispatch.
- Do not claim that MCP alone can wake an idle desktop Codex session: the runner owns automatically dispatched sessions.
