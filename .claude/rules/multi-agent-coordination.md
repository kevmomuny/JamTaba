# Multi-Agent Coordination

Ported from energen-os-suite; same protocol, JamTaba paths. Applies when two or more Claude agents work on this repo at the same time.

## 1 · Pre-flight discovery (every new session)

```bash
git worktree list
git fetch origin 2>/dev/null || true   # origin = upstream elieserdejesus/JamTaba (read-only)
git log --oneline --all --max-count 10
node .claude/lib/active-agents.cjs list   # live agents, dead-PID-pruned
```

If another agent has an active worktree or branch touching the files you're about to edit, stop and message Kevin instead of racing.

## 2 · Branch & worktree discipline

- **One branch per work item**: `fix/<short-name>` or `feature/<short-name>`.
- **One worktree per active agent — MANDATORY for any non-trivial edit.** The root checkout (`C:/dev/JamTaba`, `/c/dev/jamtaba`) is reserved for Kevin's interactive shell and the canonical build output. Agents create a worktree at `.claude/worktrees/<name>` before editing. Enforced by the `worktree-strict-guard` PreToolUse hook (exit 2 block; bypass `ENERGEN_AGENT_BYPASS_WORKTREE=1` for emergencies — dec-log the bypass).
- **Never push from the wrong working tree.** `git -C <worktree> push` with HEAD verified in the same command. The `root-push-guard` hook blocks pushes whose effective repo dir is the root checkout (bypass `ENERGEN_PUSH_GUARD_BYPASS=1`, dec-log it).
- Rebase on the integration branch at session start and before every push.

## 3 · Shared registries

- `.claude/decisions/<topic>.jsonl` — one JSON line per notable decision; per-topic shards, append-only, never edit existing lines.
- `PROJECTS/*.pro` / `.pri` files are the qmake registry equivalent — coordinate before concurrent edits; they are not append-only.

## 4 · Decomposition gate (before parallel deployment)

Before launching parallel agents on related work, answer in writing (`.claude/plans/<work>-decomp.md`): Independence? Interface freeze? Per-agent verification path? Merge order? A "no" or "unclear" on any row means run sequentially instead.

## 5 · Handoff format

Teammate → lead reports use the structured YAML handoff (status / files_changed / verifications_run / unresolved / follow_ups) — never free prose.

## 6 · Lead takeover signal

Before the lead touches a teammate's worktree: SendMessage `"I'm taking it. Stand by — do not start fixes."` Takeover = commit freeze; one agent commits at a time.

## 7 · Upstream relationship

`origin` = `elieserdejesus/JamTaba` (dormant, unlicensed — treat as read-only; we never push there). Local integration branch: `fix/win64-msvc2019-build` (or its successor). Publishing anything (fork remote, releases, PRs upstream) is Tier-1 — Kevin decides.
