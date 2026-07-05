# Agentic Workflow

Kevin gives intent. Claude handles technical execution. (Ported from energen-os-suite — same contract, JamTaba-scoped.)

## Rules

1. **Intent Lock** — Restate goal in 2-3 sentences, confirm before starting non-trivial work.
2. **Intelligent Intake** — Research proactively, suggest approaches, don't ask questions the codebase already answers.
3. **Phase Gates** — Decompose into phases, execute autonomously. Only stop for Tier-1 decisions, dead ends, or mission-killing discoveries.
4. **Self-Correct** — Absorb unexpected findings and adjust. Don't pause unless the goal itself is no longer achievable.
5. **Problem Solve** — When an approach fails, try a genuinely different path (not a tweak). Two different failures = surface the blocker.
6. **Close the Loop** — Verify output against intent, summarize plainly, curate knowledge for future sessions.

## Decision Tiers

- **Tier 1 (Kevin decides):** Feature direction, UX, whether/what to publish upstream or publicly, money
- **Tier 2 (Agent decides, informs Kevin):** Technical implementation, architecture, testing, dependencies
- **Tier 3 (Agent recommends, Kevin confirms):** Long-term architectural changes, costly tool/service selection

## Build vs. Solve

- **Solving** (research, one-off scripts, analysis): be resourceful, duct tape is fine
- **Building** (features in the codebase): be rigorous, follow established patterns

## Quality Gates

1. **Spec before code** — Non-trivial features get a spec (`.claude/templates/feature-spec.md`) first. Trivial = single-file change with obvious intent.
2. **Done means verified** — "Done" requires verification from a second source (the app actually launched and exercised, not just "compiled clean"). For an audio app that means: build → launch → the affected surface exercised (audio stream running, plugin loaded, UI panel opened).
3. **Foundation Justification** — Any new external dependency answers: what fails it in 12 months, standards posture, error contract, swap cost (see energen agentic-workflow Gate #9 for the template; same table format).
4. **Forbidden completion claims** — Never "should work", "appears to work", "seems correct". State what was verified and how.
5. **No bandaids** — Fixes are permanent and system-aware, never test-appeasing workarounds. Never loosen an assertion to go green.

## Sprint Completion Protocol (SCP)

Same contract as energen-os-suite: Build → Drift audit (spec line-by-line vs built, table committed to `.claude/plans/`) → Fix → Re-audit → Curate (brv, this repo's own context tree) → Queue-append (Tier-1 items to `.claude/plans/tier-1-deferred-queue.md`) → Reclaim worktree → Declare done only with cited evidence for every step. Never flip `sprint_complete: true` with steps missing. Reconcile-then-append governs every durable write: update/supersede prior artifacts on the same concern, never stack near-duplicates.

## Phase Reset Protocol

Reset at phase boundaries (Build → Audit → Fix → Curate), at ~25 turns, or when switching research↔build mode. Write the phase summary to `.claude/plans/` (reconcile-then-append), start the next session from the summary, never carry raw history forward. Research mode and build mode never mix in one conversation.

## Testing honesty

"e2e" means the real code path in the real configuration with real dependencies, and the result states which code/config actually ran. For JamTaba: a real launch of the built exe, a real audio device, a real plugin, a real NINJAM server connection where relevant. A faked hop makes it a unit/integration test — fine, but never counted as e2e. A skip reads "not validated", never a silent green.
