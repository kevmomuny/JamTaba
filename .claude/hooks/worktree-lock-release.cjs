/**
 * SessionEnd Hook: Worktree Lock — Release On Clean Exit
 *
 * Deletes the worktree lock file when the owning session ends cleanly.
 * Closes the ghost-lock window: prior to this hook the lock survived past
 * session exit until the 10-minute TTL expired, and the next session would
 * see a "fresh" conflict banner from a dead owner. With this hook the
 * conflict only appears when a session is genuinely still running.
 *
 * Safety:
 *   - Uses lease.release() which checks session_id ownership before deleting.
 *     If the lock was taken over by another session (e.g. SessionEnd fires
 *     after a stale takeover), we do NOT delete the new owner's lock.
 *   - Skips the root checkout entirely (mirrors the acquire/heartbeat
 *     hooks — root is exempt from the lock layer per §2 + §13).
 *   - Always exits 0; never blocks shutdown.
 *
 * Hard kills (process killed, OS crash, power loss) bypass SessionEnd hooks
 * — those cases are handled by:
 *   1. PID liveness probe in worktree-lock-acquire.cjs (auto-takeover when
 *      the recorded PID is gone), and
 *   2. 10-minute TTL in lease.cjs (auto-takeover after idle threshold).
 *
 * The three layers together make ghost locks self-healing within seconds
 * on clean exit, immediately on next-session start for hard kills with a
 * dead PID, and within 10 minutes for hard kills where the PID got reused.
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

    if (!sessionId) {
      // No session id means we can't safely identify ownership — skip.
      process.exit(0);
    }

    const cwdHint = stdinJson.cwd || process.cwd();
    const worktreeRoot = findWorktreeRoot(cwdHint);

    if (isMainCheckout(worktreeRoot)) {
      process.exit(0);
    }

    const lockFile = path.join(worktreeRoot, '.claude', 'worktree-lock.json');

    // release() handles all the safety: missing file, corrupt file, and
    // crucially the not-owner case (a different session took over the lock
    // while we were idle, we MUST NOT delete their lock).
    lease.release({ resourceFile: lockFile, sessionId });
    process.exit(0);
  } catch (err) {
    // SessionEnd hooks must never block shutdown.
    process.stderr.write(
      `[worktree-lock-release] hook error (non-fatal): ${err.message}\n`,
    );
    process.exit(0);
  }
}

main();
