/**
 * PreToolUse Hook: Worktree Strict Guard
 *
 * Blocks Edit/Write/NotebookEdit when file_path is in a root checkout
 * (not inside .claude/worktrees/). Forces edits to happen in a sibling
 * worktree per multi-agent-coordination.md §2.
 *
 * Origin: closes the deferral pattern surfaced 2026-05-06 where the
 * authoring agent edited in the root checkout and rationalized
 * "another agent's lane" while own work sat uncommitted. PRs #81 + #82
 * shipped this concept 2026-04-27 but pre-dated multi-agent v2; this
 * is the v2-aligned reimplementation.
 *
 * Escape hatch: ENERGEN_AGENT_BYPASS_WORKTREE=1 (intended for emergency
 * hotfixes only). Bypass usage should be logged in the dec-log entry.
 *
 * Plan-mode exception (2026-05-20, D-HARNESS-PLAN-MODE-FIX): plan-mode
 * auto-generates a plan file at <root>/.claude/plans/<random-slug>.md
 * where the slug is a 3-word kebab adjective-verb-noun pattern
 * (e.g. clever-cuddling-snowflake.md). These files are single-agent
 * scratch space — not shared infra and not a multi-agent collision
 * risk — but Claude Code's plan-mode harness insists on writing them
 * at root, not in a sibling worktree. This hook exempts NEW writes
 * that match the slug pattern AND aren't real sprint documents. See
 * multi-agent-coordination.md §13 "Plan-mode exception" + failure-mode
 * catalog "Harness-rule vs framework-feature collision" row.
 *
 * Logic:
 *   - Approve all non-Edit/Write/NotebookEdit tools.
 *   - Approve when ENERGEN_AGENT_BYPASS_WORKTREE=1.
 *   - Approve when file_path is OUTSIDE the project (e.g., user home dir).
 *   - Approve when file_path is INSIDE a sibling worktree
 *     (path contains /.claude/worktrees/).
 *   - Approve when file_path matches the plan-mode slug pattern (3-word
 *     kebab .md under .claude/plans/) AND filename doesn't match any
 *     sprint-doc suffix (-master, -postmortem, -architecture, etc.).
 *     Layer 2 auto-emits a dec-log marker for auditability.
 *   - BLOCK otherwise (file_path is inside a root checkout).
 *
 * The hook never crashes — on any error it approves (fail-open) so the
 * agent doesn't get stuck.
 */
const fs = require('node:fs');

const ROOT_CHECKOUTS_LOWERCASE = [
  'c:/dev/jamtaba',
  '/c/dev/jamtaba',
  
];

const WORKTREE_MARKER = '/.claude/worktrees/';
const PLANS_DIR_MARKER = '/.claude/plans/';

// Plan-mode slug pattern: 3 kebab-case lowercase words, .md extension.
// Examples that MATCH: clever-cuddling-snowflake.md, harmonic-conjuring-mochi.md
const PLAN_MODE_SLUG_REGEX = /^[a-z]+-[a-z]+-[a-z]+\.md$/;

// Suffix exclusions: real sprint documents that happen to be 3-word kebab.
// Examples we MUST keep BLOCKING:
//   ui-witness-master.md, cdcr-bid-master.md, cdcr-bid-postmortem.md,
//   gentracker-sprint-protocol.md, mobile-geospatial-report.md,
//   sales-workspace-architecture.md, photo-surface-matrix.md,
//   next-session-prompt.md, dispatcher-fixes-kickoff.md.
// Suffixes derived from existing .claude/plans/ inventory 2026-05-20.
const SPRINT_DOC_SUFFIX_REGEX = new RegExp(
  '-(' +
    [
      'master',
      'summary',
      'audit',
      'findings',
      'research',
      'postmortem',
      'architecture',
      'protocol',
      'matrix',
      'prompt',
      'kickoff',
      'report',
      'spec',
      'deferred',
      'followups',
      'wip',
      'plan',
      'sprint',
      'roadmap',
      'gate',
      'inventory',
      'baseline',
      'review',
      'notes',
      'todo',
      'tracker',
      'status',
      'index',
      'registry',
      'cleanup',
      'policy',
      'schema',
      'design',
    ].join('|') +
    ')\\.md$'
);

