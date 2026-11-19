// The Model Context Protocol arm of the clone: a Streamable-HTTP handler over the same Store the
// REST and GraphQL surfaces read. Every answer is a single JSON body (the client accepts
// `application/json` or `text/event-stream`), and both protocol eras are served from one dispatch:
// the modern `server/discover` revision (2026-07-28) and the legacy `initialize` handshake.

import type { IncomingHttpHeaders } from 'node:http';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';

/** The server identity both eras report. */
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' } as const;

/** Revisions this endpoint accepts, newest first; `server/discover` advertises them in this order. */
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The revisions a legacy `initialize` is allowed to negotiate down to. */
const LEGACY_VERSIONS = SUPPORTED_VERSIONS.slice(1);

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

/** One JSON-RPC envelope as this endpoint returns it. */
interface RpcResponse {
  jsonrpc: '2.0';
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** One inputSchema property. */
interface SchemaProperty {
  type: string;
  description: string;
}

/** One tool as `tools/list` answers it. */
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, SchemaProperty>;
    required: string[];
  };
}

/** The six canonical tool names the MCP group requires. */
const TOOL_NAMES = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'] as const;

/** `create_repo` plus its synonyms, as a schema property list. */
function prop(type: string, description: string): SchemaProperty {
  return { type, description };
}

