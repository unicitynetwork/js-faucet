/**
 * Helper: locate, probe, and invoke the `sphere-cli` binary against a
 * live host-manager.
 *
 * sphere-cli lives in its own repo (github.com/unicity-sphere/sphere-cli).
 * This helper resolves the binary at runtime via `SPHERE_CLI_BIN`
 * (default: `/home/vrogojin/sphere-cli-work/sphere-cli/bin/sphere.mjs`).
 * The probe runs `sphere --help` with a 10s budget and reports the exit
 * code + stderr so an upstream regression can be diagnosed without
 * reading container logs.
 *
 * Tests use `probeSphereCli()` once in `beforeAll` and gate the suite
 * with `describe.skipIf(!probe.ok)` if sphere-cli isn't runnable.
 */

import { spawnSync, spawn, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Default CLI path for local-developer ergonomics. Points at one
 * specific user's filesystem layout; non-default environments MUST
 * set `SPHERE_CLI_BIN`. On CI the default is rejected — we'd rather
 * a CI run fail loud with "set SPHERE_CLI_BIN" than silently skip
 * every HMA test because the path doesn't exist on the runner
 * (which would create a false-confidence "tests passed but skipped"
 * signal). See architectural review finding #1.
 */
const DEVELOPER_FALLBACK_CLI_PATH = '/home/vrogojin/sphere-cli-work/sphere-cli/bin/sphere.mjs';

/**
 * Detect a CI runner across the common providers our team uses:
 *   - GitHub Actions / GitLab CI / CircleCI / Travis / Buildkite: `CI=true`
 *   - Drone CI / local fakes: `CI=1`
 *   - Azure Pipelines: `TF_BUILD=True` (often without `CI` set)
 *
 * Falsy idioms (explicit "off") are honoured: empty string, `0`,
 * `false`, `False`, `no` (case-insensitive) all mean "not on CI." Any
 * other non-empty value enables CI mode.
 *
 * Other CI providers (Jenkins via JENKINS_HOME, Bamboo via
 * BAMBOO_BUILDNUMBER, etc.) are NOT covered. If we add a CI provider
 * that doesn't set CI / TF_BUILD, extend this function rather than
 * re-implementing the check inline.
 */
export function isCi(): boolean {
  const isTruthy = (raw: string | undefined): boolean => {
    if (raw === undefined) return false;
    const v = raw.trim();
    if (v === '') return false;
    const lower = v.toLowerCase();
    // Cover the common "set but disabled" idioms across npm,
    // shell-script convention, and most config systems.
    if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false;
    return true;
  };
  if (isTruthy(process.env['CI'])) return true;
  if (isTruthy(process.env['TF_BUILD'])) return true;
  return false;
}

export type SphereCliProbe =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function probeSphereCli(): SphereCliProbe {
  const explicit = process.env['SPHERE_CLI_BIN']?.trim();
  // CI runners must opt in explicitly. A missing env var on CI is a
  // configuration bug, not a "skip silently" condition.
  if (!explicit && isCi()) {
    return {
      ok: false,
      reason: 'SPHERE_CLI_BIN is unset on a CI runner. ' +
        'Set SPHERE_CLI_BIN to the path of a built sphere-cli binary ' +
        '(`bin/sphere.mjs` from github.com/unicity-sphere/sphere-cli).',
    };
  }
  const cliPath = explicit || DEVELOPER_FALLBACK_CLI_PATH;
  if (!existsSync(cliPath)) {
    return {
      ok: false,
      reason: explicit
        ? `SPHERE_CLI_BIN points at ${cliPath} which does not exist.`
        : `sphere-cli binary not found at developer fallback ${cliPath}. ` +
          `Set SPHERE_CLI_BIN, or build sphere-cli ` +
          `(github.com/unicity-sphere/sphere-cli).`,
    };
  }
  const r = spawnSync('node', [cliPath, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  if (r.error) {
    return { ok: false, reason: `sphere-cli launch error: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const stderr = (r.stderr || '').slice(0, 500).trim();
    return {
      ok: false,
      reason: `sphere-cli --help exited ${r.status}. stderr: ${stderr || '(empty)'}`,
    };
  }
  return { ok: true, path: cliPath };
}

/**
 * Create an isolated CWD with a pre-seeded `.sphere-cli/config.json`.
 * sphere-cli reads its config relative to cwd, so spawning the CLI with
 * `cwd: home` isolates each test's wallet directory.
 *
 * Caller MUST eventually `rmSync(home, { recursive: true })` — the
 * wallet contains a testnet mnemonic; leaving it on disk after the run
 * is a leak even on testnet.
 */
export function createSphereCliEnv(label: string): { home: string } {
  const safeLabel = label.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 24);
  // mkdtempSync calls mkdtemp(3), which is mandated by POSIX to
  // create the directory with mode 0700 (umask is irrelevant). On
  // Linux/macOS this is reliable. The chmodSync below is paranoia
  // for non-POSIX platforms (Windows) where Node's mkdtempSync
  // emulation may use the native CreateDirectory call which respects
  // an inherited DACL rather than POSIX mode bits. Redundant but
  // cheap on POSIX.
  const home = mkdtempSync(join(tmpdir(), `trader-e2e-sphere-${safeLabel}-`));
  // IMPORTANT: nothing must be written to `home` between mkdtempSync
  // and this chmodSync. If a future contributor adds a writeFileSync
  // here, a non-POSIX platform's brief world-readable window would
  // become a TOCTOU disclosure of whatever was just written.
  chmodSync(home, 0o700);
  const cfgDir = join(home, '.sphere-cli');
  // Explicit 0o700 — mkdirSync with `recursive: true` honours umask
  // (typically 0o022 → mode 0o755), which is too permissive for a
  // directory holding a testnet mnemonic.
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      network: 'testnet',
      dataDir: cfgDir,
      tokensDir: join(cfgDir, 'tokens'),
    }),
    'utf8',
  );
  return { home };
}

export interface SphereRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Invoke the sphere CLI with `cwd` set to a SphereCliEnv home so the
 * wallet/config directory is isolated. Returns stdout/stderr/status.
 *
 * Non-zero exit codes are NORMAL for sphere-cli (e.g. timeout, hm.error
 * response, manager rejected). Caller decides whether to assert or
 * inspect.
 *
 * `extraEnv` overlays on top of the minimal env we forward. The default
 * is intentionally minimal (PATH + UNICITY_API_KEY if set) — we don't
 * leak the parent's env into the CLI's logs.
 */
function buildEnv(opts?: { extraEnv?: Record<string, string> }, cwd?: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? cwd ?? '/',
    ...(process.env['UNICITY_API_KEY'] ? { UNICITY_API_KEY: process.env['UNICITY_API_KEY'] } : {}),
    CI: '1',
    FORCE_COLOR: '0',
    ...(opts?.extraEnv ?? {}),
  };
}

export function runSphere(
  cliPath: string,
  cwd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; extraEnv?: Record<string, string> },
): SphereRunResult {
  const r: SpawnSyncReturns<string> = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? 180_000,
    killSignal: 'SIGKILL',
    env: buildEnv(opts, cwd),
  });
  return {
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    status: r.status,
    signal: r.signal,
  };
}

/**
 * Async variant of `runSphere`. Use this when callers want true
 * parallelism (e.g., stopping N tenants concurrently in `afterAll`
 * via `Promise.all`/`Promise.allSettled`). The sync `runSphere`
 * blocks the event loop, so a `.map(runSphere)` followed by
 * `Promise.allSettled` actually runs sequentially — no parallelism.
 *
 * Mirrors `runSphere`'s contract: non-zero exit codes are returned
 * (not thrown); only subprocess launch failures reject the promise.
 *
 * Output bounded by `MAX_BUFFER_BYTES` PER STREAM (10 MiB stdout +
 * 10 MiB stderr = 20 MiB worst case before overflow fires). Async
 * `child_process.spawn` has no maxBuffer (spawnSync does), so a
 * misbehaving subprocess flooding stdout could OOM the test process.
 * On overflow we kill the child and reject with a descriptive error.
 */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export function runSphereAsync(
  cliPath: string,
  cwd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; extraEnv?: Record<string, string> },
): Promise<SphereRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cliPath, ...args], {
      cwd,
      env: buildEnv(opts, cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    const checkOverflow = (which: 'stdout' | 'stderr', total: number): boolean => {
      if (overflowed) return true;
      if (total > MAX_BUFFER_BYTES) {
        overflowed = true;
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        reject(new Error(
          `runSphereAsync: ${which} exceeded MAX_BUFFER_BYTES=${MAX_BUFFER_BYTES} ` +
          `(${total} bytes). Killed child to bound memory; partial output discarded.`,
        ));
        return true;
      }
      return false;
    };
    child.stdout?.on('data', (c: Buffer) => {
      stdoutBytes += c.length;
      if (checkOverflow('stdout', stdoutBytes)) return;
      stdoutChunks.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderrBytes += c.length;
      if (checkOverflow('stderr', stderrBytes)) return;
      stderrChunks.push(c);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      // Narrows the race window: if Node has already populated
      // exitCode/signalCode, we know the process is dead and we
      // shouldn't report a false-timeout. There is still a tiny
      // window between OS-level exit and Node processing SIGCHLD
      // where both fields are null — a timer firing in that window
      // (microseconds wide) will still misreport a clean exit as a
      // timeout. Empirically rare; the guard reduces it to a
      // theoretical edge case but does not eliminate it.
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, opts?.timeoutMs ?? 180_000);
    timer.unref();
    child.once('error', (err) => {
      clearTimeout(timer);
      // Mirror the overflow guard in 'close': if the overflow path
      // already rejected, don't double-settle. Node's Promise
      // resolution is idempotent so this is more about consistency
      // and clarity than correctness — but it removes the
      // inconsistency between the two settle paths.
      if (overflowed) return;
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // If we already rejected via the overflow path, the resolve
      // below is a no-op (Promise resolution is idempotent), but
      // skip the buffer concat to avoid extra allocation.
      if (overflowed) return;
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        // `timedOut` short-circuits to a recognizable status: SIGKILL'd
        // by our timer ⇒ status null + signal 'SIGKILL'. Caller can
        // distinguish that from a normal exit.
        status: timedOut ? null : code,
        signal: signal as NodeJS.Signals | null,
      });
    });
  });
}

/**
 * Bootstrap a fresh wallet via `sphere wallet init --network testnet`.
 * Captures the chainPubkey and directAddress from the JSON identity
 * block emitted to stdout. Used to set up a controller wallet for HMA
 * tests.
 *
 * Timeout: 240s — wallet creation does an aggregator round-trip (nametag
 * mint) plus IPFS publish; typical happy path is ~60-90s but we give
 * generous slack for a slow relay.
 */
export function bootstrapControllerWallet(cliPath: string, home: string): {
  pubkey: string;
  directAddress: string;
} {
  const init = runSphere(cliPath, home, ['wallet', 'init', '--network', 'testnet'], {
    timeoutMs: 240_000,
  });
  if (init.status !== 0) {
    // We deliberately do NOT include init.stderr or init.stdout in the
    // message. sphere-cli's `wallet init` writes the freshly-minted
    // mnemonic to stdout (suppressed only when isTTY=false; behaviour
    // depends on the upstream version), and prints diagnostic
    // material to stderr that may transitively quote secret material
    // on a future SDK change. A failed wallet init means we cannot
    // proceed; the operator can re-run with DEBUG=1 and an interactive
    // shell to inspect output rather than pulling it through Vitest's
    // error reporter (which gets captured to log files).
    throw new Error(
      `sphere wallet init failed (status=${init.status}, signal=${init.signal}). ` +
      `Re-run with stdout/stderr connected (no Vitest pipe) to inspect — ` +
      `we redact subprocess output to avoid persisting testnet mnemonics in logs.`,
    );
  }
  // Lenient regex matching either chainPubkey or directAddress JSON fields.
  const pkMatch = init.stdout.match(/"chainPubkey":\s*"([0-9a-fA-F]{64,130})"/);
  const addrMatch = init.stdout.match(/"directAddress":\s*"(DIRECT:\/\/[0-9a-fA-F]+)"/);
  if (!pkMatch || !pkMatch[1]) {
    // Same redaction rationale: do not echo subprocess output back
    // through the test reporter. The mnemonic CAN appear in stdout
    // if the upstream version doesn't honour the isTTY guard.
    throw new Error(
      'chainPubkey not found in sphere wallet init output. ' +
      'Output redacted to avoid persisting potential mnemonic. ' +
      'Re-run with stdout connected to debug.',
    );
  }
  return {
    pubkey: pkMatch[1],
    directAddress: addrMatch?.[1] ?? `DIRECT://${pkMatch[1]}`,
  };
}
