// GitHub REST v3 surface, backed entirely by the in-memory store.
//
// Every reply leaves as JSON (the caller only ever serializes `body`); `null | undefined` body
// with status 204 produces an empty response. Route parsing is a plain segment split, so the
// whole surface is one function and one switch.

import { parseCommit, parseTree } from './gitpack.ts';
import type { FileChange, Issue, Label, Pull, Repo, Store } from './store.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  host: string;
  authenticated: boolean;
  /** Parsed JSON body, or undefined when the body was empty or malformed. */
  json: unknown;
  malformed: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

let restClock = 0;
/** Deterministic ISO instant; the REST surface never reads the wall clock. */
function nowIso(): string {
  restClock += 1;
  return new Date(Date.UTC(2025, 0, 1) + restClock * 1000).toISOString().replace('.000Z', 'Z');
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestReply {
  return { status, body, headers: { ...JSON_HEADERS, ...headers } };
}

function notFound(): RestReply {
  return ok({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, 404);
}

function badRequest(message = 'Problems parsing JSON'): RestReply {
  return ok({ message }, 400);
}

function unauthorized(): RestReply {
  return ok({ message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' }, 401);
}

function validationFailed(): RestReply {
  return ok({ message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'invalid', field: 'labels' }] }, 422);
}

function sha40(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : '';
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Repository views

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: 1, type: 'User' },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    permissions: { admin: true, push: true, pull: true },
    has_issues: true,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelView),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    user: { login: repo.owner, id: 1, type: 'User' },
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.headSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: true,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: { login: repo.owner, id: 1, type: 'User' },
  };
}

// ---------------------------------------------------------------------------------------------
// Git-level helpers

interface TreeEntryInfo {
  mode: string;
  oid: string;
}

function commitTree(repo: Repo, commitOid: string | undefined): string | null {
  if (commitOid === undefined) return null;
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

function branchTree(repo: Repo, branch: string): string | null {
  return commitTree(repo, repo.refs.get(`refs/heads/${branch}`));
}

/** Resolve `path` inside `treeOid`; `undefined` when absent. */
function resolvePath(repo: Repo, treeOid: string | null, path: string): { kind: 'file'; entry: TreeEntryInfo } | { kind: 'dir'; oid: string } | undefined {
  if (treeOid === null) return undefined;
  if (path === '') return { kind: 'dir', oid: treeOid };
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return undefined;
    const isTree = entry.mode === '40000' || entry.mode === '040000';
    const last = i === parts.length - 1;
    if (last) return isTree ? { kind: 'dir', oid: entry.oid } : { kind: 'file', entry: { mode: entry.mode, oid: entry.oid } };
    if (!isTree) return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** Common ancestor of two commits (the branch point). */
function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const seenA = new Set<string>();
  const walkA = [a];
  while (walkA.length > 0) {
    const sha = walkA.shift() as string;
    if (seenA.has(sha)) continue;
    seenA.add(sha);
    const object = repo.objects.get(sha);
    if (object !== undefined && object.type === 'commit') for (const parent of parseCommit(object.data).parents) walkA.push(parent);
  }
  const seenB = new Set<string>();
  const walkB = [b];
  while (walkB.length > 0) {
    const sha = walkB.shift() as string;
    if (seenB.has(sha)) continue;
    seenB.add(sha);
    if (seenA.has(sha)) return sha;
    const object = repo.objects.get(sha);
    if (object !== undefined && object.type === 'commit') for (const parent of parseCommit(object.data).parents) walkB.push(parent);
  }
  return undefined;
}

/** Paths whose blob differs between two blob maps. */
function changedPaths(from: Map<string, string>, to: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [path, oid] of to) if (from.get(path) !== oid) out.add(path);
  for (const path of from.keys()) if (!to.has(path)) out.add(path);
  return out;
}

/** Changes that turn `from` into `to`, for replaying onto another tree. */
function diffChanges(from: Map<string, string>, to: Map<string, string>): FileChange[] {
  const out: FileChange[] = [];
  for (const [path, oid] of to) if (from.get(path) !== oid) out.push({ path, oid });
  for (const path of from.keys()) if (!to.has(path)) out.push({ path, oid: null });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Contents handlers

function contentFileView(repo: Repo, path: string, entry: TreeEntryInfo): Record<string, unknown> {
  const object = repo.objects.get(entry.oid);
  const data = object?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: entry.oid,
    size: data.length,
    encoding: 'base64',
    content: data.toString('base64'),
  };
}

