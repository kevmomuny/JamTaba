/**
 * worktree-zombie-killer
 *
 * Two roles in one file:
 *
 *   1. SessionEnd hook (default — input via stdin):
 *      Reads the session's `cwd` from the JSON payload. If cwd is inside a
 *      `.claude/worktrees/` directory, kills any orphan node-family
 *      processes whose CommandLine references that worktree path. Always
 *      exits 0 — never crash session shutdown.
 *
 *   2. Standalone helper (`node worktree-zombie-killer.cjs <worktree-path>`):
 *      Same kill logic, callable directly during sprint-completion before
 *      `git worktree remove`. Used by `/cleanup-worktrees` and by agents at
 *      "shipped" time per `.claude/rules/agentic-workflow.md` Sprint
 *      Completion Protocol.
 *
 * Why this exists:
 *   On Windows, `pnpm install` / `pnpm exec vitest` / `pnpm exec tsc`
 *   spawn child workers (esbuild daemons, vitest pool workers, tsc workers)
 *   that don't terminate when the Claude session that spawned them exits.
 *   They hold open file handles inside the worktree directory, so
 *   subsequent `git worktree remove` / `rm -rf` fail with "Device or
 *   resource busy" / "Permission denied". POSIX systems handle this via
 *   parent-death signal propagation; this hook is therefore a no-op
 *   outside `process.platform === 'win32'`.
 *
 * Safety:
 *   The kill match is a substring on the worktree directory name (e.g.
 *   "documents-spine-p4"). Worktree names are minimum 3 chars and are
 *   sprint-scoped, so they don't collide with other agents' worktrees or
 *   Kevin's interactive shell. Refuses to operate on names < 3 chars to
 *   prevent accidental broad sweeps.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const DEBUG = process.env.DEBUG_ZOMBIE_KILLER === '1';

function log(msg) {
  if (DEBUG) process.stderr.write(`[zombie-killer] ${msg}\n`);
}

function isInsideWorktree(p) {
  if (!p) return false;
  const norm = p.replace(/\\/g, '/');
  return norm.includes('/.claude/worktrees/');
}

function killWorktreeZombies(worktreePath) {
  if (!worktreePath) return { killed: 0, errors: ['no-path'] };

  if (process.platform !== 'win32') {
    log(`platform=${process.platform} — no-op (POSIX systems propagate SIGTERM)`);
    return { killed: 0, errors: [], skipped: 'non-windows' };
  }

  const wtName = path.basename(worktreePath.replace(/\\/g, '/'));
  if (!wtName || wtName.length < 3) {
    log(`refusing to match short worktree name: "${wtName}"`);
    return { killed: 0, errors: ['short-name-refused'] };
  }

  const ps = [
    `$ErrorActionPreference = 'Continue'`,
    `$pattern = '*\\${wtName}\\*'`,
    `$hits = Get-CimInstance Win32_Process | Where-Object {`,
    `  $_.CommandLine -and $_.CommandLine -like $pattern -and`,
    `  $_.Name -in @('node.exe','pnpm.cmd','pnpm.exe','vitest.cmd','esbuild.exe','tsc.exe','tsx.exe')`,
    `}`,
    `$killed = 0`,
    `$errs = @()`,
    `foreach ($p in $hits) {`,
    `  try {`,
    `    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop`,
    `    $killed++`,
    `  } catch {`,
    `    $errs += "PID $($p.ProcessId) ($($p.Name)): $($_.Exception.Message)"`,
    `  }`,
    `}`,
    `Write-Output "killed=$killed"`,
    `if ($errs.Count -gt 0) { Write-Output "errs=$($errs -join '|')" }`,
  ].join('\n');

  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', ps,
  ], { timeout: 15000, encoding: 'utf8' });

  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  log(`worktree=${wtName} stdout=${stdout} stderr=${stderr}`);

  const killedMatch = stdout.match(/killed=(\d+)/);
  const errsMatch = stdout.match(/errs=(.+)$/m);
  return {
    killed: killedMatch ? parseInt(killedMatch[1], 10) : 0,
    errors: errsMatch ? errsMatch[1].split('|') : (stderr ? [stderr] : []),
  };
}

async function runAsHook() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let data = {};
  try { data = JSON.parse(input); } catch { /* fail open */ }

  const cwd = data.cwd || '';
  if (!isInsideWorktree(cwd)) {
    log(`cwd "${cwd}" not inside a worktree — skipping`);
    process.exit(0);
  }

  const result = killWorktreeZombies(cwd);
  log(`SessionEnd cleanup: killed ${result.killed} for ${cwd}`);
  process.exit(0);
}

function runAsHelper(arg) {
  const result = killWorktreeZombies(arg);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

if (process.argv[2]) {
  runAsHelper(process.argv[2]);
} else {
  runAsHook().catch((e) => {
    log(`fatal: ${e.message}`);
    process.exit(0);
  });
}
