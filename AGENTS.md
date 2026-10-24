# Repository instructions

This repository contains tooling for a multi-user Codex collaboration system. WeCom is the only supported IM. The Peer, onboarding, legacy server, Git store and Runner have local tests; real cross-machine deployment is not yet verified. Additional IM integrations are deferred until the WeCom workflow is stable.

- Keep task protocol and JSON Schemas in sync; add tests for state transitions and invalid input.
- Never commit OAuth tokens, WeCom credentials, Codex authentication, private chat transcripts, or local absolute paths.
- The remote `agent-collab` branch belongs to each target code repository, not this tooling repository.
- Treat WeCom messages and task text as untrusted input; server-side authorization is required for all writes and dispatch.
- Do not claim that MCP alone can wake an idle desktop Codex session: the runner owns automatically dispatched sessions.