function contentDirView(repo: Repo, oid: string, prefix: string): Record<string, unknown>[] {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data)
    .map((entry) => {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const isTree = entry.mode === '40000' || entry.mode === '040000';
      const blob = isTree ? undefined : repo.objects.get(entry.oid);
      return {
        type: isTree ? 'dir' : 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob?.data.length ?? 0,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Write `content` at `path` on `branch`, minting a commit. */
function writeContent(store: Store, repo: Repo, branch: string, path: string, content: string, message: string): { status: number; blobSha: string; commitSha: string } {
  const baseTree = branchTree(repo, branch);
  const existing = resolvePath(repo, baseTree, path);
  const blobSha = store.putBlob(repo, Buffer.from(content, 'base64'));
  const tree = store.treeWithChanges(repo, baseTree, [{ path, oid: blobSha, mode: existing?.kind === 'file' ? existing.entry.mode : '100644' }]);
  const parents = repo.refs.get(`refs/heads/${branch}`) === undefined ? [] : [repo.refs.get(`refs/heads/${branch}`) as string];
  const commitSha = store.commit(repo, branch, message, tree, parents);
  return { status: existing === undefined ? 201 : 200, blobSha, commitSha };
}

// ---------------------------------------------------------------------------------------------
// Router

export function handleRest(store: Store, request: RestRequest): RestReply | null {
  const { method } = request;
  let path = request.pathname.startsWith('/api/v3') ? request.pathname.slice('/api/v3'.length) : request.pathname;
  if (path === '') path = '/';
  const query = request.searchParams;
  const segments = path.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/settings/connections/applications{/client_id}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (segments.length === 1 && segments[0] === 'meta') {
    return method === 'GET' ? ok({ installed_version: '1.0.0', verifiable_password_authentication: true }) : notFound();
  }

  if (segments.length === 1 && segments[0] === 'rate_limit') {
    return method === 'GET' ? ok({ resources: { core: { limit: 5000, remaining: 4999, reset: 1735693200 } } }) : notFound();
  }

  // --- user surface -------------------------------------------------------------------------
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound();
      if (!request.authenticated) return unauthorized();
      return ok({ login: store.login, id: 1, type: 'User', name: store.login, site_admin: false });
    }
    if (segments[1] === 'repos') {
      if (!request.authenticated) return unauthorized();
      if (method === 'GET') return listUserRepos(store, request);
      if (method === 'POST') return createUserRepo(store, request);
      return notFound();
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();

  const repo = store.getRepo(segments[1] as string, segments[2] as string);
  if (repo === undefined) return notFound();
  if (!request.authenticated) return unauthorized();

  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoView(repo));
    if (method === 'PATCH') {
      const body = asObject(request.json);
      if (request.malformed || body === undefined) return badRequest();
      if (typeof body.description === 'string') {
        repo.description = body.description;
        repo.updatedAt = nowIso();
      }
      return ok(repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(segments[1] as string, segments[2] as string);
      return { status: 204 };
    }
    return notFound();
  }

  if (request.malformed && method !== 'GET' && method !== 'DELETE') return badRequest();

  switch (rest[0]) {
    case 'branches':
      if (rest.length === 1 && method === 'GET') return listBranches(repo);
      return notFound();
    case 'commits':
      if (rest.length === 1 && method === 'GET') return listCommits(repo, query);
      return notFound();
    case 'git':
      if (rest.length === 2 && rest[1] === 'refs' && method === 'POST') return createRef(repo, request);
      if (rest.length === 2 && rest[1] === 'refs' && method === 'GET') return listRefs(repo);
      return notFound();
    case 'contents':
      return handleContents(store, repo, rest.slice(1), method, request);
    case 'labels':
      if (rest.length === 1) {
        if (method === 'POST') return createLabel(repo, request);
        if (method === 'GET') return ok(repo.labels.map(labelView));
      }
      return notFound();
    case 'issues':
      return handleIssues(store, repo, rest.slice(1), method, request);
    case 'pulls':
      return handlePulls(store, repo, rest.slice(1), method, request);
    default:
      return notFound();
  }
}

function listUserRepos(store: Store, request: RestRequest): RestReply {
  const perPage = Math.max(1, Math.min(100, Number(request.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(request.searchParams.get('page') ?? '1') || 1);
  const all = store.listRepos(store.login);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (start + perPage < all.length) {
    const next = new URL(`http://${request.host}/api/v3/user/repos`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { status: 200, body: slice.map(repoView), headers };
}

function createUserRepo(store: Store, request: RestRequest): RestReply {
  const body = asObject(request.json);
  if (request.malformed || body === undefined) return badRequest();
  const name = asString(body.name);
  if (name === undefined || name === '') return ok({ message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] }, 422);
  const existing = store.repos.get(name);
  if (existing !== undefined) return ok({ message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'already_exists', message: 'name already exists on this account' }] }, 422);
  const repo = store.createRepo(name, { description: asString(body.description), private: body.private !== false });
  return ok(repoView(repo), 201);
}

function listBranches(repo: Repo): RestReply {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  if (branches.length === 0 && repo.refs.has('HEAD')) branches.push({ name: repo.defaultBranch, commit: { sha: repo.refs.get('HEAD') as string } });
  branches.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
  return ok(branches);
}

function listRefs(repo: Repo): RestReply {
  const refs: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) refs.push({ ref, node_id: ref, object: { sha, type: 'commit' } });
  return ok(refs);
}

function createRef(repo: Repo, request: RestRequest): RestReply {
  const body = asObject(request.json);
  if (body === undefined) return badRequest();
  const ref = asString(body.ref);
  const sha = sha40(body.sha);
  if (ref === undefined || sha === '') return ok({ message: 'Validation Failed' }, 422);
  if (!repo.objects.has(sha)) return ok({ message: 'Object does not exist' }, 422);
  repo.refs.set(ref, sha);
  if (ref.startsWith('refs/heads/')) repo.updatedAt = nowIso();
  return ok({ ref, node_id: ref, object: { sha, type: 'commit' } }, 201);
}

function listCommits(repo: Repo, query: URLSearchParams): RestReply {
  const ref = query.get('sha') ?? repo.defaultBranch;
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? (repo.objects.has(ref) ? ref : undefined);
  const commits = store_log(repo, tip);
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  return ok(commits.slice(0, perPage));
}

function store_log(repo: Repo, tip: string | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor = tip;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const object = repo.objects.get(cursor);
    if (object === undefined || object.type !== 'commit') break;
    const commit = parseCommit(object.data);
    out.push({
      sha: cursor,
      node_id: cursor,
      commit: {
        message: commit.message,
        author: { name: commit.author, date: commit.authorDate },
        committer: { name: commit.committer, date: commit.committerDate },
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((sha) => ({ sha })),
    });
    cursor = commit.parents[0];
  }
  return out;
}

function handleContents(store: Store, repo: Repo, rest: string[], method: string, request: RestRequest): RestReply {
  const path = rest.join('/');
  const ref = request.searchParams.get('ref') ?? undefined;
  const branch = ref === undefined ? repo.defaultBranch : ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const treeOid = branchTree(repo, branch);

  if (method === 'GET') {
    const resolved = resolvePath(repo, treeOid, path);
    if (resolved === undefined) return notFound();
    if (resolved.kind === 'file') return ok(contentFileView(repo, path, resolved.entry));
    return ok(contentDirView(repo, resolved.oid, path));
  }

  const body = asObject(request.json);
  if (body === undefined) return badRequest();

  if (method === 'PUT') {
    const content = asString(body.content);
    if (content === undefined) return ok({ message: 'Validation Failed', errors: [{ field: 'content', code: 'missing_field' }] }, 422);
    const message = asString(body.message) ?? '';
    const targetBranch = asString(body.branch) ?? repo.defaultBranch;
    const existing = resolvePath(repo, branchTree(repo, targetBranch), path);
    const supplied = body.sha === undefined ? undefined : sha40(body.sha);
    if (supplied !== undefined && supplied !== '' && existing !== undefined && existing.kind === 'file' && existing.entry.oid !== supplied) {
      return ok({ message: `The sha (${supplied}) does not match the current sha (${existing.entry.oid})` }, 409);
    }
    const result = writeContent(store, repo, targetBranch, path, content, message);
    return ok({ content: { sha: result.blobSha, encoding: 'base64' }, commit: { sha: result.commitSha } }, result.status);
  }

  if (method === 'DELETE') {
    const existing = resolvePath(repo, treeOid, path);
    if (existing === undefined) return notFound();
    if (existing.kind === 'dir') return ok({ message: 'Cannot delete a directory' }, 422);
    const message = asString(body.message) ?? '';
    const tree = store.treeWithChanges(repo, treeOid, [{ path, oid: null }]);
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const commitSha = store.commit(repo, branch, message, tree, parent === undefined ? [] : [parent]);
    return ok({ commit: { sha: commitSha }, content: null });
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// Issues

function handleIssues(store: Store, repo: Repo, rest: string[], method: string, request: RestRequest): RestReply {
  if (rest.length === 0) {
    if (method === 'GET') return ok(listIssueViews(repo, request.searchParams));
    if (method === 'POST') return createIssue(store, repo, request);
    return notFound();
  }
  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? storeFindIssue(repo, number) : undefined;
  if (issue === undefined) return notFound();
  if (rest.length === 1) {
    if (method === 'GET') return ok(issueView(repo, issue));
    if (method === 'PATCH') return patchIssue(store, repo, issue, request);
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') return ok(issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt })));
    if (method === 'POST') return createComment(store, repo, issue, request);
    return notFound();
  }
  if (rest.length === 3 && rest[1] === 'comments' && Number.isInteger(Number(rest[2])) && method === 'GET') {
    const comment = issue.comments.find((candidate) => candidate.id === Number(rest[2]));
    return comment === undefined ? notFound() : ok({ id: comment.id, body: comment.body, created_at: comment.createdAt });
  }
  return notFound();
}

function storeFindIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((candidate) => candidate.number === number);
}

function listIssueViews(repo: Repo, query: URLSearchParams): Record<string, unknown>[] {
  const state = (query.get('state') ?? 'open').toLowerCase();
  const sort = (query.get('sort') ?? 'created').toLowerCase();
  const direction = (query.get('direction') ?? (sort === 'created' ? 'desc' : 'asc')).toLowerCase();
  const labels = (query.get('labels') ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '');
  let issues = repo.issues.slice();
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (labels.length > 0) issues = issues.filter((issue) => labels.every((label) => issue.labels.some((entry) => entry.name === label)));
  const key = (issue: Issue): string | number => (sort === 'updated' ? issue.updatedAt : sort === 'comments' ? issue.comments.length : issue.number);
  issues.sort((a, b) => {
    const left = key(a);
    const right = key(b);
    const order = left < right ? -1 : left > right ? 1 : 0;
    return direction === 'asc' ? order : -order;
  });
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return issues.slice((page - 1) * perPage, page * perPage).map((issue) => issueView(repo, issue));
}

function createIssue(store: Store, repo: Repo, request: RestRequest): RestReply {
  const body = asObject(request.json);
  if (body === undefined) return badRequest();
  const title = asString(body.title);
  if (title === undefined) return ok({ message: 'Validation Failed', errors: [{ field: 'title', code: 'missing_field' }] }, 422);
  const names = Array.isArray(body.labels) ? body.labels.filter((value): value is string => typeof value === 'string') : [];
  const resolved: Label[] = [];
  for (const name of names) {
    const label = repo.labels.find((candidate) => candidate.name === name);
    if (label === undefined) return validationFailed();
    resolved.push(label);
  }
  const now = nowIso();
  repo.issueCounter += 1;
  const issue: Issue = {
    id: repo.id * 1000 + repo.issueCounter,
    number: repo.issueCounter,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    labels: resolved,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.push(issue);
  return ok(issueView(repo, issue), 201);
}

function patchIssue(store: Store, repo: Repo, issue: Issue, request: RestRequest): RestReply {
  const body = asObject(request.json);
  if (body === undefined) return badRequest();
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? nowIso() : null;
  }
  issue.updatedAt = nowIso();
  return ok(issueView(repo, issue));
}

function createComment(store: Store, repo: Repo, issue: Issue, request: RestRequest): RestReply {
  const body = asObject(request.json);
  if (body === undefined) return badRequest();
  const text = asString(body.body) ?? '';
  repo.commentCounter += 1;
  const comment = { id: repo.commentCounter, body: text, createdAt: nowIso() };
  issue.comments.push(comment);
  return ok({ id: comment.id, body: comment.body, created_at: comment.createdAt }, 201);
}

function createLabel(repo: Repo, request: RestRequest): RestReply {
  const body = asObject(request.json);
  if (body === undefined) return badRequest();
  const name = asString(body.name);
  if (name === undefined) return ok({ message: 'Validation Failed', errors: [{ field: 'name', code: 'missing_field' }] }, 422);
  if (repo.labels.some((label) => label.name === name)) return ok({ message: 'Validation Failed', errors: [{ field: 'name', code: 'already_exists' }] }, 422);
  const label: Label = { name, color: asString(body.color) ?? 'ededed' };
  repo.labels.push(label);
  return ok(labelView(label), 201);
}

// ---------------------------------------------------------------------------------------------
// Pull requests

function handlePulls(store: Store, repo: Repo, rest: string[], method: string, request: RestRequest): RestReply {
  if (rest.length === 0) {
    if (method === 'GET') return ok(listPullViews(repo, request.searchParams));
    if (method === 'POST') return createPull(store, repo, request);
    return notFound();
  }
  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.find((candidate) => candidate.number === number) : undefined;
  if (pull === undefined) return notFound();
  if (rest.length === 1 && method === 'GET') return ok(pullView(repo, pull));
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') return ok(pullFiles(store, repo, pull));
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') return mergePull(store, repo, pull, request);
  return notFound();
}

function listPullViews(repo: Repo, query: URLSearchParams): Record<string, unknown>[] {
  const state = (query.get('state') ?? 'open').toLowerCase();
  const pulls = state === 'all' ? repo.pulls.slice() : repo.pulls.filter((pull) => pull.state === state);
  return pulls.map((pull) => pullView(repo, pull));
}

function createPull(store: Store, repo: Repo, request: RestRequest): RestReply {
  const body = asObject(request.json);
  if (body === undefined) return badRequest();
  const head = asString(body.head);
  const base = asString(body.base) ?? repo.defaultBranch;
  const title = asString(body.title);
  if (head === undefined || title === undefined) return ok({ message: 'Validation Failed', errors: [{ field: 'head', code: 'missing_field' }] }, 422);
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (headSha === undefined) return ok({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] }, 422);
  repo.pullCounter += 1;
  const now = nowIso();
  const pull: Pull = {
    id: repo.id * 1000 + repo.pullCounter,
    number: repo.pullCounter,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    head,
    base,
    headSha,
    mergeCommitSha: null,
    merged: false,
    mergedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.push(pull);
  return ok(pullView(repo, pull), 201);
}

function pullFiles(store: Store, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const common = baseTip === undefined || headTip === undefined ? undefined : mergeBase(repo, baseTip, headTip);
  const baseSet = store.blobSet(repo, common);
  const headSet = store.blobSet(repo, headTip);
  const paths = changedPaths(baseSet, headSet);
  return [...paths].sort().map((path) => {
    const before = baseSet.get(path);
    const after = headSet.get(path);
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const content = after === undefined ? '' : (repo.objects.get(after)?.data.toString('utf8') ?? '');
    const additions = after === undefined ? 0 : Math.max(1, content.split('\n').length);
    const deletions = before === undefined ? 0 : (repo.objects.get(before)?.data.toString('utf8') ?? '').split('\n').length;
    return {
      sha: after ?? before ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `/api/v3/repos/${repo.owner}/${repo.name}/blob/${pull.head}/${path}`,
    };
  });
}

function mergePull(store: Store, repo: Repo, pull: Pull, request: RestRequest): RestReply {
  if (pull.merged) return ok({ message: 'Pull Request is not mergeable' }, 405);
  const body = asObject(request.json) ?? {};
  const method = asString(body.merge_method) ?? 'merge';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  if (baseTip === undefined || headTip === undefined) return ok({ message: 'Pull Request is not mergeable' }, 405);
  const common = mergeBase(repo, baseTip, headTip);
  const commonSet = store.blobSet(repo, common);
  const baseSet = store.blobSet(repo, baseTip);
  const headSet = store.blobSet(repo, headTip);
  if (common !== undefined) {
    const baseChanged = changedPaths(commonSet, baseSet);
    const headChanged = changedPaths(commonSet, headSet);
    for (const path of headChanged) if (baseChanged.has(path)) return ok({ message: 'Pull Request is not mergeable' }, 405);
  }
  const baseTree = commitTree(repo, baseTip);
  const changes = diffChanges(commonSet, headSet);
  const tree = store.treeWithChanges(repo, baseTree, changes);
  const message = method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.head}`;
  const commitSha = store.commit(repo, pull.base, message, tree, [baseTip]);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = commitSha;
  return ok({ sha: commitSha, merged: true, message: 'Pull Request successfully merged' });
}
