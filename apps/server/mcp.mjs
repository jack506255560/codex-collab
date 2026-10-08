import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const required = z.string().min(1);

export function makeMcpServer(service, user) {
  const server = new McpServer({ name: 'codex-collab', version: '0.1.0' });
  const tool = (name, description, schema, fn) => server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try { return text(await fn(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  tool('list_tasks', 'List shared tasks and current statuses in this repository', z.object({}), () => service.list());
  tool('read_task', 'Read the versioned task spec and append-only handoff events', z.object({ task_id: required }), ({ task_id }) => service.read(task_id));
  tool('create_task', 'Create a Git-backed task', z.object({
    title: required, description: z.string().default(''), acceptance: z.array(required).min(1),
    reviewer: z.string().optional(), idempotency_key: z.string().optional()
  }), ({ idempotency_key, ...input }) => service.create(user, input, idempotency_key));
  tool('assign_task', 'Assign a task (admins only)', z.object({ task_id: required, assignee: required, idempotency_key: z.string().optional() }),
    ({ task_id, assignee, idempotency_key }) => service.assign(user, task_id, assignee, idempotency_key));
  tool('report_task', 'Append a progress, blocked, handoff or review event with optimistic revision control', z.object({
    task_id: required, expected_seq: z.number().int().nonnegative(),
    type: z.enum(['progress', 'blocked', 'handoff', 'review_requested', 'reviewed', 'review_note', 'run_failed', 'completed', 'cancelled']),
    summary: z.string().max(4000).optional(), decision: z.enum(['approved', 'changes_requested']).optional(),
    refs: z.object({ branch: z.string().optional(), commit: z.string().optional(), pr: z.string().optional(), tests: z.string().optional() }).optional(),
    idempotency_key: z.string().optional()
  }), ({ task_id, expected_seq, idempotency_key, ...payload }) => service.report(user, task_id, payload, expected_seq, idempotency_key));
  return server;
}

export async function handleMcpHttp(req, res, service, user) {
  // Stateless transport: a fresh MCP server is bound to the authenticated user for each request.
  const server = makeMcpServer(service, user);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { await transport.handleRequest(req, res); }
  finally { await server.close(); }
}
