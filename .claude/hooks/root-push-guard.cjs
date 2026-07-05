/**
 * PreToolUse Hook: Block `git push` whose effective repo dir is the ROOT
 * checkout. Exit 2 = block (npm-guard convention for the Bash matcher chain).
 *
 * Origin: D-GMAIL-SYNC-WIREUP-MAIN-FORCEPUSH-INCIDENT (2026-06-06, PR #962).
 * A bash cwd left at the root checkout by `brv curate` + a bare
 * `git push --force-with-lease` rewound origin/main ~60s (HEAD was main +
 * a fresh lease — the lease does not protect against the wrong checkout).
 * Restored same turn; this hook is the mechanical layer of
 * feedback_push_pin_cwd_branch ("NEVER bare git push after any cd: pin to
 * worktree via git -C + verify HEAD branch in the same command").
 *
 * Contract:
 *   - BLOCK  `git push` when the effective directory is the root checkout
 *            (C:/energen-os-suite, /c/energen-os-suite,
 *            /home/kherney/energen-os-suite) — whether via the session cwd,
 *            a `cd <root>` earlier in the compound command, or an explicit
 *            `git -C <root> push`.
 *   - APPROVE pushes pinned to a sibling worktree (path contains
 *            /.claude/worktrees/), pushes outside the project, and every
 *            non-push command.
 *   - APPROVE when ENERGEN_PUSH_GUARD_BYPASS=1 (recovery pushes like the
 *            #962 restore are legitimately root-located — dec-log the bypass).
 *   - Fail-open on any parse/IO error; never bricks the session.
 *
 * Known limit (accepted): effective-dir inference for compound commands is
 * a last-`cd` heuristic. The incident class this closes is the bare push
 * with a stale cwd, which the cwd check covers exactly.
 */

const ROOT_PATTERNS = [
  /^c:[\/]dev[\/]jamtaba$/i,
  /^[\/]c[\/]dev[\/]jamtaba$/i,
];

function normalize(p) {
  if (!p) return '';
  return String(p)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

function isRootCheckout(p) {
  const n = normalize(p);
  if (!n) return false;
  if (n.includes('/.claude/worktrees/')) return false;
  return ROOT_PATTERNS.some((re) => re.test(n.replace(/\//g, '/')));
}

// `push` must be the git SUBCOMMAND, not an argument to another subcommand
// (`git stash push -- <paths>` is a stash, not a push — FP field-hit
// 2026-07-04, D-HARNESS-P2-PUSHGUARD-FP). Between `git` and `push` only
// global options may appear: -C <path>, -c <k=v>, and --flag[=value] forms.
const GIT_GLOBAL_OPTS =
  String.raw`(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+|-c\s+\S+\s+|--[\w-]+(?:=(?:"[^"]+"|'[^']+'|\S+))?\s+)*`;
const GIT_PUSH_RE = new RegExp(String.raw`\bgit\s+${GIT_GLOBAL_OPTS}push\b`);

// A push inside an ssh remote-command string executes on the REMOTE host,
// never in a local checkout — blank those spans before detection (FP
// field-hit 2026-07-04, D-HARNESS-P3-PUSHGUARD-SSH-FP: `ssh energen-server
// '... git push ...'` blocked off the LOCAL root cwd). Keeps length so any
// match indices stay meaningful.
function blankSshRemoteCommands(command) {
  return command.replace(
    /\bssh\s+(?:-\S+\s+)*\S+\s+((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")+)/g,
    (m, quoted) => m.slice(0, m.length - quoted.length) + ' '.repeat(quoted.length),
  );
}

/** Effective dir for the `git push` in `command`, given the session cwd. */
function effectivePushDir(command, cwd) {
  // Explicit -C pin wins: `git -C <path> [global opts] push ...`
  const cPin = command.match(
    new RegExp(String.raw`git\s+${GIT_GLOBAL_OPTS}-C\s+("[^"]+"|'[^']+'|\S+)\s+${GIT_GLOBAL_OPTS}push\b`),
  );
  if (cPin) return normalize(cPin[1]);
  // Otherwise the last `cd <path>` before the push (compound commands),
  // else the session cwd.
  const pushIdx = command.search(GIT_PUSH_RE);
  const prefix = pushIdx > 0 ? command.slice(0, pushIdx) : '';
  const cds = [...prefix.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)];
  if (cds.length > 0) return normalize(cds[cds.length - 1][1]);
  return normalize(cwd);
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const data = JSON.parse(input);
    if ((data.tool_name || 'Bash') !== 'Bash') process.exit(0);

    const command = blankSshRemoteCommands((data.tool_input || {}).command || '');
    if (!GIT_PUSH_RE.test(command)) process.exit(0);

    if (process.env.ENERGEN_PUSH_GUARD_BYPASS === '1') process.exit(0);

    const dir = effectivePushDir(command, data.cwd || process.cwd());
    if (isRootCheckout(dir)) {
      process.stderr.write(
        `BLOCKED: git push with the ROOT checkout as effective dir (${dir}). ` +
          `The root checkout is Kevin's shell — its HEAD is not yours to push ` +
          `(seed incident: main force-push rewind, PR #962). ` +
          `Pin the push to your worktree: git -C <worktree> push ... and verify HEAD in the same command ` +
          `(git -C <worktree> rev-parse --abbrev-ref HEAD). ` +
          `Legitimate root-located recovery pushes: re-run with ENERGEN_PUSH_GUARD_BYPASS=1 and dec-log the bypass.`,
      );
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.exit(0); // fail-open — never brick the session
  }
}

main();
