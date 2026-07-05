/**
 * SessionStart Hook: Worktree Lock — Acquire / Detect Conflict
 *
 * Detects the multi-agent-on-one-worktree race that surfaced during
 * c360-events-feed Phase 3 step 5 (project_c360_events_feed_phase_3_5
 * memory). Per `.claude/rules/multi-agent-coordination.md` §1-§2 + §9, agents
 * should run one-branch-per-agent + one-worktree-per-agent. This hook
 * makes the rule self-enforcing.
 *
 * Behavior (unchanged from v2 §9a, refactored to use the universal lease
 * library at `.claude/lib/lease.cjs` per v2 §9b):
 *   - Locates the current worktree root by walking up from process.cwd()
 *     until it finds a `.git` file or directory.
 *   - Lock file: `<worktreeRoot>/.claude/worktree-lock.json` (gitignored).
 *   - On atomic create (O_EXCL): we own the lock. Done.
 *   - On EEXIST + matching session_id: this is a resume, refresh heartbeat.
 *   - On EEXIST + stale (>10min since last_heartbeat): take over with warning.
 *   - On EEXIST + fresh + different session: print BIG warning, allow session
 *     to proceed (hooks shouldn't crash session start).
 *
 * Companion hooks:
 *   - worktree-lock-heartbeat.cjs (PostToolUse) — refreshes last_heartbeat
 *
 * Manual recovery:
 *   - `rm <worktree>/.claude/worktree-lock.json` to force re-acquire on next session.
 */

const fs = require('fs');
const path = require('path');

const lease = require('../lib/lease.cjs');

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const TTL_SECONDS = STALE_THRESHOLD_MS / 1000;
const SHORT_ID_LEN = 8;

function findWorktreeRoot(startDir) {
  let cwd = startDir || process.cwd();
  while (cwd && cwd !== path.dirname(cwd)) {
    if (fs.existsSync(path.join(cwd, '.git'))) return cwd;
    cwd = path.dirname(cwd);
  }
  return startDir || process.cwd();
}

// Root checkout has `.git` as a directory. Sibling worktrees from
// `git worktree add` have `.git` as a file (`gitdir: ...`). Per §2 + §13,
// root is reserved for Kevin's shell + Dell systemd source; agent edits
// must happen in sibling worktrees and are already blocked at root by
// worktree-strict-guard. The lock layer was double-gating the wrong thing
// and forcing every session-start to surface a banner. Skip locks on root.
function isMainCheckout(worktreeRoot) {
  try {
    return fs.statSync(path.join(worktreeRoot, '.git')).isDirectory();
  } catch {
    return false;
  }
}

// Cross-platform PID existence probe. Node's process.kill(pid, 0) sends no
// signal — it just tests whether the process exists. Returns:
//   - true on success (alive) or EPERM (alive but can't signal)
//   - false on ESRCH (no such process) or any other error
// Treating EPERM as alive is conservative: don't stomp a permission-shielded
// live agent.
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readBranch(worktreeRoot) {
  try {
    const gitPath = path.join(worktreeRoot, '.git');
    const stat = fs.statSync(gitPath);
    let gitDir;
    if (stat.isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      gitDir = content.startsWith('gitdir: ')
        ? content.slice('gitdir: '.length)
        : null;
    } else {
      gitDir = gitPath;
    }
    if (!gitDir) return 'unknown';
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: refs/heads/')) {
      return head.slice('ref: refs/heads/'.length);
    }
    return head.slice(0, 12);
  } catch {
    return 'unknown';
  }
}

function shortId(id) {
  if (!id || typeof id !== 'string') return '?';
  return id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id;
}

