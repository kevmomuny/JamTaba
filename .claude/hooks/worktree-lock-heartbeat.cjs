/**
 * PostToolUse Hook: Worktree Lock — Heartbeat Refresh
 *
 * Updates `last_heartbeat` on the worktree's lock file after every tool
 * call so the lock stays fresh for as long as the session is active.
 * Stale-detection in worktree-lock-acquire.cjs uses last_heartbeat to
 * decide whether to take over abandoned locks.
 *
 * Cheap: one stat + one read + one write per tool call. Silent on
 * success; never blocks tool execution.
 *
 * If our session_id doesn't match the lock owner (another agent took
 * over while we were idle), the heartbeat is a no-op — we don't trample
 * the active owner's lock.
 *
 * Refactored in v2 §9b to use the universal lease library at
 * `.claude/lib/lease.cjs`. File shape preserved for backward-compat.
 */

const fs = require('fs');
const path = require('path');

const lease = require('../lib/lease.cjs');

function findWorktreeRoot(startDir) {
  let cwd = startDir || process.cwd();
  while (cwd && cwd !== path.dirname(cwd)) {
    if (fs.existsSync(path.join(cwd, '.git'))) return cwd;
    cwd = path.dirname(cwd);
  }
  return startDir || process.cwd();
}

// Mirror of the acquire-hook helper: skip locks on the root checkout. Must
// agree with worktree-lock-acquire.cjs about which worktrees are managed —
// otherwise heartbeats would refresh a lock that acquire never wrote.
function isMainCheckout(worktreeRoot) {
  try {
    return fs.statSync(path.join(worktreeRoot, '.git')).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  try {
    let stdinRaw = '';
    for await (const chunk of process.stdin) stdinRaw += chunk;
    let stdinJson = {};
    try { stdinJson = JSON.parse(stdinRaw); } catch { /* no payload */ }

    const sessionId =
      stdinJson.session_id || stdinJson.sessionId || null;

    const cwdHint = stdinJson.cwd || process.cwd();
    const worktreeRoot = findWorktreeRoot(cwdHint);

    if (isMainCheckout(worktreeRoot)) {
      process.exit(0);
    }

    const lockFile = path.join(worktreeRoot, '.claude', 'worktree-lock.json');

    // Inspect first to check ownership without modifying. If the lock isn't
    // ours, don't refresh — the active owner's own heartbeats stay fresh.
    const state = lease.inspect({ resourceFile: lockFile });
    if (!state.exists || state.corrupt) {
      // No lock or unparseable — leave it for the next acquire to handle.
      process.exit(0);
    }

    if (sessionId && state.lock.session_id && sessionId !== state.lock.session_id) {
      // Different session owns it — silent no-op.
      process.exit(0);
    }

    // Refresh the heartbeat. Library tolerates fs races silently.
    lease.refresh({ resourceFile: lockFile });
    process.exit(0);
  } catch (err) {
    // Heartbeat must never block tool use.
    process.stderr.write(
      `[worktree-lock-heartbeat] hook error (non-fatal): ${err.message}\n`,
    );
    process.exit(0);
  }
}

main();
