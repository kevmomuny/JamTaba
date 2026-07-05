#!/usr/bin/env node
/**
 * root-integrity-pulse — SessionStart hook.
 *
 * Detects silent filesystem damage to the ROOT checkout: unstaged deletions
 * of tracked files (` D ` in porcelain status) under load-bearing paths.
 * Damage found → loud session-start message with the exact restore command.
 *
 * Origin: 2026-07-04 incident — packages/calculation-engine (34 files, the
 * pricing SSOT) + packages/settings (8 files, FROZEN rates) were found
 * physically deleted from the root working tree, mechanism unidentified
 * (every scripted rm across all session transcripts was correctly scoped;
 * Git Bash rm and PS 5.1 Remove-Item both verified junction-safe). The
 * damage sat silent until a test run tripped over it. This pulse converts
 * that silence into a session-start alert.
 *
 * Fail-open: any error exits 0 with a stderr note — the pulse must never
 * brick a session. Scoped to the root checkout only; worktree sessions
 * check the same root (damage there affects everyone).
 */

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Load-bearing prefixes: an unstaged deletion under any of these is never
// routine work-in-progress in the root checkout (agents edit in worktrees;
// the root is Kevin's interactive shell + deploy source).
const PROTECTED_PREFIXES = [
  'packages/',
  'apps/api/src/',
  'apps/web/src/',
  'config/',
  '.claude/hooks/',
  '.claude/rules/',
];

function findRoot() {
  // The hook file lives at <root>/.claude/hooks/ — but when invoked from a
  // worktree, __dirname is the worktree copy. Resolve the MAIN checkout via
  // git (first line of `git worktree list` is always the main working tree).
  try {
    const out = execFileSync(
      'git',
      ['-C', path.resolve(__dirname, '..', '..'), 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    const m = out.match(/^worktree (.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function main() {
  try {
    const root = findRoot();
    if (!root || !fs.existsSync(root)) {
      process.exit(0);
    }

    const porcelain = execFileSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    // ` D path` = deleted in working tree, not staged — filesystem-level
    // damage or an in-progress manual removal. Staged deletions (`D  `) are
    // deliberate git work and are NOT flagged.
    const deletions = [];
    for (const line of porcelain.split('\n')) {
      if (!line.startsWith(' D ')) continue;
      let file = line.slice(3).trim();
      // Porcelain C-quotes paths containing special/non-ASCII chars
      // (` D "pack\303\244ges/x"`); unquote or the prefix match misses them.
      if (file.startsWith('"') && file.endsWith('"')) {
        file = file
          .slice(1, -1)
          .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
          .replace(/\\([\\"tnr])/g, (_, c) => ({ '\\': '\\', '"': '"', t: '\t', n: '\n', r: '\r' })[c]);
      }
      if (PROTECTED_PREFIXES.some((p) => file.startsWith(p))) deletions.push(file);
    }

    if (deletions.length === 0) process.exit(0);

    // Group by top-two path segments so 34 files read as one line.
    const groups = new Map();
    for (const f of deletions) {
      const key = f.split('/').slice(0, 2).join('/');
      groups.set(key, (groups.get(key) || 0) + 1);
    }

    process.stdout.write(
      `[root-integrity] ALERT — ${deletions.length} tracked file(s) deleted (unstaged) from the ROOT checkout under protected paths:\n`,
    );
    for (const [key, count] of groups) {
      process.stdout.write(`    • ${key}/ — ${count} file(s)\n`);
    }
    process.stdout.write(
      `  If this is not deliberate in-progress work, restore with:\n` +
        `    git -C ${root} restore -- ${[...groups.keys()].join(' ')}\n` +
        `  (Seed incident 2026-07-04: pricing SSOT silently deleted; see D-HARNESS-P2-* dec-log.)\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[root-integrity] hook error (non-fatal): ${err.message}\n`);
    process.exit(0);
  }
}

main();
