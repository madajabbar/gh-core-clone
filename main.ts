// Entry-side half of the entry <-> env handshake. The env owns the loop; this process only announces
// which ephemeral port it bound and then waits to be told the trial is over.
//
//   1. MAKEFUN_ENV_URL names the env origin. Unset means there is nobody to talk to -> exit 1.
//   2. createApp() then listen(0): the kernel picks a free port. Never bind 8080; the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N} until 200 or 409. 409 = a first register already won.
//   4. GET $MAKEFUN_ENV_URL/done until {"done":true}. No exit before that.
//   5. close() and exit 0; the harness stops the env, which writes the scored export.
//
// Imports: the app factory from './app.ts' and nothing else.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000; // per-attempt cap for register / done
const RETRY_BASE_MS = 250; // first backoff step
const RETRY_CAP_MS = 2_000; // longest backoff step

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `attempt` failures: RETRY_BASE_MS doubled, capped at RETRY_CAP_MS. */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 8));
}

/** A status that means the env understood /register; anything else is retried or fatal. */
function registered(status: number): boolean {
  return status === 200 || status === 409;
}

/** A status that proves the caller-side protocol is wrong, so retrying cannot help. */
function fatalStatus(status: number): boolean {
  return status === 400 || status === 405;
}

/** Raised by an accept callback to end the process instead of retrying. */
class ProtocolError extends Error {}

/**
 * Repeatedly issue one request against the env until `accept` returns true. A network failure or a
 * per-attempt timeout is "the env is not ready yet" and is retried with backoff; a ProtocolError from
 * `accept` is fatal and escapes.
 */
async function poll(url: string, init: RequestInit, accept: (res: Response) => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (await accept(res)) return;
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
    }
    await sleep(backoffMs(attempt));
  }
}

/** POST the bound port to /register until the env accepts it (200) or a first entry already won (409). */
async function register(port: number): Promise<void> {
  await poll(
    `${envUrl}/register`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    },
    async (res) => {
      if (registered(res.status)) return true;
      if (fatalStatus(res.status)) {
        throw new ProtocolError(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      return false;
    },
  );
}

/** Poll /done until the body says {"done":true}. Never returns before that. */
async function waitForDone(): Promise<void> {
  await poll(`${envUrl}/done`, {}, async (res) => {
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  });
}

/** Bind an ephemeral TCP port and return it. Never bind 8080: the env owns that port. */
async function bindEphemeralPort(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server, port: address.port };
}

/** The whole life of the process: bind, register, wait for done, close. */
async function main(): Promise<void> {
  const { server, port } = await bindEphemeralPort();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