// Don't use path.resolve — it mangles Windows-style absolute paths
// (C:\foo) when the hook runs under bash on Windows. Edit/Write tool
// calls always pass absolute file_path strings, so we just normalize
// slashes + case and compare directly.
function normalize(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInRootCheckout(filePath) {
  const norm = normalize(filePath);
  if (!norm) return false;
  if (norm.includes(WORKTREE_MARKER)) return false;
  for (const root of ROOT_CHECKOUTS_LOWERCASE) {
    if (norm === root || norm.startsWith(root + '/')) return true;
  }
  return false;
}

/**
 * Plan-mode exception: returns true when file_path is a 3-word kebab
 * slug file directly under .claude/plans/ AND does NOT match any
 * known sprint-doc suffix.
 *
 * Strict checks (all must pass):
 *   1. Path is under a root checkout's .claude/plans/ directory.
 *   2. Filename matches ^[a-z]+-[a-z]+-[a-z]+\.md$ (3-word kebab).
 *   3. Filename does NOT match any known sprint-doc suffix
 *      (master, summary, audit, postmortem, architecture, research,
 *      protocol, matrix, kickoff, prompt, report, spec, etc.).
 *   4. Parent dir is exactly .claude/plans/ (not a nested subdir).
 *
 * Why no existsSync check: was considered (spec proposed it as a
 * safeguard against accidental over-match) but rejected because
 * plan-mode does both Write (create) AND subsequent Edit operations
 * on the same file. Existence-blocking-Edit would break Edit-after-
 * Write. The suffix exclusion list is the load-bearing protection;
 * inventory of existing .claude/plans/ files 2026-05-20 confirmed
 * every non-plan-mode 3-word file has one of the listed suffixes.
 */
function isPlanModeFile(filePath) {
  if (!filePath) return false;
  const norm = normalize(filePath);
  if (!norm) return false;
  if (!norm.includes(PLANS_DIR_MARKER)) return false;

  // Filename = basename of normalized path
  const filename = norm.split('/').pop();
  if (!filename) return false;
  if (!PLAN_MODE_SLUG_REGEX.test(filename)) return false;
  if (SPRINT_DOC_SUFFIX_REGEX.test(filename)) return false;

  // Parent dir must be exactly .claude/plans/ — reject nested paths
  // like .claude/plans/some-sprint/clever-cuddling-snowflake.md.
  const parentEnd = norm.lastIndexOf('/' + filename);
  if (parentEnd < 0) return false;
  const parent = norm.slice(0, parentEnd);
  if (!parent.endsWith('/.claude/plans')) return false;

  return true;
}

/**
 * Layer 2: auto-emit dec-log marker when plan-mode exception fires.
 * Best-effort — failures are swallowed so the hook never blocks on
 * a logging error. Writes to the root checkout's .claude/decisions.jsonl
 * if writable; otherwise silently skips.
 */
function emitPlanModeDecLog(filePath) {
  try {
    // Test-mode opt-out: smoke tests set ENERGEN_HOOK_TEST_NO_LOG=1 to
    // avoid polluting .claude/decisions.jsonl on every test run.
    if (process.env.ENERGEN_HOOK_TEST_NO_LOG === '1') return;
    const origNorm = filePath.replace(/\\/g, '/');
    const idx = origNorm.toLowerCase().indexOf('/.claude/plans/');
    if (idx < 0) return;
    const rootPrefix = origNorm.slice(0, idx);
    const target = rootPrefix + '/.claude/decisions.jsonl';
    const filename = origNorm.split('/').pop();
    if (!filename) return;
    const slug = filename.replace(/\.md$/i, '');
    const entry =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        scope: 'harness',
        id: 'D-PLAN-MODE-' + slug.toUpperCase(),
        what:
          'worktree-strict-guard plan-mode exception fired: agent wrote ' +
          filePath +
          ' at root via plan-mode slug pattern',
        why:
          'Plan-mode harness writes auto-generated slug files at root, not in a worktree. Hook exempts new 3-word slug files under .claude/plans/. See multi-agent-coordination.md §13.',
        verify:
          'ls ' + filePath + ' returns the file; cat first line confirms agent authored it.',
      }) + '\n';
    fs.appendFileSync(target, entry, { encoding: 'utf8' });
  } catch (_err) {
    // best-effort — never block the hook on a logging failure
  }
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;

    const data = JSON.parse(input || '{}');
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const filePath = toolInput.file_path || toolInput.notebook_path || '';

    if (!['Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    if (process.env.ENERGEN_AGENT_BYPASS_WORKTREE === '1') {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    if (!isInRootCheckout(filePath)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    // Plan-mode exception (Layer 1) + dec-log auto-emit (Layer 2).
    if (isPlanModeFile(filePath)) {
      emitPlanModeDecLog(filePath);
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `Refusing to edit in root checkout: ${filePath}\n\n` +
        `Per multi-agent-coordination.md §2: every agent edits files inside its own sibling worktree, never in the root checkout (reserved for Kevin's interactive shell + the canonical build output).\n\n` +
        `Create a worktree first:\n` +
        `  git worktree add .claude/worktrees/<sprint-name> -b fix/<short-name>\n` +
        `  cd .claude/worktrees/<sprint-name>\n\n` +
        `Then edit the file at the worktree path. Or set ENERGEN_AGENT_BYPASS_WORKTREE=1 for emergency hotfixes (log the bypass in your dec-log entry).`
    }));
    process.exit(0);
  } catch (err) {
    // fail-open — never crash on input parse errors
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }
}

main();
