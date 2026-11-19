// Git object / pkt-line / packfile primitives. Pure node:zlib + node:crypto.
// Written from scratch for the clone; no git binary, no dependencies.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 of `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}

/** Wrap a loose object (header + content). */
export function looseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from(`${type} ${body.length}\u0000`, 'utf8'), body]);
}

// ------------------------------------------------------------------ pkt-line

/** Encode one pkt-line data packet (`line` may or may not end in `\n`). */
export function pktLine(line: string | Buffer): Buffer {
  const payload = Buffer.isBuffer(line) ? line : Buffer.from(line, 'utf8');
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export function encodePktLines(parts: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(PKT_FLUSH);
    else if (part === 'delim') out.push(PKT_DELIM);
    else if (part === 'response-end') out.push(PKT_RESPONSE_END);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/** Decode a pkt-line stream into data payloads; controls are discarded. */
export function decodePktLines(body: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const hex = body.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    off += 4;
    if (!Number.isFinite(len) || len === 0) continue;
    if (len === 1 || len === 2) continue;
    if (off + len - 4 > body.length) break;
    out.push(body.subarray(off, off + len - 4));
    off += len - 4;
  }
  return out;
}

// ------------------------------------------------------------------ pack decode

function readSizeVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { value: number; next: number } {
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { value, next: off };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const b = Buffer.from(base);
  const d = Buffer.from(delta);
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = d[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize(); // source size
  const target = readSize();
  const out = Buffer.alloc(target);
  let at = 0;
  while (off < d.length) {
    const op = d[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff |= d[off++];
      if (op & 0x02) cpOff |= d[off++] << 8;
      if (op & 0x04) cpOff |= d[off++] << 16;
      if (op & 0x08) cpOff |= d[off++] << 24;
      if (op & 0x10) cpSize |= d[off++];
      if (op & 0x20) cpSize |= d[off++] << 8;
      if (op & 0x40) cpSize |= d[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      b.copy(out, at, cpOff, cpOff + cpSize);
      at += cpSize;
    } else if (op) {
      d.copy(out, at, off, off + op);
      at += op;
      off += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  return out;
}

/** Decode a pack into objects keyed by recomputed sha. Handles ofs/ref deltas. */
export function decodePack(pack: Uint8Array, external?: Map<string, GitObject>): Map<string, GitObject> {
  const buf = Buffer.from(pack);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: Buffer;
    resolvedType?: GitObjectType;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const header = readSizeVarint(buf, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buf, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.value;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateAt(buf, off);
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const CODE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset!);
      if (!base) throw new Error('ofs-delta base missing');
      const r = resolve(base);
      type = r.type;
      data = applyDelta(r.data, entry.data);
    } else if (entry.typeCode === 7) {
      const local = byOid.get(entry.baseOid!);
      if (local) {
        const r = resolve(local);
        type = r.type;
        data = applyDelta(r.data, entry.data);
      } else {
        const ext = external?.get(entry.baseOid!);
        if (!ext) throw new Error('ref-delta base missing');
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    byOid.set(oid, entry);
    objects.set(oid, { type, data });
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) resolve(entry);
  return objects;
}

// ------------------------------------------------------------------ pack encode

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function encodeEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = TYPE_CODE[type] << 4;
  let byte = first | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** Build a v2 pack of loose (undeltified) objects in the given order. */
export function encodePack(entries: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    parts.push(encodeEntryHeader(entry.type, entry.data.length));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

// ------------------------------------------------------------------ object views

export function parseTree(data: Uint8Array): Array<{ mode: string; name: string; oid: string }> {
  const buf = Buffer.from(data);
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let off = 0;
  while (off < buf.length) {
    const space = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0x00, space + 1);
    const mode = buf.subarray(off, space).toString('ascii');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitFields {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitFields {
  const text = Buffer.from(data).toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  const fields: CommitFields = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) fields.tree = line.slice(5);
    else if (line.startsWith('parent ')) fields.parents.push(line.slice(7));
    else if (line.startsWith('author ')) fields.author = line.slice(7);
    else if (line.startsWith('committer ')) fields.committer = line.slice(10);
  }
  return fields;
}

export function buildCommit(o: CommitFields): Buffer {
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents) lines.push(`parent ${p}`);
  lines.push(`author ${o.author}`, `committer ${o.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

/** Build an annotated tag object. */
export function buildTag(o: { object: string; type: GitObjectType; tag: string; tagger: string; message: string }): Buffer {
  const head = [`object ${o.object}`, `type ${o.type}`, `tag ${o.tag}`, `tagger ${o.tagger}`, ''].join('\n');
  return Buffer.from(`${head}${o.message}`, 'utf8');
}

/** `refs/heads/...` etc. that a clone treats as a branch. */
export function isBranchRef(ref: string): boolean {
  return ref.startsWith('refs/heads/');
}