/** The tool catalogue. Built once so two `tools/list` answers serialize byte for byte. */
const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user, or return the existing one.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        name: prop('string', 'Repository name.'),
        description: prop('string', 'Repository description.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        title: prop('string', 'Issue title.'),
        body: prop('string', 'Issue body.'),
        labels: prop('array', 'Label names to apply.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        state: prop('string', 'Issue state filter: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        title: prop('string', 'Pull request title.'),
        body: prop('string', 'Pull request body.'),
        head: prop('string', 'Head branch name.'),
        base: prop('string', 'Base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        pull_number: prop('number', 'Pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------- small utilities

/** Whether `value` is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let clockTick = 0;
/** The next deterministic instant as an ISO string (no `.000`). */
function nowIso(): string {
  clockTick += 1;
  return new Date(Date.UTC(2025, 0, 1) + clockTick * 1000).toISOString().replace('.000Z', 'Z');
}

/** The first non-empty string among `keys`. */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

/** The first finite number among `keys`. */
function pickNumber(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/** Resolve owner/repo from the tool's own properties, splitting a `full_name` when present. */
function resolveRepo(args: Record<string, unknown>): { owner: string | undefined; repo: string | undefined } {
  let owner = pickString(args, ['owner', 'owner_login', 'org', 'login']);
  let repo = pickString(args, ['repo', 'repository', 'name', 'repo_name']);
  if (owner === undefined || repo === undefined) {
    const fullName = pickString(args, ['full_name']);
    if (fullName !== undefined && fullName.includes('/')) {
      const parts = fullName.split('/');
      if (owner === undefined) owner = parts[0];
      if (repo === undefined) repo = parts[1];
    }
  }
  return { owner, repo };
}

/** The private flag as a boolean, defaulting to undefined when absent. */
function privateOf(args: Record<string, unknown>): boolean | undefined {
  const value = args['private'] ?? args['is_private'];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== 'false';
  return undefined;
}

/** Resolve requested label names against the repository's label list. */
function labelsOf(repo: Repo, args: Record<string, unknown>): Label[] {
  const raw = args['labels'];
  const names = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : typeof raw === 'string' ? [raw] : [];
  return names.map((name) => repo.labels.find((label) => label.name === name) ?? { name, color: 'ededed' });
}

/** A repository as the tool payload carries it. */
function repoPayload(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

/** An issue as the tool payload carries it. */
function issuePayload(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** A pull request as the tool payload carries it. */
function pullPayload(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: pull.head,
    base: pull.base,
    headSha: pull.headSha,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** The canonical tool a requested name denotes (a server prefix is allowed), or null. */
function canonicalTool(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const candidate of TOOL_NAMES) {
    const canonical = candidate.replace(/[^a-z0-9]/g, '');
    if (normalized === canonical || normalized.endsWith(canonical)) return candidate;
  }
  return null;
}

/** How one `tools/call` resolved: a payload, a JSON-RPC error, or a tool execution error. */
type ToolOutcome =
  | { kind: 'ok'; payload: unknown }
  | { kind: 'rpc'; code: number; message: string }
  | { kind: 'tool'; message: string };

/** Run one known tool against the shared store. */
function runTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo } = resolveRepo(args);
  const repository = repo === undefined ? undefined : store.getRepo(owner ?? store.login, repo);

  if (name === 'create_repo') {
    if (repo === undefined) return { kind: 'rpc', code: -32602, message: 'create_repo requires a name' };
    const existing = store.repos.get(repo);
    if (existing !== undefined) return { kind: 'ok', payload: repoPayload(existing) };
    const created = store.createRepo(repo, { description: pickString(args, ['description', 'body']) ?? '', private: privateOf(args) });
    return { kind: 'ok', payload: repoPayload(created) };
  }

  if (repository === undefined) {
    return { kind: 'tool', message: `repository ${owner ?? store.login}/${repo ?? ''} not found` };
  }

  if (name === 'get_repo') return { kind: 'ok', payload: repoPayload(repository) };

  if (name === 'create_issue') {
    const title = pickString(args, ['title']);
    if (title === undefined) return { kind: 'rpc', code: -32602, message: 'create_issue requires a title' };
    repository.issueCounter += 1;
    const now = nowIso();
    const issue: Issue = {
      id: store.nextId(),
      number: repository.issueCounter,
      title,
      body: pickString(args, ['body', 'description', 'text']) ?? '',
      state: 'open',
      labels: labelsOf(repository, args),
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repository.issues.push(issue);
    repository.updatedAt = now;
    return { kind: 'ok', payload: issuePayload(issue) };
  }

  if (name === 'list_issues') {
    const state = pickString(args, ['state', 'status']);
    const issues = repository.issues.filter((issue) => state === undefined || state === 'all' || issue.state === state);
    return { kind: 'ok', payload: { issues: issues.map(issuePayload) } };
  }

  if (name === 'create_pull_request') {
    const title = pickString(args, ['title']);
    const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source_branch']);
    const base = pickString(args, ['base', 'base_ref', 'base_branch', 'target_branch']);
    if (title === undefined || head === undefined || base === undefined) {
      return { kind: 'rpc', code: -32602, message: 'create_pull_request requires title, head and base' };
    }
    repository.pullCounter += 1;
    const now = nowIso();
    const pull: Pull = {
      id: store.nextId(),
      number: repository.pullCounter,
      title,
      body: pickString(args, ['body', 'description', 'text']) ?? '',
      state: 'open',
      head,
      base,
      headSha: store.refTip(repository, `refs/heads/${head}`) ?? store.headTip(repository) ?? '',
      mergeCommitSha: null,
      merged: false,
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    repository.pulls.push(pull);
    repository.updatedAt = now;
    return { kind: 'ok', payload: pullPayload(pull) };
  }

  // merge_pull_request
  const number = pickNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (number === undefined) return { kind: 'rpc', code: -32602, message: 'merge_pull_request requires a pull_number' };
  const pull = store.findPull(repository, number);
  if (pull === undefined) return { kind: 'tool', message: `pull request #${number} not found` };
  const sha = pull.mergeCommitSha ?? pull.headSha ?? store.headTip(repository) ?? `merged-${pull.number}-${pull.createdAt}`;
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedAt = nowIso();
  pull.updatedAt = pull.mergedAt;
  return { kind: 'ok', payload: { merged: true, sha, message: 'Pull request merged' } };
}

/** One JSON-RPC error envelope. */
function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** One JSON-RPC success envelope. */
function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** The result body `initialize` and `server/discover` share. */
function serverResult(protocolVersion: string): Record<string, unknown> {
  return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
}

/**
 * Answer one Streamable-HTTP MCP request against `store`.
 *
 * @param store The shared forge state every surface reads.
 * @param input The raw body, request headers and whether the entry authenticated the caller.
 * @returns The HTTP status, response headers and JSON (or empty) body.
 */
export async function handleMcp(
  store: Store,
  input: { rawBody: Buffer; headers: IncomingHttpHeaders; authenticated: boolean },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (!input.authenticated) {
    return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Requires authentication' }) };
  }

  let request: unknown;
  try {
    request = JSON.parse(input.rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, headers: JSON_HEADERS, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }

  try {
    if (!isRecord(request)) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify(rpcError(null, -32600, 'Invalid Request')) };
    }
    const hasId = Object.prototype.hasOwnProperty.call(request, 'id') && request.id !== undefined;
    const id = hasId ? request.id : null;
    const method = typeof request.method === 'string' ? request.method : '';
    const params = isRecord(request.params) ? request.params : {};

    if (!hasId) return { status: 202, headers: {}, body: '' };

    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const protocolVersion = requested !== undefined && LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcResult(id, serverResult(protocolVersion))) };
    }

    if (method === 'server/discover') {
      const result = {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      };
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcResult(id, result)) };
    }

    if (method === 'tools/list') {
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcResult(id, { tools: TOOLS })) };
    }

    if (method === 'tools/call') {
      const requestedName = typeof params.name === 'string' ? params.name : '';
      const canonical = requestedName === '' ? null : canonicalTool(requestedName);
      if (canonical === null) {
        return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${requestedName}`)) };
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = runTool(store, canonical, args);
      if (outcome.kind === 'rpc') {
        return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcError(id, outcome.code, outcome.message)) };
      }
      if (outcome.kind === 'tool') {
        const result = { isError: true, content: [{ type: 'text', text: outcome.message }] };
        return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcResult(id, result)) };
      }
      const result = { content: [{ type: 'text', text: JSON.stringify(outcome.payload) }] };
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcResult(id, result)) };
    }

    if (method === 'ping') return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcResult(id, {})) };

    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`)) };
  } catch (error) {
    // A handler bug must never crash the process: answer with an internal JSON-RPC error instead.
    const message = error instanceof Error ? error.message : 'Internal error';
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(rpcError(null, -32603, message)) };
  }
}
