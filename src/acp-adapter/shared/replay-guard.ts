/**
 * ReplayGuard — content-hash-based replay attack prevention.
 *
 * Each incoming DM is hashed (SHA-256 of the full decrypted content).
 * The hash is checked against a persistent set of previously seen hashes.
 * If the hash exists, the message is rejected as a replay.
 *
 * The msg_id UUID inside each message acts as a nonce — two messages
 * with identical business content but different msg_ids produce different
 * hashes. An attacker cannot modify the msg_id without the sender's
 * private key (NIP-17 encrypted end-to-end).
 *
 * Storage: in-memory Map<hash, timestamp> + append-only log file.
 * Eviction: TTL-based (default 30 days). Compacted on startup AND at runtime
 * when `seen.size` crosses `maxEntries` so long-running processes don't grow
 * unbounded.
 *
 * ATOMICITY INVARIANT (critical — do not break):
 * `check()` is purely synchronous (no `await`) between `seen.has(hash)` and
 * `seen.set(hash, ts)`. In Node's single-threaded event loop this makes the
 * check-and-record step atomic — concurrent Promise.all calls cannot both
 * pass the `has` check before one `set`s. Any refactor to async I/O
 * (`appendFile`, `fs/promises`) would reintroduce a TOCTOU window.
 *
 * HYSTERESIS (cost control):
 * When `seen.size` exceeds `maxEntries`, compaction over-evicts down to
 * `maxEntries * HYSTERESIS_RATIO` so subsequent `check()`s don't trigger
 * compaction on every call (the naive "evict just enough" policy caused
 * O(n log n) sort + full disk rewrite per DM in steady state near the cap).
 *
 * LATENCY COST:
 * `check()` performs `appendFileSync` on the DM hot path. This is deliberate —
 * the atomicity invariant (no await between has/set) requires sync I/O. Under
 * disk contention the event loop blocks for the fsync duration. The append-
 * level breaker (see below) keeps the log flood bounded but does not reduce
 * steady-state latency; accept a few-ms worst case per DM or move the guard
 * to an off-thread writer if that becomes a bottleneck.
 *
 * PERSISTENCE CIRCUIT BREAKER (disk-only):
 * After a disk-rewrite failure we suppress further rewrite attempts for
 * COMPACT_BACKOFF_MS. The breaker gates ONLY the disk rewrite — in-memory
 * TTL eviction and size-cap eviction continue to run unconditionally, so
 * the Map cannot grow unbounded during sustained disk failure. The breaker
 * uses monotonic time (process.hrtime.bigint) so clock steps (NTP, VM
 * snapshot restore) cannot wedge it forever.
 *
 * FAIL-CLOSED ON DEGRADED PERSISTENCE (C10):
 * When either breaker is tripped AND the in-memory set is already at
 * `maxEntries`, accepting a new hash would force silent eviction of an older
 * hash. A replay landing AFTER its hash was evicted would pass the check
 * undetected, shrinking the effective replay window below what operators
 * configured. Rather than accept that risk, check() returns false ("treat as
 * replay") in this state. The breaker self-heals after COMPACT_BACKOFF_MS so
 * the disruption is bounded; operator alerting via onPersistError surfaces
 * the degradation at entry. This prefers a brief service hiccup over a
 * correctness violation on the replay invariant.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_MAX_ENTRIES = 100_000;
const HYSTERESIS_RATIO = 0.9; // After compact, aim for 90% of cap
const COMPACT_BACKOFF_MS = 60_000; // Suppress *disk rewrite* retries for 60s after failure

/**
 * Monotonic milliseconds since an arbitrary start point. Used for the breaker
 * deadline so NTP steps, VM snapshot restores, or system-clock-by-user edits
 * can't wedge the breaker forever (a wall-clock deadline set to now+60s can
 * become "always in the future" if the clock jumps backward).
 */
function monoNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export interface ReplayGuardOptions {
  /** Days to remember hashes (default 30). Entries older than this are evicted. */
  ttlDays?: number;
  /** Soft cap on in-memory entries; runtime compaction triggers at this size. */
  maxEntries?: number;
  /**
   * Optional sink for persistence/IO errors — surfaces silent degradation.
   * Called at most once per degradation episode (the append-level breaker
   * suppresses repeated errors during sustained failure).
   */
  onPersistError?: (err: unknown) => void;
  /**
   * Optional sink for persistence RECOVERY — paired with onPersistError.
   * Fires when appendFileSync succeeds again after a prior failure. Kept
   * separate from onPersistError so operator SIEM/alerting doesn't
   * misclassify recovery as a new error.
   */
  onPersistRecovered?: () => void;
}

