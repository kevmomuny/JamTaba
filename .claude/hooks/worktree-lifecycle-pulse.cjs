/**
 * SessionStart Hook: Worktree Lifecycle Pulse
 *
 * Multi-agent-coordination v2 §4 (worktree lifecycle policy).
 *
 * Two responsibilities:
 *   1. Write `<worktree>/.claude/lifecycle.json` for the current worktree
 *      if missing (idempotent — never overwrites). Captures purpose, sprint
 *      name (parsed from branch), ttl_hours (default 7 days), reclaim_when
 *      conditions, owner_session, and created timestamp.
 *
 *   2. Walk ALL worktrees registered with `git worktree list`, read each
 *      one's lifecycle.json, evaluate reclaim conditions, and write back
 *      `reclaim_ready: true` + `reclaim_reason` for any that meet the
 *      criteria. The /cleanup-worktrees skill processes the resulting
 *      queue.
 *
 * Reclaim conditions (any one trips the flag):
 *   - pr_merged       — branch's PR is in MERGED state on GitHub
 *   - branch_deleted  — branch no longer exists on origin
 *   - ttl_exceeded    — no worktree-lock heartbeat in ttl_hours hours
 *
 * Origin: 2026-05-05 disk-pressure incident (35 stale worktrees consumed
 * 144 GB of C: drive). The reactive cleanup-worktrees skill captures the
 * "what happened" but doesn't prevent recurrence. This hook closes the
 * gap permanently — every worktree is auto-flagged when its work ships.
 *
 * Performance: runs gh + git ls-remote ONCE each (not per-worktree),
 * builds in-memory maps, and pulses each worktree O(1). Skipped on
 * `resume` matcher — only fires on `startup` once per session.
 *
 * Hook contract: NEVER crashes session start. All errors caught, exit 0.
 * 30s timeout in settings.json (gh + git ls-remote can take 5-10s each).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const lease = require('../lib/lease.cjs');

const DEFAULT_TTL_HOURS = 168; // 7 days
const RECLAIM_CONDITIONS = ['pr_merged', 'ttl_exceeded', 'branch_deleted'];

// Windows: git uses forward slashes, Node uses backslashes. Normalize for
// equality checks so "C:/foo" === "C:\\foo".
function normalizePath(p) {
  if (!p) return p;
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function findCurrentWorktreeRoot(startDir) {
  let cwd = startDir || process.cwd();
  while (cwd && cwd !== path.dirname(cwd)) {
    if (fs.existsSync(path.join(cwd, '.git'))) return cwd;
    cwd = path.dirname(cwd);
  }
  return startDir || process.cwd();
}

function findMainWorktreeRoot(startDir) {
  try {
    const out = execSync('git worktree list --porcelain', {
      cwd: startDir || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/^worktree (.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return findCurrentWorktreeRoot(startDir);
}

function listAllWorktrees(startDir) {
  try {
    const out = execSync('git worktree list --porcelain', {
      cwd: startDir || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const blocks = out.split(/\n\n+/);
    return blocks
      .map((block) => {
        const result = { worktree: null, branch: null, locked: false };
        block.split('\n').forEach((line) => {
          if (line.startsWith('worktree ')) {
            result.worktree = line.slice('worktree '.length).trim();
          } else if (line.startsWith('branch refs/heads/')) {
            result.branch = line.slice('branch refs/heads/'.length).trim();
          } else if (line === 'locked' || line.startsWith('locked ')) {
            result.locked = true;
          }
        });
        return result;
      })
      .filter((wt) => wt.worktree);
  } catch {
    return [];
  }
}

function readBranchAtWorktree(worktreeRoot) {
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

function sprintFromBranch(branch) {
  // sprint/<area>/phase-N-<short-name> → "<area>-phase-N-<short-name>"
  // anything else → as-is, sanitized
  if (!branch || branch === 'unknown') return 'unknown';
  const m = branch.match(/^sprint\/(.+)$/);
  if (m) return m[1].replace(/\//g, '-');
  return branch.replace(/\//g, '-');
}

function purposeFromBranch(branch) {
  if (!branch || branch === 'unknown') return 'unknown';
  if (branch.startsWith('sprint/')) return 'sprint';
  if (branch === 'main' || branch === 'master') return 'main';
  if (branch.startsWith('worktree-agent-')) return 'subagent';
  return 'feature';
}

function writeLifecycleIfMissing(worktreeRoot, sessionId) {
  const lifecycleFile = path.join(worktreeRoot, '.claude', 'lifecycle.json');
  if (fs.existsSync(lifecycleFile)) {
    return { state: 'exists', path: lifecycleFile };
  }
  const branch = readBranchAtWorktree(worktreeRoot);
  const lifecycle = {
    purpose: purposeFromBranch(branch),
    sprint: sprintFromBranch(branch),
    branch,
    ttl_hours: DEFAULT_TTL_HOURS,
    reclaim_when: [...RECLAIM_CONDITIONS],
    owner_session: sessionId,
    created: new Date().toISOString(),
  };
  try {
    const dir = path.dirname(lifecycleFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lifecycleFile, JSON.stringify(lifecycle, null, 2) + '\n');
    return { state: 'created', path: lifecycleFile, lifecycle };
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

function fetchMergedPRsByBranch() {
  const map = new Map();
  try {
    const out = execSync(
      'gh pr list --state merged --limit 100 --json headRefName,number,mergedAt',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const prs = JSON.parse(out);
    for (const pr of prs) {
      // Multiple PRs can share a head branch over time; keep the latest by mergedAt.
      const existing = map.get(pr.headRefName);
      if (!existing || new Date(pr.mergedAt) > new Date(existing.mergedAt)) {
        map.set(pr.headRefName, pr);
      }
    }
  } catch {
    // gh unavailable or no merged PRs — return empty map.
  }
  return map;
}

function fetchOriginBranches() {
  const set = new Set();
  try {
    const out = execSync('git ls-remote --heads origin', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    out.split(/\r?\n/).forEach((line) => {
      const m = line.match(/refs\/heads\/(.+)$/);
      if (m) set.add(m[1]);
    });
  } catch {}
  return set;
}

function fetchPushedBranches() {
  // Local remote-tracking refs (refs/remotes/origin/*) — proof a branch was
  // once pushed. Lets us distinguish "deleted from origin" (was-pushed +
  // not-on-origin) from "never pushed" (no-tracking-ref).
  const set = new Set();
  try {
    const out = execSync('git for-each-ref --format=%(refname:short) refs/remotes/origin', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    out.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'origin/HEAD') return;
      // refname:short emits "origin/<branch>"; strip the prefix.
      if (trimmed.startsWith('origin/')) set.add(trimmed.slice('origin/'.length));
    });
  } catch {}
  return set;
}

function evaluateReclaim(worktreeRoot, lifecycle, mergedPRs, originBranches, pushedBranches, liveBranch) {
  const reasons = [];

  // Branch truth = the worktree's CURRENT HEAD, never the creation-time
  // lifecycle.branch. Worktrees get re-pointed across sprint phases (P1
  // branch → P2 branch); the stale recorded branch produced mis-attributed
  // pr_merged flags on 2026-06-06 (3 of 3 flags cited the creation-time
  // branch's PR — one of them would have orphaned unmerged P2 code).
  const headBranch =
    (liveBranch && liveBranch !== 'unknown' ? liveBranch : null) ||
    readBranchAtWorktree(worktreeRoot);
  const branch =
    headBranch && headBranch !== 'unknown' ? headBranch : lifecycle.branch;
  if (branch && lifecycle.branch !== branch) {
    // Persist the refresh immediately so the displayed flag and any
    // downstream consumer (/cleanup-worktrees) see the real branch even
    // when no reclaim reason fires this pulse.
    lifecycle.branch = branch;
    lifecycle.sprint = sprintFromBranch(branch);
    const lifecycleFile = path.join(worktreeRoot, '.claude', 'lifecycle.json');
    try {
      fs.writeFileSync(lifecycleFile, JSON.stringify(lifecycle, null, 2) + '\n');
    } catch {}
  }

  // ttl_exceeded — based on max(worktree-lock.last_heartbeat, lifecycle.created)
  const lockFile = path.join(worktreeRoot, '.claude', 'worktree-lock.json');
  const lockState = lease.inspect({ resourceFile: lockFile });
  let lastActivityIso = lifecycle.created;
  if (lockState.exists && !lockState.corrupt && lockState.lock?.last_heartbeat) {
    const lockBeat = new Date(lockState.lock.last_heartbeat).getTime();
    const lifecycleCreated = new Date(lifecycle.created || 0).getTime();
    if (lockBeat > lifecycleCreated) {
      lastActivityIso = lockState.lock.last_heartbeat;
    }
  }
  const ageMs = Date.now() - new Date(lastActivityIso || 0).getTime();
  const ttlMs = (lifecycle.ttl_hours || DEFAULT_TTL_HOURS) * 3600 * 1000;
  if (ageMs > ttlMs && lifecycle.reclaim_when.includes('ttl_exceeded')) {
    const days = Math.floor(ageMs / (24 * 3600 * 1000));
    reasons.push(`ttl_exceeded (idle ${days}d)`);
  }

  // pr_merged
  if (lifecycle.reclaim_when.includes('pr_merged') && branch && branch !== 'main' && branch !== 'master') {
    const pr = mergedPRs.get(branch);
    if (pr) reasons.push(`pr_merged (#${pr.number})`);
  }

  // branch_deleted — branch was once pushed but is no longer on origin.
  // Never-pushed branches are local-only sandboxes; the TTL handles their
  // abandonment, not branch_deleted.
  if (lifecycle.reclaim_when.includes('branch_deleted') && branch && branch !== 'main' && branch !== 'master') {
    if (
      originBranches.size > 0 &&
      pushedBranches.has(branch) &&
      !originBranches.has(branch)
    ) {
      reasons.push('branch_deleted');
    }
  }

  return reasons;
}

function writeReclaimFlag(worktreeRoot, lifecycle, reasons) {
  if (reasons.length === 0) {
    // Clear any prior reclaim flags if conditions no longer hold (rare, but safe).
    if (lifecycle.reclaim_ready) {
      delete lifecycle.reclaim_ready;
      delete lifecycle.reclaim_reasons;
      delete lifecycle.reclaim_evaluated_at;
      const lifecycleFile = path.join(worktreeRoot, '.claude', 'lifecycle.json');
      try {
        fs.writeFileSync(lifecycleFile, JSON.stringify(lifecycle, null, 2) + '\n');
      } catch {}
    }
    return false;
  }
  lifecycle.reclaim_ready = true;
  lifecycle.reclaim_reasons = reasons;
  lifecycle.reclaim_evaluated_at = new Date().toISOString();
  const lifecycleFile = path.join(worktreeRoot, '.claude', 'lifecycle.json');
  try {
    fs.writeFileSync(lifecycleFile, JSON.stringify(lifecycle, null, 2) + '\n');
    return true;
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
      stdinJson.session_id ||
      stdinJson.sessionId ||
      `pid-${process.ppid}-${Date.now()}`;

    const cwdHint = stdinJson.cwd || process.cwd();
    const currentWorktree = findCurrentWorktreeRoot(cwdHint);
    const mainWorktree = findMainWorktreeRoot(cwdHint);

    // Step 1: write lifecycle.json for current worktree if missing.
    writeLifecycleIfMissing(currentWorktree, sessionId);

    // Step 2: only the main-worktree session pulses ALL worktrees. Sprint
    // worktrees skip the cross-worktree walk to avoid 14 sessions × 14
    // worktrees of pointless re-evaluation.
    if (normalizePath(currentWorktree) !== normalizePath(mainWorktree)) {
      process.exit(0);
    }

    const worktrees = listAllWorktrees(cwdHint);
    if (worktrees.length === 0) {
      process.exit(0);
    }

    const mergedPRs = fetchMergedPRsByBranch();
    const originBranches = fetchOriginBranches();
    const pushedBranches = fetchPushedBranches();

    const ready = [];
    const mainNorm = normalizePath(mainWorktree);
    for (const wt of worktrees) {
      // Skip locked agent worktrees and the main worktree itself.
      if (wt.locked) continue;
      if (normalizePath(wt.worktree) === mainNorm) continue;
      if (!wt.branch) continue;

      // Ensure lifecycle exists at this worktree (idempotent — won't overwrite).
      writeLifecycleIfMissing(wt.worktree, sessionId);

      const lifecycleFile = path.join(wt.worktree, '.claude', 'lifecycle.json');
      let lifecycle;
      try {
        lifecycle = JSON.parse(fs.readFileSync(lifecycleFile, 'utf8'));
      } catch {
        continue; // can't read — skip
      }

      const reasons = evaluateReclaim(wt.worktree, lifecycle, mergedPRs, originBranches, pushedBranches, wt.branch);
      const flagged = writeReclaimFlag(wt.worktree, lifecycle, reasons);
      if (flagged) {
        ready.push({
          worktree: wt.worktree,
          branch: wt.branch,
          reasons,
        });
      }
    }

    if (ready.length > 0) {
      process.stdout.write(
        `[lifecycle-pulse] ${ready.length} worktree${ready.length === 1 ? '' : 's'} ready for reclaim:\n`,
      );
      for (const r of ready) {
        process.stdout.write(
          `    • ${path.basename(r.worktree)} (${r.branch}) — ${r.reasons.join(', ')}\n`,
        );
      }
      process.stdout.write(
        `  Run /cleanup-worktrees to process the queue.\n`,
      );
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[lifecycle-pulse] hook error (non-fatal): ${err.message}\n`,
    );
    process.exit(0);
  }
}

main();
