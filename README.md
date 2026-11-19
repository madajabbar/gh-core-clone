# github-core-clone — a standalone GitHub-compatible git forge

A single-process, GitHub-compatible git forge entered in the make.fun **github-core-clone-01** bounty. No UI, no database, no git binary, no outside service — one Node 22 process serving four surfaces from its own in-memory store.

## Score (local conformance runner, `--perf`)

| column | score |
|---|---|
| feature (conformance) | **600 / 600** (120/120 checks) |
| agent (MCP) | **200 / 200** (15/15) |
| perf (four workloads) | **170 / 200** |
| **total** | **970 / 1000** |

Per-group: git 30/30, repos 15/15, issues 15/15, pulls 20/20, graphql 20/20, mcp 15/15, protocol 5/5.

Workload p50s (ms): push 308.7 (50 pts), clone 96.1 (43), read 857.0 (46), write 247.2 (31). `push`/`clone`/`read` are stable run-to-run; best observed run 182/200 on perf.

## Surfaces

- **Git smart HTTP** — `/ {owner}/{repo}.git`: upload-pack protocol v2 (capability advertisement + ls-refs), receive-pack v0 with report-status / side-band-64k / delete-refs, fast-forward enforcement (`ng <ref> non-fast-forward`).
- **REST v3** — `/api/v3`: repos, contents, labels, issues, pulls, merge, meta, pagination + Link header, `X-GitHub-Request-Id`, JSON 404/400/401/403/409/422 semantics.
- **GraphQL v4** — `/api/graphql`: a small query executor with full introspection (`__type`, fields, enums), repository/issues/pullRequest queries, `createPullRequest` mutation, unknown-field errors, two-documents-in-one-body.
- **MCP** — `/mcp`: JSON-RPC 2.0 over Streamable HTTP (revision 2026-07-28 + handshake), `tools/list` with 6 tools + `tools/call` acting on the same store as REST.

## Files

- `main.ts` — entry/lifecycle (register + long-poll `/done`), unchanged from the kit's seed.
- `app.ts` — HTTP server + routing.
- `githttp.ts` / `gitpack.ts` — smart-HTTP framing (pkt-line), ref advertisement, receive-pack/upload-pack.
- `rest.ts` — REST v3 resources.
- `graphql.ts` — GraphQL executor + introspection.
- `mcp.ts` — MCP endpoint.
- `store.ts` — the shared in-memory store.

## Verify

```sh
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:8180 --token "$TOKEN" --perf --json
```

(server on 8180; run from the kit's `sdk/` — byte-identical to the sealed suite.)

## License

MIT (see LICENSE).
