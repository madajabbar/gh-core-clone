// Git smart HTTP: upload-pack (ls-refs + fetch, protocol v2 and v0) and receive-pack.
//
// Everything answers from the in-memory store. The packfile writer in `gitpack.ts` emits
// undeltified entries, which git clients accept; pushes we receive may carry deltas and are
// resolved against the objects the repository already holds.

import { type IncomingHttpHeaders } from 'node:http';
import {
  decodePack,
  encodePack,
  encodePktLines,
  parseCommit,
  parseTree,
  pktLine,
  type GitObject,
  type GitObjectType,
} from './gitpack.ts';
import { type Repo, type Store } from './store.ts';

const ZERO_OID = '0'.repeat(40);
/** A pkt-line length field is four hex digits, so 0xffff is the ceiling for payload + 4. */
const PKT_LINE_MAX = 0xffff;
/** Largest band-1 chunk we emit, leaving room for the 4-byte length and the band byte. */
const SIDEBAND_CHUNK = 60_000;
const AGENT = 'forge/1.0';

export interface GitHttpRequest {
  owner: string;
  repo: string;
  /** Path after `/{owner}/{repo}.git`, e.g. `/info/refs` or `/git-upload-pack`. */
  path: string;
  method: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
  authenticated: boolean;
}

export interface GitHttpReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonReply(status: number, message: string): GitHttpReply {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
  };
}

/**
 * Strict pkt-line reader. Unlike `gitpack.decodePktLines` it rejects a malformed length field
 * instead of silently skipping, so a bad request body becomes HTTP 400 rather than an empty
 * command list.
 *
 * @param body Raw request bytes.
 * @param stopAtFlush Stop at (and consume) the first flush packet; the returned `offset` is then
 *   where any trailing payload such as a packfile begins.
 * @returns The data payloads and the byte offset reached.
 */
function readPktLines(body: Buffer, stopAtFlush: boolean): { payloads: Buffer[]; offset: number } {
  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) {
      if (stopAtFlush) return { payloads, offset };
      continue;
    }
    if (length === 1 || length === 2) {
      // delim / response-end: framing only.
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    const end = offset + length - 4;
    if (end > body.length) throw new Error('truncated pkt-line payload');
    payloads.push(body.subarray(offset, end));
    offset = end;
  }
  return { payloads, offset };
}

/** The object ids a stored object directly references. */
function referenced(repo: Repo, oid: string): string[] {
  const object = repo.objects.get(oid);
  if (object === undefined) return [];
  if (object.type === 'commit') {
    const fields = parseCommit(object.data);
    return [fields.tree, ...fields.parents];
  }
  if (object.type === 'tree') {
    // Gitlinks name a commit in another repository; it is not part of this object graph.
    return parseTree(object.data)
      .filter((entry) => entry.mode !== '160000')
      .map((entry) => entry.oid);
  }
  if (object.type === 'tag') {
    const target = tagTarget(object.data);
    return target === null ? [] : [target];
  }
  return [];
}

function tagTarget(data: Buffer): string | null {
  const first = data.toString('utf8', 0, Math.min(data.length, 200)).split('\n', 1)[0] ?? '';
  return first.startsWith('object ') ? first.slice('object '.length).trim() : null;
}

/** Everything reachable from `roots`, optionally not following parents of `parentStop` commits. */
function closure(repo: Repo, roots: readonly string[], parentStop?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    let next = referenced(repo, oid);
    if (object.type === 'commit' && parentStop?.has(oid)) next = next.slice(0, 1);
    stack.push(...next);
  }
  return seen;
}

/**
 * Walk `wants` limiting commit parents to `depth` generations, plus the tree/blob closure of each
 * commit reached. Commits at the limit are reported as shallow boundaries.
 *
 * @param clientShallow Boundaries the client already holds; traversing past one unshallows it.
 */
