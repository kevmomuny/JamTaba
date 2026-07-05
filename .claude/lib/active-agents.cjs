/**
 * Active-Agents Registry Reader — multi-agent-coordination v2 §3.
 *
 * The WRITE side ships in `active-agents-update.cjs` (PR #262): each session
 * registers on SessionStart and unregisters on Stop into
 * `<main_worktree>/.claude/state/active-agents.jsonl`.
 *
 * This is the READ side: a trustworthy, queryable view of which sessions are
 * actually LIVE right now. "Trustworthy" is the whole point — a stale registry
 * entry from a crashed session is the same false-positive that made
 * lock-inference unreliable during the 2026-05-23 worktree-cleanup incident
 * (see feedback_lock_aware_worktree_reclaim). So every read prunes entries
 * whose owning PID is gone.
 *
 * Liveness model (must match worktree-lock-acquire.cjs / lease.cjs):
 *   - PRIMARY: `process.kill(pid, 0)` — ESRCH→dead, EPERM→alive (conservative).
 *     An idle-but-alive session (no recent last_beat) is LIVE. Never prune a
 *     live PID on age alone.
 *   - FALLBACK: entries with a missing/zero PID are pruned only when their
 *     last_beat is older than TTL (default 30 min).
 *
 * Consumers: `/cleanup-worktrees` (skip worktrees a live session owns),
 * §1 pre-flight (`node active-agents.cjs list`).
 *
 * Contract: never throws. Returns safe empties on any error.
 *
 * CLI:
 *   node active-agents.cjs list   — human-readable live agents (+ pruned count)
 *   node active-agents.cjs json   — machine-readable live agents (JSON array)
 *   node active-agents.cjs prune  — rewrite the registry dropping dead entries
 *   node active-agents.cjs all    — human-readable incl. dead (debug)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min — fallback for pid-less entries

/**
 * Cross-platform PID existence probe. Mirrors worktree-lock-acquire.cjs.
 * true on alive or EPERM (alive-but-shielded); false on ESRCH / bad input.
 */
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/** Locate the main worktree (first `git worktree list --porcelain` entry). */
function findMainWorktreeRoot(startDir) {
  try {
    const out = execSync('git worktree list --porcelain', {
      cwd: startDir || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/^worktree (.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* fall through */
  }
  // Fallback: walk up to the nearest `.git`.
  let cwd = startDir || process.cwd();
  while (cwd && cwd !== path.dirname(cwd)) {
    if (fs.existsSync(path.join(cwd, '.git'))) return cwd;
    cwd = path.dirname(cwd);
  }
  return startDir || process.cwd();
}

/** Absolute path to the registry file. */
function findRegistryFile(startDir) {
  return path.join(
    findMainWorktreeRoot(startDir),
    '.claude',
    'state',
    'active-agents.jsonl',
  );
}

/** Parse the JSONL registry, tolerating corrupt lines. Never throws. */
function read(registryFile) {
  const file = registryFile || findRegistryFile();
  if (!fs.existsSync(file)) return [];
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);
  } catch {
    return [];
  }
}

/**
 * Partition entries into { live, dead } by the liveness model above.
 * ttlMs overrides the pid-less fallback threshold.
 */
function prune(entries, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const live = [];
  const dead = [];
  const now = Date.now();
  for (const e of entries || []) {
    const pid = Number(e && e.pid);
    if (Number.isInteger(pid) && pid > 0) {
      (isPidAlive(pid) ? live : dead).push(e);
      continue;
    }
    // No usable pid — fall back to TTL on last_beat (then started).
    const beat = new Date((e && (e.last_beat || e.started)) || 0).getTime();
    const ageMs = now - beat;
    (ageMs <= ttlMs ? live : dead).push(e);
  }
  return { live, dead };
}

/** Live agents only. Reads + prunes; never throws. */
function list({ pruneDead = true, startDir, registryFile, ttlMs } = {}) {
  const entries = read(registryFile || findRegistryFile(startDir));
  if (!pruneDead) return entries;
  return prune(entries, { ttlMs }).live;
}

/** Normalize a worktree path for comparison (case-insensitive on win32). */
function normPath(p) {
  if (!p) return '';
  let n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

/**
 * Is the given worktree path owned by a LIVE session?
 * Used by /cleanup-worktrees to refuse reclaiming an in-use worktree.
 */
function isWorktreeLive(worktreePath, opts = {}) {
  const target = normPath(worktreePath);
  if (!target) return false;
  return list(opts).some((e) => normPath(e.worktree) === target);
}

/** Human-readable one-block summary of live agents. */
function summary(opts = {}) {
  const live = list(opts);
  if (live.length === 0) return 'No other active agents.';
  const lines = live.map((e) => {
    const sid = String(e.session_id || '?').slice(0, 8);
    const wt = e.worktree ? path.basename(e.worktree) : '?';
    const beat = e.last_beat || e.started || '?';
    return `  • session=${sid} pid=${e.pid ?? '?'} branch=${e.branch || '?'} worktree=${wt} last_beat=${beat}`;
  });
  return `${live.length} active agent${live.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

/** Rewrite the registry, dropping dead entries. Returns counts. Never throws. */
function pruneFile(registryFile, opts = {}) {
  const file = registryFile || findRegistryFile();
  const entries = read(file);
  const { live, dead } = prune(entries, opts);
  if (dead.length === 0) return { kept: live.length, removed: 0 };
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    const body = live.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(tmp, body.length ? body + '\n' : '');
    fs.renameSync(tmp, file);
  } catch {
    return { kept: live.length, removed: 0, error: true };
  }
  return { kept: live.length, removed: dead.length };
}

module.exports = {
  isPidAlive,
  findMainWorktreeRoot,
  findRegistryFile,
  read,
  prune,
  list,
  isWorktreeLive,
  summary,
  pruneFile,
  DEFAULT_TTL_MS,
};

// ---- CLI ----
if (require.main === module) {
  const mode = process.argv[2] || 'list';
  try {
    if (mode === 'json') {
      process.stdout.write(JSON.stringify(list(), null, 2) + '\n');
    } else if (mode === 'prune') {
      const r = pruneFile();
      process.stdout.write(
        `[active-agents] pruned ${r.removed} dead, kept ${r.kept} live${r.error ? ' (write error)' : ''}\n`,
      );
    } else if (mode === 'all') {
      const all = read();
      const { live, dead } = prune(all);
      process.stdout.write(
        `${summary()}\n(${dead.length} dead entr${dead.length === 1 ? 'y' : 'ies'} would be pruned)\n`,
      );
    } else {
      process.stdout.write(summary() + '\n');
    }
  } catch (err) {
    process.stderr.write(`[active-agents] ${err.message}\n`);
  }
  process.exit(0);
}
