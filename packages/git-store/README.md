# Git store — not implemented

Only the collaboration service writes `agent-collab`. Serialize task event sequence allocation, commit append-only unique event paths, push with conflict detection, fetch/revalidate/retry on rejected push; never force push. Runtime queue and leases must be recoverable by replaying committed events.
