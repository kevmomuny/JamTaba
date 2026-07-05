/**
 * SessionStart + Stop Hook: Active Agents Registry
 *
 * Maintains a single shared registry of all active Claude Code sessions
 * across worktrees, satisfying multi-agent-coordination.md v2 §3 (active-agent
 * registry). Replaces the 4-command pre-flight checklist (git worktree list +
 * gh pr list + git log --not origin/main + brv query) with one read of the
 * registry file.
 *
 * Registry location: <main_worktree>/.claude/state/active-agents.jsonl
 * Format: JSONL (one JSON object per line). Gitignored.
 *
 * Modes (passed as argv[2]):
 *   register   — SessionStart: append entry for this session, refresh if exists
 *   unregister — Stop: remove entry for this session
 *
 * Concurrency: read → filter-our-line → append → temp-write → atomic-rename.
 * Worst case race = one update dropped, corrected on next session start.
 *
 * Origin: multi-agent-protocol-v2 Phase 2 (PR follow-up to #261). Closes the
 * "inferred-from-4-cmds" race window in pre-flight.
 *
 * NEVER crashes the session. Hooks must always exit 0 on error per Claude
 * Code hook contract.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findMainWorktreeRoot(startDir) {
  // git worktree list --porcelain: first 'worktree <path>' entry is main.
  try {
    const out = execSync('git worktree list --porcelain', {
      cwd: startDir || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/^worktree (.+)$/m);
    if (m) return m[1].trim();
  } catch {
    // git not available or not a repo — fall through.
  }
  return findWorktreeRoot(startDir);
}

function findWorktreeRoot(startDir) {
  let cwd = startDir || process.cwd();
  while (cwd && cwd !== path.dirname(cwd)) {
    if (fs.existsSync(path.join(cwd, '.git'))) return cwd;
    cwd = path.dirname(cwd);
  }
  return startDir || process.cwd();
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

function readFilesOwned(worktreeRoot) {
  const ownedFile = path.join(worktreeRoot, '.claude', 'files_owned.txt');
  if (!fs.existsSync(ownedFile)) return [];
  try {
    return fs
      .readFileSync(ownedFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function readRegistry(registryFile) {
  if (!fs.existsSync(registryFile)) return [];
  try {
    return fs
      .readFileSync(registryFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

function writeRegistryAtomic(registryFile, entries) {
  const dir = path.dirname(registryFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${registryFile}.tmp.${process.pid}.${Date.now()}`;
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  const finalBody = body.length > 0 ? body + '\n' : '';
  fs.writeFileSync(tmpFile, finalBody);
  fs.renameSync(tmpFile, registryFile);
}

async function readStdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  try {
    const mode = process.argv[2];
    if (mode !== 'register' && mode !== 'unregister') {
      process.stderr.write(
        `[active-agents] usage: active-agents-update.cjs register|unregister\n`,
      );
      process.exit(0);
    }

    const stdin = await readStdinJson();
    const sessionId =
      stdin.session_id ||
      stdin.sessionId ||
      `pid-${process.ppid}-${Date.now()}`;

    const cwdHint = stdin.cwd || process.cwd();
    const currentWorktree = findWorktreeRoot(cwdHint);
    const mainWorktree = findMainWorktreeRoot(cwdHint);
    const registryFile = path.join(
      mainWorktree,
      '.claude',
      'state',
      'active-agents.jsonl',
    );

    const entries = readRegistry(registryFile);
    let otherEntries = entries.filter((e) => e.session_id !== sessionId);

    // Prune dead-PID ghost entries (hard-killed / crashed sessions never run
    // their Stop hook). Keeps the registry trustworthy for /cleanup-worktrees
    // + pre-flight — a stale "active" entry is the false-positive that caused
    // the 2026-05-23 worktree-cleanup incident. Single-source the liveness
    // logic via the reader lib; never let a pruning error break the hook.
    try {
      const { prune } = require('../lib/active-agents.cjs');
      otherEntries = prune(otherEntries).live;
    } catch {
      /* keep unpruned on any error — hook must never crash */
    }

    if (mode === 'unregister') {
      // Remove our session, write back. Quiet exit.
      writeRegistryAtomic(registryFile, otherEntries);
      process.exit(0);
    }

    // mode === 'register'
    const now = new Date().toISOString();
    const existing = entries.find((e) => e.session_id === sessionId);
    const entry = {
      session_id: sessionId,
      pid: process.ppid,
      branch: readBranch(currentWorktree),
      worktree: currentWorktree,
      files_owned: readFilesOwned(currentWorktree),
      started: existing?.started || now,
      last_beat: now,
      status: 'in-progress',
    };

    writeRegistryAtomic(registryFile, [...otherEntries, entry]);

    // Show banner if other agents are active in different worktrees.
    const others = otherEntries.filter(
      (e) => e.worktree && e.worktree !== currentWorktree,
    );
    if (others.length > 0) {
      const lines = others.map((e) => {
        const beat = e.last_beat || e.started || 'unknown';
        const sid = String(e.session_id).slice(0, 8);
        return `    • session=${sid} branch=${e.branch} worktree=${path.basename(e.worktree)} last_beat=${beat}`;
      });
      process.stdout.write(
        `[active-agents] ${others.length} other session${others.length === 1 ? '' : 's'} active in this repo:\n${lines.join('\n')}\n`,
      );
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`[active-agents] hook error (non-fatal): ${err.message}\n`);
    process.exit(0);
  }
}

main();