/**
 * Operator-visible degraded-state stats. Used to detect a subtle DoS-amplification
 * vector: an authorized attacker can pump maxEntries unique messages while the
 * disk breaker is tripped, at which point the fail-closed gate rejects ALL
 * subsequent messages until the breaker heals (up to 60s per cycle) — turning
 * a disk warning into a full service outage. Exposing this counter lets ops
 * pages fire on sustained rejections even before the breaker-entry alert.
 */
export interface ReplayGuardDegradedStats {
  /** Cumulative count of fail-closed rejections since process start. */
  failClosedRejections: number;
  /** True if the disk-rewrite or append breakers are currently tripped. */
  diskSuppressed: boolean;
  /** Current in-memory set size. */
  size: number;
}

export interface ReplayGuard {
  /**
   * Check if a DM content string is new (not a replay).
   * If new, records the hash and returns true.
   * If replay (hash seen before), returns false.
   *
   * MUST remain synchronous. See ATOMICITY INVARIANT above.
   */
  check(dmContent: string): boolean;

  /** Number of hashes currently stored. */
  size(): number;

  /**
   * Snapshot of degraded-state stats for operator observability. See
   * ReplayGuardDegradedStats for semantics.
   */
  getDegradedStats(): ReplayGuardDegradedStats;
}

/**
 * Create a persistent replay guard.
 *
 * @param logPath - Path to the append-only hash log file.
 *                  Directory is created if it doesn't exist.
 * @param ttlDaysOrOptions - ttlDays shortcut or full options object.
 */
