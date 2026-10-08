# Collaboration service — not implemented

Responsibilities: authenticated MCP endpoint; Git event writer and state replay; identity/repository permissions; Feishu event gateway and notifications; durable dispatch queue and runner API. Do not put Feishu app credentials in the repository. A single deployable is enough initially, but separate interfaces and authorization boundaries.
