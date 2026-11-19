// The in-memory forge: one deterministic store behind every surface.
//
// Nothing here reads the clock or a random source: ids and timestamps advance through fixed
// counters so two runs of the same process export byte-identical state.

import { buildCommit, hashObject, parseCommit, parseTree, type GitObject, type GitObjectType } from './gitpack.ts';

/** The single owner every repository belongs to. The conformance scenario's viewer login. */
export const VIEWER_LOGIN = 'adaiversen';

const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);
const EPOCH_S = Math.floor(EPOCH_MS / 1000);

let clockTick = 0;
/** The next deterministic instant as an ISO string (no `.000`). */
function nextIso(): string {
  clockTick += 1;
  return new Date(EPOCH_MS + clockTick * 1000).toISOString().replace('.000Z', 'Z');
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  mergeCommitSha: string | null;
  merged: boolean;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  issueCounter: number;
  pullCounter: number;
  commentCounter: number;
}

export interface FileChange {
  /** Repository-relative path. */
  path: string;
  /** Blob object id, or null to delete the path. */
  oid: string | null;
  mode?: string;
}

export class Store {
  readonly login = VIEWER_LOGIN;
  readonly repos = new Map<string, Repo>();
  #nextId = 0;

  nextId(): number {
    this.#nextId += 1;
    return this.#nextId;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.login) return undefined;
    return this.repos.get(name);
  }

  /** Every repository owned by `owner`, name-sorted for a stable list. */
  listRepos(owner: string): Repo[] {
    if (owner !== this.login) return [];
    return [...this.repos.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  createRepo(name: string, options: { description?: string; private?: boolean } = {}): Repo {
    const now = nextIso();
    const repo: Repo = {
      id: this.nextId(),
      owner: this.login,
      name,
      description: options.description ?? '',
      private: options.private !== false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      issueCounter: 0,
      pullCounter: 0,
      commentCounter: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.login) return false;
    return this.repos.delete(name);
  }

  putObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    return oid;
  }

  putBlob(repo: Repo, content: Uint8Array): string {
    return this.putObject(repo, { type: 'blob', data: Buffer.from(content) });
  }

  /** Every path reachable from `treeOid`, flattened to `path -> {mode, oid}`. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Write nested trees for a flat path map and return the root tree id. */
  buildTree(repo: Repo, entries: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, value] of entries) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1] as string, value);
    }
    const write = (node: Node): string => {
      const items: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, value] of node.files) items.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) items.push({ mode: '40000', name, oid: write(child) });
      items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const data = Buffer.concat(
        items.map((item) => Buffer.concat([Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'), Buffer.from(item.oid, 'hex')])),
      );
      return this.putObject(repo, { type: 'tree', data });
    };
    return write(root);
  }

  /** Apply file changes on top of `baseTree` (or an empty tree) and write the resulting tree. */
  treeWithChanges(repo: Repo, baseTree: string | null, changes: FileChange[]): string {
    const entries = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    for (const change of changes) {
      if (change.oid === null) entries.delete(change.path);
      else entries.set(change.path, { mode: change.mode ?? '100644', oid: change.oid });
    }
    return this.buildTree(repo, entries);
  }

  /** Create a commit on `branch`. Returns the commit id. */
  commit(repo: Repo, branch: string, message: string, tree: string, parents: string[]): string {
    const when = nextIso();
    const stamp = `${EPOCH_S + clockTick} +0000`;
    clockTick += 1;
    const data = buildCommit({
      tree,
      parents,
      author: `${this.login} <${this.login}@users.noreply.github.com>`,
      committer: `${this.login} <${this.login}@users.noreply.github.com>`,
      message,
      authorDate: stamp,
      committerDate: stamp,
    });
    const oid = this.putObject(repo, { type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedAt = when;
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** The commit history of a branch, newest first. */
  log(repo: Repo, tip: string | undefined): Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> {
    const out: Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> = [];
    const seen = new Set<string>();
    let cursor = tip;
    while (cursor !== undefined && !seen.has(cursor) && out.length < 10_000) {
      seen.add(cursor);
      const object = repo.objects.get(cursor);
      if (object === undefined || object.type !== 'commit') break;
      const commit = parseCommit(object.data);
      out.push({ sha: cursor, commit });
      cursor = commit.parents[0];
    }
    return out;
  }

  /** Every blob data reachable from a commit (for the pull-request file diff). */
  blobSet(repo: Repo, commitOid: string | undefined): Map<string, string> {
    if (commitOid === undefined) return new Map();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    const fields = parseCommit(commit.data);
    const flat = this.flattenTree(repo, fields.tree);
    const out = new Map<string, string>();
    for (const [path, entry] of flat) out.set(path, entry.oid);
    return out;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }
}

export function createStore(): Store {
  return new Store();
}

/** Object type of a stored id, or undefined. */
export function objectType(repo: Repo, oid: string): GitObjectType | undefined {
  return repo.objects.get(oid)?.type;
}