function shallowWalk(
  repo: Repo,
  wants: readonly string[],
  depth: number | null,
  clientShallow: ReadonlySet<string>,
): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  const objects = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const bestGeneration = new Map<string, number>();
  const treeWalked = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    if (repo.objects.get(want)?.type === 'commit') queue.push([want, 1]);
    else for (const oid of closure(repo, [want])) objects.add(oid);
  }
  while (queue.length > 0) {
    const [oid, generation] = queue.shift() as [string, number];
    const seen = bestGeneration.get(oid);
    if (seen !== undefined && seen <= generation) continue;
    bestGeneration.set(oid, generation);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    objects.add(oid);
    const fields = parseCommit(object.data);
    if (!treeWalked.has(fields.tree)) {
      treeWalked.add(fields.tree);
      for (const treeOid of closure(repo, [fields.tree])) objects.add(treeOid);
    }
    if (depth !== null && generation >= depth) {
      shallow.add(oid);
      continue;
    }
    if (clientShallow.has(oid)) unshallow.add(oid);
    for (const parent of fields.parents) queue.push([parent, generation + 1]);
  }
  return { objects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

/** Object ids to send for a fetch: the wanted closure minus everything the haves already cover. */
function selectObjects(repo: Repo, wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | null): {
  entries: Array<{ type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
} {
  const walk = shallowWalk(repo, wants, depth, new Set(shallow));
  const held = closure(repo, haves, new Set(shallow));
  const wanted = [...walk.objects].filter((oid) => !held.has(oid)).sort();
  const entries: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const oid of wanted) {
    const object = repo.objects.get(oid);
    if (object !== undefined) entries.push({ type: object.type, data: object.data });
  }
  return { entries, shallow: walk.shallow, unshallow: walk.unshallow };
}

/** Tag objects advertise a `^{}` peel line naming the commit or object they wrap. */
function peel(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return tagTarget(object.data);
}

function refLinesV0(repo: Repo, capabilities: string): Buffer {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const head = repo.refs.get(headTarget);
  const lines: Array<string | 'flush'> = [];
  const names = [...repo.refs.keys()].sort();
  const refEntries: string[] = [];
  if (head !== undefined) refEntries.push(`${head} HEAD`);
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    refEntries.push(`${oid} ${name}`);
    const peeled = peel(repo, oid);
    if (peeled !== null) refEntries.push(`${peeled} ${name}^{}`);
  }
  if (refEntries.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
  } else {
    refEntries.forEach((entry, index) => {
      lines.push(index === 0 ? `${entry}\u0000${capabilities}\n` : `${entry}\n`);
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function advertise(repo: Repo, service: string, version2: boolean): Buffer {
  // v2 advertises one capability per line; v0 packs them into the first ref line after a NUL.
  const uploadCaps = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', `agent=${AGENT}`];
  const receiveCaps = [
    'report-status',
    'delete-refs',
    'side-band-64k',
    'ofs-delta',
    'object-format=sha1',
    'symref=HEAD:refs/heads/main',
    `agent=${AGENT}`,
  ];
  if (version2) return encodePktLines(['version 2\n', ...uploadCaps.map((cap) => `${cap}\n`), 'flush']);
  const capsules = (service === 'git-upload-pack' ? uploadCaps : receiveCaps).join(' ');
  return Buffer.concat([encodePktLines([`# service=${service}\n`, 'flush']), refLinesV0(repo, capsules)]);
}

function lsRefs(repo: Repo, payloads: readonly Buffer[]): Buffer {
  const lines = payloads.map((payload) => payload.toString('utf8').replace(/\n$/, ''));
  const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const out: Array<string | 'flush'> = [];
  if (keep('HEAD')) {
    const tip = repo.refs.get(headTarget);
    if (tip !== undefined) out.push(`${tip} HEAD symref-target:${headTarget}\n`);
    else if (lines.includes('unborn')) out.push(`unborn HEAD symref-target:${headTarget}\n`);
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    const peeled = peel(repo, oid);
    if (peeled !== null) line += ` peeled:${peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return encodePktLines(out);
}

/** Framed with `side-band-64k`: each outer packet is `[1, ...pack]`, closed by a flush. */
function sideband(pack: Buffer): Buffer {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  packets.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(packets);
}

function fetchV2(repo: Repo, payloads: readonly Buffer[]): Buffer {
  const lines = payloads.map((payload) => payload.toString('utf8').replace(/\n$/, ''));
  const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim());
  const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  const shallow = lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim());
  const deepen = lines.find((line) => line.startsWith('deepen '));
  const depth = deepen === undefined ? null : Number.parseInt(deepen.slice(7).trim(), 10);
  const selected = selectObjects(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null);
  const parts: Buffer[] = [];
  if (selected.shallow.length > 0 || selected.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selected.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selected.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(encodePack(selected.entries)));
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, payloads: readonly Buffer[]): Buffer {
  const lines = payloads.map((payload) => payload.toString('utf8').replace(/\n$/, ''));
  const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim().split(' ')[0] as string);
  const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  const shallow = lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim());
  const deepen = lines.find((line) => line.startsWith('deepen '));
  const depth = deepen === undefined ? null : Number.parseInt(deepen.slice(7).trim(), 10);
  const selected = selectObjects(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null);
  const parts: Buffer[] = [];
  for (const oid of selected.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selected.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sideband(encodePack(selected.entries)));
  return Buffer.concat(parts);
}

function uploadPack(repo: Repo, body: Buffer): Buffer {
  const { payloads } = readPktLines(body, false);
  const command = payloads[0]?.toString('utf8').replace(/\n$/, '') ?? '';
  if (command === 'command=ls-refs') {
    const args = payloads.slice(1).filter((payload) => !payload.toString('utf8').startsWith('agent='));
    return lsRefs(repo, args);
  }
  return fetchV2(repo, payloads);
}

/** Is `descendant` reachable from `ancestor` by walking parents? A commit is its own descendant. */
function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

function receivePack(repo: Repo, body: Buffer): { body: Buffer; ok: boolean } {
  const { payloads, offset } = readPktLines(body, true);
  if (payloads.length === 0) return { body: report(['unpack error: no commands'], []), ok: false };
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const payload of payloads) {
    const line = payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const fields = (nul >= 0 ? line.slice(0, nul) : line).split(' ');
    if (fields.length < 3) return { body: report(['unpack error: malformed command'], []), ok: false };
    commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields.slice(2).join(' ') });
  }

  let unpack = 'unpack ok';
  const pack = body.subarray(offset);
  if (pack.length > 0) {
    try {
      const objects: Map<string, GitObject> = decodePack(pack, repo.objects);
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unpack failed';
      unpack = `unpack ${reason}`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    const existing = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      repo.refs.delete(ref);
      results.push({ ref, ok: true, reason: '' });
      continue;
    }
    if (oldOid === ZERO_OID) {
      if (existing !== undefined) {
        results.push({ ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else if (existing === undefined || existing !== oldOid) {
      results.push({ ref, ok: false, reason: 'non-fast-forward' });
      continue;
    } else if (!isDescendant(repo, newOid, existing)) {
      results.push({ ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(ref, newOid);
    results.push({ ref, ok: true, reason: '' });
  }
  return { body: report([unpack], results), ok: true };
}

/** Pack each ref result and the `unpack` line into a side-band-64k pkt-line report. */
function report(unpackLines: readonly string[], results: ReadonlyArray<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const inner: Array<string | 'flush'> = [];
  for (const line of unpackLines) inner.push(`${line}\n`);
  for (const result of results) inner.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  inner.push('flush');
  return sideband(encodePktLines(inner));
}

/**
 * Answer one git smart HTTP request.
 *
 * @param store The shared forge store.
 * @param request Parsed request; `path` is the suffix after `/{owner}/{repo}.git`.
 * @returns The HTTP reply, or `null` when the path is not a git service route.
 */
export function handleGitHttp(store: Store, request: GitHttpRequest): GitHttpReply | null {
  const service =
    request.path === '/git-upload-pack' || (request.path === '/info/refs' && request.query.get('service') === 'git-upload-pack')
      ? 'git-upload-pack'
      : request.path === '/git-receive-pack' || (request.path === '/info/refs' && request.query.get('service') === 'git-receive-pack')
        ? 'git-receive-pack'
        : null;
  if (service === null) return null;
  if (!request.authenticated) return jsonReply(401, 'Requires authentication');
  const repo = store.getRepo(request.owner, request.repo);
  if (repo === undefined) return jsonReply(404, 'Not Found');

  if (request.path === '/info/refs') {
    const wantsV2 = request.headers['git-protocol']?.toString().includes('version=2') === true;
    const version2 = service === 'git-upload-pack' && wantsV2;
    return {
      status: 200,
      contentType: `application/x-${service}-advertisement`,
      body: advertise(repo, service, version2),
    };
  }

  try {
    const result = service === 'git-upload-pack' ? uploadPack(repo, request.body) : receivePack(repo, request.body).body;
    return { status: 200, contentType: `application/x-${service}-result`, body: result };
  } catch {
    return jsonReply(400, 'Bad Request');
  }
}
