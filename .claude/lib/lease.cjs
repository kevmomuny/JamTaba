/**
 * Universal Lease Library — multi-agent-coordination v2 §9b.
 *
 * Generalizes the worktree-lock heartbeat+TTL pattern from v2 §9a to any
 * contended resource. One library, multiple consumers, identical semantics:
 *   - Worktrees:           <worktree>/.claude/worktree-lock.json
 *   - Dev ports (Dell):    <main>/.claude/state/dell-port-leases.jsonl
 *   - In-flight migration: <main>/.claude/state/migration-in-flight.json
 *   - CI runner slots:     <main>/.claude/state/runner-leases/<runner>.json
 *
 * Why a library and not 4 copy-pasted hooks: the heartbeat+TTL pattern is
 * subtle (atomic create with O_EXCL, corrupt-recovery, takeover policy,
 * never-crash contract). Anthropic's C-compiler experiment (Feb 2026), Cursor
 * 2.0, Devin MultiDevin, and claude_code_agent_farm all use static lock
 * files without TTL — drift in 4 places is worse than drift in 1.
 *
 * The library does NOT enforce a specific schema beyond stamping
 * `acquired_at` + `last_heartbeat` + `ttl_seconds`. Callers pass `ownerData`
 * (an opaque object) which is spread into the lock payload. This preserves
 * backward-compat with the existing worktree-lock fields (session_id,
 * branch, worktree, pid, claude_code) without coupling the library to them.
 *
 * Every function returns a state-bearing result; never throws. Callers
 * decide policy (resume / takeover / warn / block).
 *
 * Origin: multi-agent-protocol-v2 Phase 3.
 */

const fs = require('fs');
const path = require('path');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Try to acquire the lock atomically. Returns:
 *   { state: 'acquired',           lock, existing: null }     — won the race
 *   { state: 'replaced-corrupt',   lock, existing: null }     — overwrote unparseable lock
 *   { state: 'exists',             lock: null, existing }     — caller decides next move
 *   { state: 'error',              lock: null, existing: null, error } — fs problem
 */
function tryAcquire({ resourceFile, ownerData, ttlSeconds }) {
  ensureDir(resourceFile);
  const now = new Date().toISOString();
  const lock = {
    ...ownerData,
    acquired_at: now,
    last_heartbeat: now,
    ttl_seconds: ttlSeconds,
  };

  try {
    fs.writeFileSync(resourceFile, JSON.stringify(lock, null, 2), { flag: 'wx' });
    return { state: 'acquired', lock, existing: null };
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return { state: 'error', lock: null, existing: null, error: err.message };
    }
  }

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
  } catch {
    try {
      fs.writeFileSync(resourceFile, JSON.stringify(lock, null, 2));
      return { state: 'replaced-corrupt', lock, existing: null };
    } catch (err) {
      return { state: 'error', lock: null, existing: null, error: err.message };
    }
  }

  return { state: 'exists', lock: null, existing };
}

/**
 * Refresh the heartbeat on an existing lock. Optionally merge new fields
 * from ownerData into the lock (use sparingly — preserves all unmentioned
 * fields, including acquired_at). Returns:
 *   { state: 'refreshed', lock }   — heartbeat updated
 *   { state: 'no-lock' }            — file missing
 *   { state: 'corrupt' }            — file unparseable (caller decides)
 *   { state: 'error', error }       — fs problem
 */
function refresh({ resourceFile, ownerData }) {
  if (!fs.existsSync(resourceFile)) return { state: 'no-lock' };
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
  } catch {
    return { state: 'corrupt' };
  }
  existing.last_heartbeat = new Date().toISOString();
  if (ownerData) Object.assign(existing, ownerData);
  try {
    fs.writeFileSync(resourceFile, JSON.stringify(existing, null, 2));
  } catch (err) {
    return { state: 'error', error: err.message };
  }
  return { state: 'refreshed', lock: existing };
}

/**
 * Force-acquire the lock (after caller's own staleness/policy check).
 * Always succeeds (or errors). Returns:
 *   { state: 'taken-over', lock, previous }  — previous may be null if no prior lock
 *   { state: 'error', error }
 */
function takeover({ resourceFile, ownerData, ttlSeconds, reason }) {
  ensureDir(resourceFile);
  let previous = null;
  if (fs.existsSync(resourceFile)) {
    try {
      previous = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
    } catch {
      previous = null;
    }
  }
  const now = new Date().toISOString();
  const lock = {
    ...ownerData,
    acquired_at: now,
    last_heartbeat: now,
    ttl_seconds: ttlSeconds,
  };
  if (reason) lock.takeover_reason = reason;
  try {
    fs.writeFileSync(resourceFile, JSON.stringify(lock, null, 2));
  } catch (err) {
    return { state: 'error', error: err.message };
  }
  return { state: 'taken-over', lock, previous };
}

/**
 * Release the lock — but only if the caller is the owner (matched by
 * sessionIdField, default 'session_id'). Returns:
 *   { state: 'released' }            — file deleted
 *   { state: 'no-lock' }             — file missing
 *   { state: 'corrupt' }             — file unparseable
 *   { state: 'not-owner', existing } — different session owns it
 *   { state: 'error', error }
 */
function release({ resourceFile, sessionId, sessionIdField = 'session_id' }) {
  if (!fs.existsSync(resourceFile)) return { state: 'no-lock' };
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
  } catch {
    return { state: 'corrupt' };
  }
  if (existing[sessionIdField] !== sessionId) {
    return { state: 'not-owner', existing };
  }
  try {
    fs.unlinkSync(resourceFile);
  } catch (err) {
    return { state: 'error', error: err.message };
  }
  return { state: 'released' };
}

/**
 * Read the current lock state without modifying it. Returns:
 *   { exists: false }
 *   { exists: true, corrupt: true }
 *   { exists: true, corrupt: false, lock, last_heartbeat, age_ms, is_stale }
 *
 * `is_stale` uses the caller's ttlSeconds override if provided; otherwise
 * the lock's own ttl_seconds field; otherwise 600 (10 min default).
 */
function inspect({ resourceFile, ttlSeconds }) {
  if (!fs.existsSync(resourceFile)) return { exists: false };
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
  } catch {
    return { exists: true, corrupt: true };
  }
  const lastBeat = new Date(
    existing.last_heartbeat || existing.acquired_at || 0,
  ).getTime();
  const ageMs = Date.now() - lastBeat;
  const ttl = (ttlSeconds || existing.ttl_seconds || 600) * 1000;
  return {
    exists: true,
    corrupt: false,
    lock: existing,
    last_heartbeat: existing.last_heartbeat,
    age_ms: ageMs,
    is_stale: ageMs > ttl,
  };
}

module.exports = { tryAcquire, refresh, takeover, release, inspect };