function ageHumanReadable(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

async function main() {
  try {
    let stdinRaw = '';
    for await (const chunk of process.stdin) stdinRaw += chunk;
    let stdinJson = {};
    try { stdinJson = JSON.parse(stdinRaw); } catch { /* no payload */ }

    const sessionId =
      stdinJson.session_id ||
      stdinJson.sessionId ||
      `pid-${process.ppid}-${Date.now()}`;

    const cwdHint = stdinJson.cwd || process.cwd();
    const worktreeRoot = findWorktreeRoot(cwdHint);

    // Root checkout is exempt — agents must edit in sibling worktrees, and
    // worktree-strict-guard already enforces that at edit time. Locking root
    // produced spurious conflict banners on every session start without
    // protecting anything strict-guard wasn't already protecting.
    if (isMainCheckout(worktreeRoot)) {
      process.exit(0);
    }

    const lockFile = path.join(worktreeRoot, '.claude', 'worktree-lock.json');

    const branch = readBranch(worktreeRoot);
    const ownerData = {
      session_id: sessionId,
      branch,
      worktree: worktreeRoot,
      pid: process.ppid,
      claude_code: stdinJson.transcript_path || null,
    };

    // Try to acquire atomically. The lease library handles:
    //   - 'acquired'         → won the race, lock written
    //   - 'replaced-corrupt' → existing lock was unparseable, overwrote it
    //   - 'exists'           → another lock present, caller decides policy
    //   - 'error'            → fs problem, exit silently (hook contract)
    const result = lease.tryAcquire({
      resourceFile: lockFile,
      ownerData,
      ttlSeconds: TTL_SECONDS,
    });

    if (result.state === 'acquired') {
      // Quiet success.
      process.exit(0);
    }

    if (result.state === 'replaced-corrupt') {
      process.stdout.write(
        `[worktree-lock] Replaced corrupt lock file at ${lockFile}\n`,
      );
      process.exit(0);
    }

    if (result.state === 'error') {
      process.stderr.write(
        `[worktree-lock] hook error (non-fatal): ${result.error}\n`,
      );
      process.exit(0);
    }

    // state === 'exists' — apply our policy: resume, takeover, or warn.
    const existing = result.existing;
    const lastBeat = new Date(
      existing.last_heartbeat || existing.acquired_at || 0,
    ).getTime();
    const age = Date.now() - lastBeat;

    if (existing.session_id === sessionId) {
      // Same session resume — refresh heartbeat silently.
      lease.refresh({ resourceFile: lockFile });
      process.exit(0);
    }

    if (age > STALE_THRESHOLD_MS) {
      lease.takeover({
        resourceFile: lockFile,
        ownerData,
        ttlSeconds: TTL_SECONDS,
        reason: `stale (idle ${ageHumanReadable(age)})`,
      });
      process.stdout.write(
        `[worktree-lock] Took over stale lock from session ${shortId(existing.session_id)} (idle ${ageHumanReadable(age)})\n`,
      );
      process.exit(0);
    }

    // PID liveness probe — a fresh heartbeat doesn't prove the session is
    // alive (PostToolUse hooks can write a heartbeat moments before the
    // session crashes; the SessionEnd release hook handles clean exits but
    // can't run on a hard kill). If the recorded PID is gone, take over
    // silently rather than print the conflict banner.
    if (existing.pid && !isPidAlive(existing.pid)) {
      lease.takeover({
        resourceFile: lockFile,
        ownerData,
        ttlSeconds: TTL_SECONDS,
        reason: `dead pid ${existing.pid}`,
      });
      process.stdout.write(
        `[worktree-lock] Took over lock from session ${shortId(existing.session_id)} (pid ${existing.pid} not running)\n`,
      );
      process.exit(0);
    }

    // Fresh lock owned by a different session with a live PID — WARN, but
    // don't block.
    process.stdout.write(
      `\n` +
        `┌──────────────────────────────────────────────────────────────────┐\n` +
        `│ ⚠ WORKTREE LOCK CONFLICT — another agent is active here          │\n` +
        `└──────────────────────────────────────────────────────────────────┘\n` +
        `  Worktree:    ${worktreeRoot}\n` +
        `  Branch:      ${branch}\n` +
        `  Other agent: session=${shortId(existing.session_id)} pid=${existing.pid ?? '?'}\n` +
        `  Acquired:    ${existing.acquired_at}\n` +
        `  Last beat:   ${existing.last_heartbeat || existing.acquired_at} (${ageHumanReadable(age)} ago)\n` +
        `  This agent:  session=${shortId(sessionId)} pid=${process.ppid}\n` +
        `\n` +
        `  Per .claude/rules/multi-agent-coordination.md §1-§2, two agents on the\n` +
        `  same worktree is a coordination gap. Work may compose by luck (Phase 3.5)\n` +
        `  or collide silently. Resolve before editing files.\n` +
        `\n` +
        `  Options:\n` +
        `    • Solo (recommended): exit this session and let the other agent finish.\n` +
        `    • Split scope: coordinate explicitly, then ` +
        `\`rm "${lockFile}"\` to clear.\n` +
        `    • Force-acquire (you know the other session is dead): ` +
        `\`rm "${lockFile}"\` then restart this session.\n` +
        `\n`,
    );
    // Don't write our lock — leave the existing one intact so the active
    // session's heartbeats keep refreshing it. Only write on takeover or
    // first acquire.
    process.exit(0);
  } catch (err) {
    // Hooks must never crash session start.
    process.stderr.write(
      `[worktree-lock] hook error (non-fatal): ${err.message}\n`,
    );
    process.exit(0);
  }
}

main();
