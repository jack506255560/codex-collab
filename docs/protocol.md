# Task protocol v1 (draft)

## Location

For each target repository, store `.agent-collab/tasks/<task-id>/spec.json` and `.agent-collab/tasks/<task-id>/events/<zero-padded-sequence>-<event-id>.json` on the dedicated `agent-collab` branch. Examples: `000001-evt-created.json`. The `main` branch keeps the versioned protocol docs and Skill. Do not merge `agent-collab` into `main`; code changes travel through separate feature branches and PRs.

## Contracts

Task IDs are opaque and unique within a repository. `spec.json` defines repository ID, title, base branch and non-empty acceptance criteria. Each event has `schema_version`, `event_id`, `task_id`, monotonically increasing `seq`, `type`, `actor_id`, UTC `occurred_at` and `idempotency_key`. Events may contain a short summary, target agent, run ID and Git/PR/test references. Clients must not trust client-supplied actor IDs: the server binds actors to authenticated identities. The service validates the expected sequence and transition before committing, and retries a rejected Git push by refetching/revalidating rather than overwriting remote history.

## State machine

`uncreated --created--> open --assigned--> assigned --run_started--> running --review_requested--> review --reviewed(approved)--> approved --completed--> completed`.

From `running`, `progress` stays `running`, `blocked` or `run_failed` becomes `blocked`, and `handoff` becomes `waiting`. From `blocked` or `waiting`, `assigned` returns to `assigned`. From `review`, `reviewed(changes_requested)` becomes `blocked`. `cancelled` terminates any nonterminal state. A `completed` event is allowed only after approved review, and must carry evidence references as required by the server policy. Run completion and task completion are different events.

The server must deduplicate Feishu event IDs and write idempotency keys. For two concurrent modifications, assignments and sequence allocation are serialized at the Git-writing service. A Git commit author string is not an authorization mechanism. Do not commit full chat transcripts, authentication material or private filesystem paths.

Schemas: `schemas/task.schema.json`, `schemas/event.schema.json`. A simple executable reducer lives in `packages/protocol/src/index.mjs`.
