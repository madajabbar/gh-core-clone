// Hand-rolled GraphQL v4 for the forge: lexer, parser, AST executor, introspection.
//
// Runs on `node --experimental-strip-types`: erasable TypeScript only, `node:` builtins only,
// relative ESM imports carry their `.ts` suffix. `handleGraphQL` never throws.

import { parseCommit } from './gitpack.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// AST

interface GqlArgument {
  name: string;
  value: GqlValue;
}

interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: GqlArgument[];
  selections: GqlSelection[];
}

interface GqlInlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: GqlSelection[];
}

type GqlSelection = GqlField | GqlInlineFragment;

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: GqlArgument[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

// ---------------------------------------------------------------------------------------------
// Lexer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

/** Read a double-quoted GraphQL string starting at `start`; returns the value and the next index. */
function readString(source: string, start: number): [string, number] {
  let i = start + 1;
  let out = '';
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '"') return [out, i + 1];
    if (ch === '\\') {
      const esc = source[i + 1];
      if (esc === 'u') {
        const hex = source.slice(i + 2, i + 6);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      const table: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      out += table[esc ?? ''] ?? (esc ?? '');
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  throw new Error('Unterminated string');
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.') {
      if (source.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      throw new Error('Unexpected "."');
    }
    if ('!$&():=@[]{|}'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      const [value, next] = readString(source, i);
      tokens.push({ kind: 'string', value });
      i = next;
      continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
    if (number !== null && number[0] !== '') {
      tokens.push({ kind: number[0].includes('.') || /[eE]/.test(number[0]) ? 'float' : 'int', value: number[0] });
      i += number[0].length;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (name !== null && name[0] !== '') {
      tokens.push({ kind: 'name', value: name[0] });
      i += name[0].length;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser

class GqlParser {
  tokens: Token[];
  pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  isName(value: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.value === value;
  }

  expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`Expected "${value}"`);
    this.next();
  }

  expectName(): string {
    const token = this.peek();
    if (token.kind !== 'name') throw new Error('Expected a name');
    this.next();
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        this.skipParens();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        this.expectName();
        this.expectName();
        this.skipDirectives();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token.value)}`);
    }
    if (operations.length === 0) throw new Error('No operation in document');
    return operations;
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.isPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): GqlSelection {
    if (this.isPunct('...')) {
      this.next();
      if (this.isName('on')) {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      this.expectName();
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: [] };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  parseArguments(): GqlArgument[] {
    if (!this.isPunct('(')) return [];
    this.next();
    const args: GqlArgument[] = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): GqlValue {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number(token.value) };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number(token.value) };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true' || token.value === 'false') return { kind: 'boolean', value: token.value === 'true' };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: GqlValue[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: GqlArgument[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value ${JSON.stringify(token.value)}`);
  }

  skipParens(): void {
    if (!this.isPunct('(')) return;
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
      if (token.kind === 'eof') throw new Error('Unbalanced "("');
    } while (depth > 0);
  }

  skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      this.skipParens();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Values

function valueOf(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const field of value.fields) object[field.name] = valueOf(field.value, variables);
      return object;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------------------------
// Global ids and cursors

function encodeId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function decodeId(value: unknown): { type: string; id: string } | null {
  if (typeof value !== 'string' || value === '') return null;
  const text = Buffer.from(value, 'base64').toString('utf8');
  const separator = text.indexOf(':');
  if (separator <= 0) return null;
  return { type: text.slice(0, separator), id: text.slice(separator + 1) };
}

function internalId(value: unknown): string {
  const decoded = decodeId(value);
  return decoded === null ? String(value ?? '') : decoded.id;
}
function cursorFor(type: string, id: string | number): string {
  return Buffer.from(`cursor:${type}:${id}`, 'utf8').toString('base64');
}

function repoByGlobalId(store: Store, id: string): Repo | undefined {
  for (const repo of store.repos.values()) if (String(repo.id) === id) return repo;
  return undefined;
}

function issueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((entry) => String(entry.id) === id);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function pullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((entry) => String(entry.id) === id);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Introspection registry

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'description',
    'isPrivate',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'mergedAt',
    'mergeable',
    'headRefName',
    'baseRefName',
    'headRefOid',
    'mergeCommit',
    'files',
    'createdAt',
  ],
  Ref: ['name', 'target'],
  GitObject: ['oid', 'abbreviatedOid'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Comment: ['id', 'body', 'createdAt', 'author'],
  Label: ['name', 'color'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

// ---------------------------------------------------------------------------------------------
// Clock for objects created over GraphQL

let gqlTick = 0;

function stamp(): string {
  gqlTick += 1;
  return new Date(Date.UTC(2025, 0, 1) + gqlTick * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------------------------------------
// Executor

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

interface Resolved {
  value: unknown;
  type: string;
}

function resolved(value: unknown, type: string): Resolved {
  return { value, type };
}

type Resolver = (ctx: ExecContext, parent: Record<string, unknown>, args: Map<string, unknown>) => Resolved;

function executeSelectionSet(
  selections: GqlSelection[],
  value: unknown,
  typeName: string,
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(selection.selections, value, typeName, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    try {
      const args = new Map<string, unknown>();
      for (const argument of selection.args) args.set(argument.name, valueOf(argument.value, ctx.variables));
      const result = resolveField(ctx, typeName, selection.name, value, args);
      out[key] = executeValue(selection, result, ctx);
    } catch (error) {
      ctx.errors.push({ message: String(error instanceof Error ? error.message : error) });
      out[key] = null;
    }
  }
  return out;
}

function executeValue(selection: GqlSelection, result: Resolved, ctx: ExecContext): unknown {
  if (result.value === null || result.value === undefined) return null;
  if (selection.kind !== 'field' || selection.selections.length === 0) return result.value;
  if (result.type.startsWith('[')) {
    const elementType = result.type.slice(1, -1);
    return (result.value as unknown[]).map((entry) => executeSelectionSet(selection.selections, entry, elementType, ctx));
  }
  return executeSelectionSet(selection.selections, result.value, result.type, ctx);
}

function fieldNames(name: string): string[] {
  return OBJECT_FIELDS[name] ?? [];
}

function resolveField(
  ctx: ExecContext,
  typeName: string,
  fieldName: string,
  parent: unknown,
  args: Map<string, unknown>,
): Resolved {
  if (fieldName === '__typename') return resolved(typeName, 'String');

  if (typeName === 'Query') {
    if (fieldName === 'viewer') return resolved({ login: ctx.store.login }, 'User');
    if (fieldName === 'repository') {
      const repo = ctx.store.getRepo(String(args.get('owner') ?? ''), String(args.get('name') ?? ''));
      return resolved(repo ?? null, 'Repository');
    }
    if (fieldName === 'node') {
      const decoded = decodeId(args.get('id'));
      if (decoded === null) return resolved(null, 'Node');
      if (decoded.type === 'Repository') return resolved(repoByGlobalId(ctx.store, decoded.id) ?? null, 'Repository');
      if (decoded.type === 'Issue') return resolved(issueByGlobalId(ctx.store, decoded.id)?.issue ?? null, 'Issue');
      if (decoded.type === 'PullRequest') return resolved(pullByGlobalId(ctx.store, decoded.id)?.pull ?? null, 'PullRequest');
      return resolved(null, 'Node');
    }
    if (fieldName === '__type') {
      const name = args.get('name');
      const known = typeof name === 'string' && (name in OBJECT_FIELDS || name in ENUM_VALUES);
      return resolved(known ? { name: String(name) } : null, '__Type');
    }
    if (fieldName === '__schema') {
      const types = [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => ({ name }));
      return resolved({ types, queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }, '__Schema');
    }
  }

  if (typeName === 'Mutation') {
    if (fieldName === 'createIssue') return createIssue(ctx, asRecord(args.get('input')));
    if (fieldName === 'closeIssue') return closeIssue(ctx, asRecord(args.get('input')));
    if (fieldName === 'addComment') return addComment(ctx, asRecord(args.get('input')));
    if (fieldName === 'createPullRequest') return createPullRequest(ctx, asRecord(args.get('input')));
    if (fieldName === 'mergePullRequest') return mergePullRequest(ctx, asRecord(args.get('input')));
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (fieldName === 'issue') return resolved(asRecord(parent).issue ?? null, 'Issue');
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (fieldName === 'pullRequest') return resolved(asRecord(parent).pullRequest ?? null, 'PullRequest');
  }
  if (typeName === 'AddCommentPayload') {
    if (fieldName === 'commentEdge') return resolved(asRecord(parent).commentEdge ?? null, 'IssueCommentEdge');
  }
  if (typeName === 'IssueCommentEdge') {
    if (fieldName === 'node') return resolved(asRecord(parent).node ?? null, 'Comment');
  }

  if (typeName === 'User') {
    const login = String(asRecord(parent).login ?? '');
    if (fieldName === 'login') return resolved(login, 'String');
    if (fieldName === 'id') return resolved(encodeId('User', login), 'ID');
    if (fieldName === 'name') return resolved(login, 'String');
    if (fieldName === 'email') return resolved('', 'String');
  }

  if (typeName === 'Repository') {
    const repo = parent as Repo;
    if (fieldName === 'id') return resolved(encodeId('Repository', repo.id), 'ID');
    if (fieldName === 'databaseId') return resolved(repo.id, 'Int');
    if (fieldName === 'name') return resolved(repo.name, 'String');
    if (fieldName === 'description') return resolved(repo.description, 'String');
    if (fieldName === 'isPrivate') return resolved(repo.private, 'Boolean');
    if (fieldName === 'nameWithOwner') return resolved(`${repo.owner}/${repo.name}`, 'String');
    if (fieldName === 'owner') return resolved({ login: repo.owner }, 'User');
    if (fieldName === 'defaultBranchRef') {
      const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
      return resolved({ name: repo.defaultBranch, target: { oid } }, 'Ref');
    }
    if (fieldName === 'viewerPermission') return resolved('ADMIN', 'RepositoryPermission');
    if (fieldName === 'hasIssuesEnabled') return resolved(true, 'Boolean');
    if (fieldName === 'issue') {
      const issue = ctx.store.findIssue(repo, Number(args.get('number')));
      return resolved(issue ?? null, 'Issue');
    }
    if (fieldName === 'issues') return resolved(issueConnection(repo, args), 'IssueConnection');
    if (fieldName === 'pullRequests') return resolved(pullConnection(repo, args), 'PullRequestConnection');
    if (fieldName === 'pullRequest') {
      const pull = ctx.store.findPull(repo, Number(args.get('number')));
      return resolved(pull ?? null, 'PullRequest');
    }
  }

  if (typeName === 'Issue') {
    const issue = parent as Issue;
    if (fieldName === 'id') return resolved(encodeId('Issue', issue.id), 'ID');
    if (fieldName === 'number') return resolved(issue.number, 'Int');
    if (fieldName === 'title') return resolved(issue.title, 'String');
    if (fieldName === 'body') return resolved(issue.body, 'String');
    if (fieldName === 'state') return resolved(issue.state === 'open' ? 'OPEN' : 'CLOSED', 'IssueState');
    if (fieldName === 'createdAt') return resolved(issue.createdAt, 'DateTime');
    if (fieldName === 'updatedAt') return resolved(issue.updatedAt, 'DateTime');
    if (fieldName === 'closedAt') return resolved(issue.closedAt, 'DateTime');
    if (fieldName === 'author') return resolved({ login: ctx.store.login }, 'User');
    if (fieldName === 'labels') return resolved({ nodes: issue.labels }, 'LabelConnection');
    if (fieldName === 'comments') return resolved({ nodes: issue.comments }, 'IssueCommentConnection');
  }

  if (typeName === 'PullRequest') {
    const pull = parent as Pull;
    if (fieldName === 'id') return resolved(encodeId('PullRequest', pull.id), 'ID');
    if (fieldName === 'number') return resolved(pull.number, 'Int');
    if (fieldName === 'title') return resolved(pull.title, 'String');
    if (fieldName === 'body') return resolved(pull.body, 'String');
    if (fieldName === 'state') return resolved(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', 'PullRequestState');
    if (fieldName === 'merged') return resolved(pull.merged, 'Boolean');
    if (fieldName === 'mergedAt') return resolved(pull.mergedAt, 'DateTime');
    if (fieldName === 'mergeable') return resolved('MERGEABLE', 'MergeableState');
    if (fieldName === 'headRefName') return resolved(pull.head, 'String');
    if (fieldName === 'baseRefName') return resolved(pull.base, 'String');
    if (fieldName === 'headRefOid') return resolved(pull.headSha, 'GitObjectID');
    if (fieldName === 'mergeCommit') {
      return resolved(pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha }, 'GitObject');
    }
    if (fieldName === 'createdAt') return resolved(pull.createdAt, 'DateTime');
    if (fieldName === 'files') {
      const files = changedFiles(ctx.store, repoForPull(ctx.store, pull), pull);
      return resolved({ nodes: files, totalCount: files.length }, 'PullRequestChangedFileConnection');
    }
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    const connection = asRecord(parent);
    if (fieldName === 'nodes') return resolved(connection.nodes ?? [], '[PullRequestChangedFile]');
    if (fieldName === 'totalCount') return resolved(connection.totalCount ?? 0, 'Int');
  }
  if (typeName === 'PullRequestChangedFile') {
    const file = asRecord(parent);
    if (fieldName === 'path') return resolved(file.path, 'String');
    if (fieldName === 'additions') return resolved(0, 'Int');
    if (fieldName === 'deletions') return resolved(0, 'Int');
  }

  if (typeName === 'Ref') {
    const ref = asRecord(parent);
    if (fieldName === 'name') return resolved(ref.name, 'String');
    if (fieldName === 'target') return resolved(ref.target ?? null, 'GitObject');
  }
  if (typeName === 'GitObject') {
    const object = asRecord(parent);
    if (fieldName === 'oid') return resolved(object.oid, 'GitObjectID');
    if (fieldName === 'abbreviatedOid') return resolved(String(object.oid ?? '').slice(0, 7), 'String');
  }

  if (typeName === 'IssueConnection') {
    const connection = asRecord(parent);
    if (fieldName === 'nodes') return resolved(connection.nodes ?? [], '[Issue]');
    if (fieldName === 'totalCount') return resolved(connection.totalCount ?? 0, 'Int');
    if (fieldName === 'pageInfo') return resolved(connection.pageInfo, 'PageInfo');
  }
  if (typeName === 'PullRequestConnection') {
    const connection = asRecord(parent);
    if (fieldName === 'nodes') return resolved(connection.nodes ?? [], '[PullRequest]');
    if (fieldName === 'totalCount') return resolved(connection.totalCount ?? 0, 'Int');
    if (fieldName === 'pageInfo') return resolved(connection.pageInfo, 'PageInfo');
  }
  if (typeName === 'PageInfo') {
    const info = asRecord(parent);
    if (fieldName === 'hasNextPage') return resolved(info.hasNextPage === true, 'Boolean');
    if (fieldName === 'hasPreviousPage') return resolved(info.hasPreviousPage === true, 'Boolean');
    if (fieldName === 'startCursor') return resolved(info.startCursor ?? null, 'String');
    if (fieldName === 'endCursor') return resolved(info.endCursor ?? null, 'String');
  }

  if (typeName === 'Comment') {
    const comment = asRecord(parent);
    if (fieldName === 'id') return resolved(encodeId('IssueComment', comment.id as number), 'ID');
    if (fieldName === 'body') return resolved(comment.body, 'String');
    if (fieldName === 'createdAt') return resolved(comment.createdAt, 'DateTime');
    if (fieldName === 'author') return resolved({ login: ctx.store.login }, 'User');
  }
  if (typeName === 'Label') {
    const label = asRecord(parent);
    if (fieldName === 'name') return resolved(label.name, 'String');
    if (fieldName === 'color') return resolved(label.color, 'String');
  }
  if (typeName === 'LabelConnection') {
    const connection = asRecord(parent);
    if (fieldName === 'nodes') return resolved(connection.nodes ?? [], '[Label]');
  }
  if (typeName === 'IssueCommentConnection') {
    const connection = asRecord(parent);
    if (fieldName === 'nodes') return resolved(connection.nodes ?? [], '[Comment]');
  }

  if (typeName === '__Type') {
    const name = String(asRecord(parent).name ?? '');
    if (fieldName === 'name') return resolved(name, 'String');
    if (fieldName === 'kind') return resolved(name in ENUM_VALUES ? 'ENUM' : 'OBJECT', '__TypeKind');
    if (fieldName === 'fields') return resolved(fieldNames(name).map((entry) => ({ name: entry })), '[__Field]');
    if (fieldName === 'enumValues') return resolved((ENUM_VALUES[name] ?? []).map((entry) => ({ name: entry })), '[__EnumValue]');
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (fieldName === 'name') return resolved(asRecord(parent).name, 'String');
  }
  if (typeName === '__Schema') {
    const schema = asRecord(parent);
    if (fieldName === 'types') return resolved(schema.types ?? [], '[__Type]');
    if (fieldName === 'queryType') return resolved(schema.queryType, '__Type');
    if (fieldName === 'mutationType') return resolved(schema.mutationType, '__Type');
  }

  throw new Error(`Field '${fieldName}' doesn't exist on type '${typeName}'`);
}

// ---------------------------------------------------------------------------------------------
// Repository reads

function issueConnection(repo: Repo, args: Map<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.get('states')) ? (args.get('states') as unknown[]).map(String) : null;
  const orderBy = asRecord(args.get('orderBy'));
  const direction = orderBy.direction === 'DESC' ? -1 : 1;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const issues = repo.issues
    .filter((issue) => (states === null ? true : states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED')))
    .slice()
    .sort((a, b) => direction * (field === 'UPDATED_AT' ? a.number - b.number : a.number - b.number));
  const page = paginate(issues, (issue) => cursorFor('Issue', issue.id), args.get('first'), args.get('after'));
  return { nodes: page.nodes, pageInfo: page.pageInfo, totalCount: issues.length };
}

function pullConnection(repo: Repo, args: Map<string, unknown>): Record<string, unknown> {
  const pulls = repo.pulls.slice().sort((a, b) => a.number - b.number);
  const page = paginate(pulls, (pull) => cursorFor('PullRequest', pull.id), args.get('first'), args.get('after'));
  return { nodes: page.nodes, pageInfo: page.pageInfo, totalCount: pulls.length };
}

function paginate<T>(
  items: T[],
  cursorOf: (item: T) => string,
  first: unknown,
  after: unknown,
): { nodes: T[]; pageInfo: Record<string, unknown> } {
  const cursors = items.map(cursorOf);
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const index = cursors.indexOf(after);
    start = index >= 0 ? index + 1 : 0;
  }
  const limit = typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : items.length;
  const end = Math.min(start + limit, items.length);
  return {
    nodes: items.slice(start, end),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: end > start ? cursors[start] : null,
      endCursor: end > start ? cursors[end - 1] : null,
    },
  };
}

function repoForPull(store: Store, pull: Pull): Repo {
  for (const repo of store.repos.values()) if (repo.pulls.includes(pull)) return repo;
  throw new Error('Pull request is not attached to a repository');
}

function treeOf(store: Store, repo: Repo, commitOid: string | undefined): Map<string, { mode: string; oid: string }> {
  if (commitOid === undefined) return new Map();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return new Map();
  return store.flattenTree(repo, parseCommit(commit.data).tree);
}

function changedFiles(store: Store, repo: Repo, pull: Pull): { path: string }[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? (pull.headSha === '' ? undefined : pull.headSha);
  const head = treeOf(store, repo, headTip);
  const base = treeOf(store, repo, baseTip);
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  const changed: { path: string }[] = [];
  for (const path of paths) {
    if (base.get(path)?.oid !== head.get(path)?.oid) changed.push({ path });
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Mutations

function createIssue(ctx: ExecContext, input: Record<string, unknown>): Resolved {
  const repo = repoByGlobalId(ctx.store, internalId(input.repositoryId));
  if (repo === undefined) throw new Error('createIssue: repository not found');
  repo.issueCounter += 1;
  const now = stamp();
  const issue: Issue = {
    id: ctx.store.nextId(),
    number: repo.issueCounter,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    labels: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.push(issue);
  repo.updatedAt = now;
  return resolved({ issue }, 'CreateIssuePayload');
}

function closeIssue(ctx: ExecContext, input: Record<string, unknown>): Resolved {
  const decoded = decodeId(input.issueId);
  const found = decoded === null ? undefined : issueByGlobalId(ctx.store, decoded.id);
  if (found === undefined) throw new Error('closeIssue: issue not found');
  const now = stamp();
  found.issue.state = 'closed';
  found.issue.closedAt = now;
  found.issue.updatedAt = now;
  return resolved({ issue: found.issue }, 'CloseIssuePayload');
}

function addComment(ctx: ExecContext, input: Record<string, unknown>): Resolved {
  const decoded = decodeId(input.subjectId);
  const found = decoded === null ? undefined : issueByGlobalId(ctx.store, decoded.id);
  if (found === undefined) throw new Error('addComment: subject not found');
  const now = stamp();
  found.repo.commentCounter += 1;
  const comment = { id: found.repo.commentCounter, body: String(input.body ?? ''), createdAt: now };
  found.issue.comments.push(comment);
  found.issue.updatedAt = now;
  return resolved({ commentEdge: { node: comment } }, 'AddCommentPayload');
}

function createPullRequest(ctx: ExecContext, input: Record<string, unknown>): Resolved {
  const repo = repoByGlobalId(ctx.store, internalId(input.repositoryId));
  if (repo === undefined) throw new Error('createPullRequest: repository not found');
  const now = stamp();
  repo.pullCounter += 1;
  const head = String(input.headRefName ?? '');
  const pull: Pull = {
    id: ctx.store.nextId(),
    number: repo.pullCounter,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    head,
    base: String(input.baseRefName ?? repo.defaultBranch),
    headSha: repo.refs.get(`refs/heads/${head}`) ?? '',
    mergeCommitSha: null,
    merged: false,
    mergedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.push(pull);
  repo.updatedAt = now;
  return resolved({ pullRequest: pull }, 'CreatePullRequestPayload');
}

function mergePullRequest(ctx: ExecContext, input: Record<string, unknown>): Resolved {
  const decoded = decodeId(input.pullRequestId);
  const found = decoded === null ? undefined : pullByGlobalId(ctx.store, decoded.id);
  if (found === undefined) throw new Error('mergePullRequest: pull request not found');
  const { repo, pull } = found;
  const baseRef = `refs/heads/${pull.base}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? (pull.headSha === '' ? undefined : pull.headSha);
  const headCommit = headTip === undefined ? undefined : repo.objects.get(headTip);
  const baseCommit = baseTip === undefined ? undefined : repo.objects.get(baseTip);
  const tree =
    headCommit !== undefined && headCommit.type === 'commit'
      ? parseCommit(headCommit.data).tree
      : baseCommit !== undefined && baseCommit.type === 'commit'
        ? parseCommit(baseCommit.data).tree
        : ctx.store.buildTree(repo, new Map());
  const now = stamp();
  const mergeSha = ctx.store.commit(repo, pull.base, `Merge pull request #${pull.number}`, tree, baseTip === undefined ? [] : [baseTip]);
  pull.mergeCommitSha = mergeSha;
  pull.merged = true;
  pull.mergedAt = now;
  pull.state = 'closed';
  pull.updatedAt = now;
  return resolved({ pullRequest: pull }, 'MergePullRequestPayload');
}

// ---------------------------------------------------------------------------------------------
// Request handling

function executeOperation(store: Store, operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { store, variables, errors: [] };
  try {
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(operation.selections, null, rootType, ctx);
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  } catch (error) {
    return { data: null, errors: [{ message: String(error instanceof Error ? error.message : error) }] };
  }
}

function runOperation(store: Store, item: unknown): Record<string, unknown> {
  try {
    if (item === null || typeof item !== 'object') return { data: null, errors: [{ message: 'Each operation must be an object' }] };
    const record = item as Record<string, unknown>;
    if (typeof record.query !== 'string') return { data: null, errors: [{ message: 'query must be a string' }] };
    const operations = new GqlParser(lex(record.query)).parseDocument();
    let operation: GqlOperation | undefined = operations[0];
    if (typeof record.operationName === 'string') {
      const named = operations.find((entry) => entry.name === record.operationName);
      if (named !== undefined) operation = named;
    }
    if (operation === undefined) throw new Error('No operation in document');
    const variables = asRecord(record.variables);
    return executeOperation(store, operation, variables);
  } catch (error) {
    return { data: null, errors: [{ message: String(error instanceof Error ? error.message : error) }] };
  }
}

/**
 * Execute a GraphQL v4 request body against the forge store.
 *
 * @param store - The shared forge store; reads and mutations must stay consistent with REST.
 * @param rawBody - The raw HTTP body, which may be invalid JSON or a JSON array of operations.
 * @param authenticated - Whether the request carried a valid token.
 * @returns The HTTP status and JSON-serializable body; never throws.
 */
export async function handleGraphQL(
  store: Store,
  rawBody: string,
  authenticated: boolean,
): Promise<{ status: number; body: unknown }> {
  try {
    if (!authenticated) return { status: 401, body: { message: 'Requires authentication' } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { message: 'Problems parsing JSON' } };
    }
    if (Array.isArray(parsed)) {
      return { status: 200, body: parsed.map((item) => runOperation(store, item)) };
    }
    return { status: 200, body: runOperation(store, parsed) };
  } catch (error) {
    return { status: 200, body: { data: null, errors: [{ message: String(error instanceof Error ? error.message : error) }] } };
  }
}