export function createReplayGuard(
  logPath: string,
  ttlDaysOrOptions: number | ReplayGuardOptions = DEFAULT_TTL_DAYS,
): ReplayGuard {
  const opts: Required<Pick<ReplayGuardOptions, 'ttlDays' | 'maxEntries'>>
    & Pick<ReplayGuardOptions, 'onPersistError' | 'onPersistRecovered'> =
    typeof ttlDaysOrOptions === 'number'
      ? { ttlDays: ttlDaysOrOptions, maxEntries: DEFAULT_MAX_ENTRIES }
      : {
          ttlDays: ttlDaysOrOptions.ttlDays ?? DEFAULT_TTL_DAYS,
          maxEntries: ttlDaysOrOptions.maxEntries ?? DEFAULT_MAX_ENTRIES,
          onPersistError: ttlDaysOrOptions.onPersistError,
          onPersistRecovered: ttlDaysOrOptions.onPersistRecovered,
        };

  if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1) {
    throw new Error(`ReplayGuard maxEntries must be a positive integer, got: ${opts.maxEntries}`);
  }
  if (!Number.isFinite(opts.ttlDays) || opts.ttlDays <= 0) {
    throw new Error(`ReplayGuard ttlDays must be a positive number, got: ${opts.ttlDays}`);
  }

  const ttlMs = opts.ttlDays * 86_400_000;
  const targetAfterCompact = Math.max(1, Math.floor(opts.maxEntries * HYSTERESIS_RATIO));
  const seen = new Map<string, number>(); // hash -> timestamp
  // Monotonic deadlines — disk ops are skipped while monoNowMs() < deadline.
  // Both breakers suppress ONLY disk I/O; in-memory eviction always runs so the
  // Map doesn't grow unbounded during sustained disk failure.
  let diskRewriteSuppressedUntil = 0;
  let appendSuppressedUntil = 0;
  // Append-degraded state — used to emit exactly one "degraded" / "recovered"
  // log instead of one error per DM during sustained disk failure.
  let appendDegraded = false;
  // DoS-amplification observability: count every fail-closed rejection so
  // operators can detect "authorized attacker flood during breaker" before the
  // breaker heals. Exposed via getDegradedStats().
  let failClosedRejectionCount = 0;
  // Rate-limited warning on fail-closed — at most once per FAIL_CLOSED_WARN_MS
  // so a sustained flood doesn't spam the logger (which itself rate-limits, but
  // we short-circuit that path to avoid burning its token budget for one event).
  let lastFailClosedWarnMs = 0;
  const FAIL_CLOSED_WARN_MS = 60_000;
  // Proactive-eviction threshold. While the fail-closed gate is active we want
  // TTL-expired entries to age out so the guard can heal itself once disk is
  // back. Without this, TTL eviction only ran when seen.size > maxEntries —
  // so the guard stayed wedged at maxEntries as long as new messages kept
  // arriving (each one getting fail-closed-rejected, never setting into `seen`).
  const PROACTIVE_EVICT_THRESHOLD = Math.max(1, Math.floor(opts.maxEntries * HYSTERESIS_RATIO));

  // Load existing hashes and compact (evict expired)
  loadAndCompact();

  function hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Report a persistence error to the configured sink, with a last-resort
   * console.error fallback if the sink itself throws. Both calls are wrapped
   * in try/catch because the whole point of this path is that disk is broken
   * — the logger may be downstream of the same failure (e.g., log file on
   * the full disk) and console.error can itself throw under SIGPIPE when
   * stdio is orphaned. A throwing reporter on the hot check() path would
   * become a silent inbound-DM DoS.
   */
  function reportPersistError(err: unknown): void {
    if (opts.onPersistError) {
      try {
        opts.onPersistError(err);
        return;
      } catch {
        // Sink threw. Fall through to console fallback.
      }
    }
    try {
      // eslint-disable-next-line no-console
      console.error('ReplayGuard persistence error:', err);
    } catch {
      // Last-resort fallback itself failed (SIGPIPE, closed stdio). Swallow —
      // in-memory replay protection still works; we just lose observability
      // for this moment. Raising here would kill the DM dispatch path.
    }
  }

  /**
   * Paired signal with reportPersistError — fires exactly once per recovery
   * transition (degraded → OK). Kept on a separate callback so operator
   * alerting pipelines can treat recovery as a resolution, not a new error.
   * Wrapped identically to reportPersistError to guarantee no exception
   * escapes into check().
   */
  function reportPersistRecovered(): void {
    if (opts.onPersistRecovered) {
      try {
        opts.onPersistRecovered();
        return;
      } catch {
        // Sink threw. Fall through.
      }
    }
    try {
      // eslint-disable-next-line no-console
      console.info('ReplayGuard persistence recovered');
    } catch {
      // Same SIGPIPE rationale as reportPersistError fallback.
    }
  }

  /**
   * Evict in-memory entries: TTL-expired first, then oldest-first down to
   * `targetAfterCompact` (hysteresis) if still above cap. Always runs — never
   * gated by the breaker. This is the only path that bounds Map growth under
   * sustained disk failure.
   *
   * Size-cap trim uses Map insertion order (V8 guarantees this) to drop the
   * oldest N entries in O(n) without allocating a full sorted copy. All
   * internal writes call `seen.set(hash, Date.now())` in monotonic order (the
   * check() path uses a single `now` for the hot path, loadAndCompact() sets
   * in file order which is append-monotonic), so insertion order == age order
   * for our purposes. An attacker-controlled ts_ms never reaches `seen`.
   *
   * FAST PATH: Map iteration is insertion-ordered and ts is monotonic, so the
   * first entry is always the oldest. If it's still within TTL, everything
   * else is fresher — skip the full O(n) walk. This matters when the proactive
   * eviction path fires with a near-full but all-fresh Map (90k entries, none
   * expired): without this short-circuit we'd pay O(n) per check() for nothing.
   *
   * @returns number of entries evicted (for skip-rewrite decision).
   */
  function evictInMemory(): number {
    const cutoff = Date.now() - ttlMs;
    // Short-circuit: if the oldest entry is still fresh AND we're within the
    // size cap, nothing can be evicted. Avoid the O(n) TTL walk.
    const firstEntry = seen.entries().next();
    if (!firstEntry.done) {
      const [, firstTs] = firstEntry.value;
      if (firstTs >= cutoff && seen.size <= opts.maxEntries) return 0;
    }
    let evicted = 0;
    for (const [h, t] of seen) {
      if (t < cutoff) { seen.delete(h); evicted++; }
    }
    if (seen.size > opts.maxEntries) {
      // O(n) insertion-order trim — no sort, no full-Map allocation.
      let toDelete = seen.size - targetAfterCompact;
      for (const key of seen.keys()) {
        if (toDelete-- <= 0) break;
        seen.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Rewrite the on-disk log from the current in-memory state.
   * The breaker gates ONLY this disk write — if a prior rewrite failed,
   * subsequent calls no-op until the backoff window expires. In-memory
   * eviction (evictInMemory) is NOT gated by the breaker.
   */
  function rewriteDisk(): boolean {
    if (monoNowMs() < diskRewriteSuppressedUntil) return false;

    const tmpPath = logPath + '.tmp';
    const lines: string[] = [];
    for (const [h, t] of seen) {
      lines.push(`${h} ${t}`);
    }
    try {
      writeFileSync(tmpPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
      renameSync(tmpPath, logPath);
      return true;
    } catch (err) {
      reportPersistError(err);
      // Without the breaker, a persistent failure mode (ENOSPC) would cause
      // every check() to re-sort + re-write + re-fail. The breaker lets us
      // keep accepting messages (in-memory eviction continues) without
      // hammering the disk.
      diskRewriteSuppressedUntil = monoNowMs() + COMPACT_BACKOFF_MS;
      return false;
    }
  }

  /**
   * Compact = in-memory eviction (always runs) + optional disk rewrite (gated).
   *
   * @param forceRewrite If true, attempt the rewrite even if no entries were
   *                     evicted (used by startup when TTL-filtered entries loaded).
   * @returns true if compaction completed (even if disk rewrite was suppressed).
   */
  function compact(forceRewrite: boolean = false): boolean {
    const evicted = evictInMemory();
    if (evicted === 0 && !forceRewrite) return true; // nothing to write
    rewriteDisk();
    return true;
  }

  function loadAndCompact(): void {
    if (!existsSync(logPath)) {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
      } catch (err) {
        reportPersistError(err);
      }
      return;
    }

    const cutoff = Date.now() - ttlMs;
    let raw: string;
    try {
      raw = readFileSync(logPath, 'utf-8');
    } catch (err) {
      reportPersistError(err);
      return; // File unreadable — start fresh
    }

    const lines = raw.split('\n');
    let droppedExpired = 0;
    for (const line of lines) {
      if (!line) continue;
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      const hash = line.slice(0, spaceIdx);
      // Reject anything that isn't a 64-char lowercase hex SHA-256 digest.
      // A tampered log with injected garbage-hash lines could otherwise
      // poison the `seen` map and make legitimate hashes appear as replays.
      if (!/^[0-9a-f]{64}$/.test(hash)) continue;
      // Strict ts validation: parseInt("123garbage", 10) returns 123 — which
      // means an attacker with disk-write access could plant entries whose
      // parsed timestamp differs from what's on disk, confusing TTL logic.
      // Require the trailing field to be a pure digit string with no garbage.
      const tsStr = line.slice(spaceIdx + 1);
      if (!/^\d+$/.test(tsStr)) continue;
      const ts = parseInt(tsStr, 10);
      // Defense in depth: reject non-finite, non-positive, or near-overflow
      // values. Number.MAX_SAFE_INTEGER-sized timestamps are millennia in the
      // future and indicate adversarial input or corruption either way.
      if (!Number.isFinite(ts) || ts <= 0 || ts >= Number.MAX_SAFE_INTEGER) continue;
      if (ts >= cutoff) {
        seen.set(hash, ts);
      } else {
        droppedExpired++;
      }
    }

    // Only rewrite at startup if we actually dropped something (TTL eviction)
    // or are over the cap. Avoids pointless full-log rewrites on clean restarts.
    if (droppedExpired > 0 || seen.size > opts.maxEntries) {
      compact(/* forceRewrite */ true);
    }
  }

  return {
    check(dmContent: string): boolean {
      const hash = hashContent(dmContent);
      if (seen.has(hash)) {
        return false; // Replay detected
      }

      // C10 fail-closed: if disk persistence is broken (either breaker tripped)
      // AND accepting this message would require eviction to stay within the
      // size cap, REJECT the message as if it were a replay. Rationale:
      //   - Silent eviction shrinks the replay window without operator visibility;
      //     a replay landing after its hash was evicted would pass undetected.
      //   - Fail-closed converts a replay-window-shrink risk into a brief service
      //     disruption. Rejecting legitimate new messages while disk is broken is
      //     strictly better than accepting a replay.
      //   - The breaker self-heals after COMPACT_BACKOFF_MS, so the disruption is
      //     bounded. Operator alerting via onPersistError surfaces the degradation.
      // "Would require eviction" = current size already at/over the cap, so the
      // caller adding a new entry would cross the threshold that triggers evict.
      const now = monoNowMs();
      const diskBroken =
        now < appendSuppressedUntil || now < diskRewriteSuppressedUntil;

      // Proactive TTL eviction ONLY while disk is broken AND near the cap.
      // The point of proactive eviction is to heal the fail-closed gate once
      // TTL-expired entries age out — so we only run it when that gate is
      // actually active (disk broken). When disk is healthy, the normal
      // post-set `size > maxEntries` path in evictInMemory() handles growth,
      // and paying O(n) per check() here would be pure CPU drain (at 90k
      // all-fresh entries the walk finds nothing to evict).
      if (diskBroken && seen.size >= PROACTIVE_EVICT_THRESHOLD) {
        evictInMemory();
      }

      if (diskBroken && seen.size >= opts.maxEntries) {
        // Treat as replay (fail-closed). Count it so operators can see the
        // DoS-amplification vector (authorized attacker flooding during
        // breaker window); re-emitting reportPersistError per-check would
        // flood the same alerting pipeline the breaker was designed to
        // protect, so we use a rate-limited logger warning instead.
        failClosedRejectionCount++;
        if (now - lastFailClosedWarnMs >= FAIL_CLOSED_WARN_MS) {
          lastFailClosedWarnMs = now;
          try {
            // eslint-disable-next-line no-console
            console.warn(
              'replay_guard_fail_closed',
              JSON.stringify({
                size: seen.size,
                max_entries: opts.maxEntries,
                fail_closed_rejections: failClosedRejectionCount,
              }),
            );
          } catch {
            // stdout closed / SIGPIPE — swallow, we still rejected the message.
          }
        }
        return false;
      }

      const nowWall = Date.now();
      seen.set(hash, nowWall);

      // Append breaker: under sustained disk failure (ENOSPC etc.) we'd otherwise
      // log one error per DM, flooding any remote alerting pipeline the operator
      // wired into onPersistError. The breaker suppresses appendFileSync for a
      // backoff window and emits exactly one "degraded" signal on entry +
      // one "recovered" signal on exit (via distinct callbacks).
      if (monoNowMs() >= appendSuppressedUntil) {
        try {
          appendFileSync(logPath, `${hash} ${nowWall}\n`);
          if (appendDegraded) {
            appendDegraded = false;
            reportPersistRecovered();
          }
        } catch (err) {
          appendSuppressedUntil = monoNowMs() + COMPACT_BACKOFF_MS;
          if (!appendDegraded) {
            appendDegraded = true;
            reportPersistError(err);
          }
          // Persistence failed — still protected in-memory for this session.
        }
      }

      // Runtime compaction: when we exceed the cap, evict expired entries
      // and (if still over) drop the oldest down to HYSTERESIS_RATIO × cap.
      // Hysteresis prevents re-compact on every subsequent check().
      // Circuit breaker in compact() prevents disk-rewrite hammering after failure.
      if (seen.size > opts.maxEntries) {
        compact();
      }
      return true; // New message
    },

    size(): number {
      return seen.size;
    },

    getDegradedStats(): ReplayGuardDegradedStats {
      const now = monoNowMs();
      return {
        failClosedRejections: failClosedRejectionCount,
        diskSuppressed:
          now < appendSuppressedUntil || now < diskRewriteSuppressedUntil,
        size: seen.size,
      };
    },
  };
}

/**
 * Create an in-memory-only replay guard (no persistence).
 * Useful for tests or ephemeral agents.
 */
export function createMemoryReplayGuard(): ReplayGuard {
  const seen = new Set<string>();

  return {
    check(dmContent: string): boolean {
      const hash = createHash('sha256').update(dmContent, 'utf-8').digest('hex');
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    },
    size(): number {
      return seen.size;
    },
    getDegradedStats(): ReplayGuardDegradedStats {
      // In-memory guard has no disk — no degradation possible. Stats reflect
      // that so the shape matches the persistent guard for callers using the
      // stats for monitoring (they won't need to branch on guard type).
      return {
        failClosedRejections: 0,
        diskSuppressed: false,
        size: seen.size,
      };
    },
  };
}
