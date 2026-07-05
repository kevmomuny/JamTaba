# JamTaba 2 — Kevin's fork (side project)

Open-source NINJAM jam client (C++ / Qt 5, qmake). Upstream `elieserdejesus/JamTaba` is
dormant (last commit Oct 2021, last release 2.1.16 Aug 2020) and has **no license file** —
personal use and local dev are fine; **publishing anything (fork remote, releases, upstream
PRs) is Tier-1, Kevin decides.** This clone carries our Win x64 revival work.

## Working build (verified 2026-07-05)

- Branch `fix/win64-msvc2019-build`. Output: `build\Standalone\release\Jamtaba2.exe`
  (+ `VstScanner.exe`; windeployqt already staged — the folder runs as-is).
- **Rebuild:** `cmd /c C:\dev\compat\build-compat.cmd` (vcvars64 → qmake → jom).
  Full recipe + qmake/jom paths: `docs-dev/BUILD-WINDOWS.md`.
- Toolchain: VS Build Tools 2019 (MSVC 14.29) · Qt 5.15.2 `msvc2019_64` at `C:\Qt` · jom at `C:\dev\jom`.
- Deps (gitignored, in place): `libs/` + `VST_SDK/` from the README Dropbox links; ASIO SDK at
  `C:\dev\ASIOSDK`. Libs rebuilt for MSVC2019: portaudio (@`396fe4b6`, the official exe's exact
  commit), stackwalker, ogg 1.3.5, vorbis 1.3.7 (+`vorbisenc` now linked), miniupnpc 2.0, and
  `compat.lib` UCRT shims. Old 2013 libs kept as `*.msvc2013.bak`. ffmpeg/x264/minimp3/vorbisfile
  2013 COFF libs still linked as-is.
- Landmark fix already shipped: `VstHost::hostCallback` 64-bit signature (`VstIntPtr`, was `long`
  → `audioMasterGetTime` pointer truncation → crashed AmpliTube 5/TONEX). Don't regress this.

## Verification standard

"Done" = built exe **launched and exercised**: window up, audio stream running on the real
device (Focusrite USB ASIO, 128 @ 96 kHz), the affected surface exercised, and
`%APPDATA%\Jamtaba 2\log.txt` shows zero `CRITICAL` lines. Compiling clean is not done.
Config backups live next to the config; never test destructive config changes without one.
Current IK-generation MODO plugins crash the VST2 host at load — keep them out of test chains;
AmpliTube 5 + TONEX are the standard plugin-hosting test pair.

## Layout

| Path | What |
|------|------|
| `PROJECTS/` | qmake projects: `Standalone/` (the app), `VstScanner/`, `VstPlugin/` (needs static Qt — not built), `Jamtaba-common.pri` |
| `src/Common/` | shared core: audio engine, ninjam client, gui, VST host (`vst/VstHost.cpp`) |
| `src/Standalone/` | standalone app: portaudio/rtmidi drivers, VST loading, main window |
| `tests/auto/` | QtTest unit tests (`qmake CONFIG+=test tests/auto/<t>/<t>.pro && make && ./<t>`) |
| `libs/`, `VST_SDK/` | gitignored binary deps (see build recipe) |
| `.claude/` | harness (ported from energen-os-suite — same contracts) |

## Conventions

- Qt Coding Style (uncrustify.cfg in repo). Match surrounding code; this is a 2016 codebase —
  don't modernize wholesale, fix surgically.
- 4-space indent C++ (match existing files), `CONFIG += c++11` — don't introduce >C++11 features
  without a deliberate toolchain decision.
- Commit messages: imperative, 50-char subject, `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.
- Never force push. `origin` (upstream) is read-only — no pushes there, ever.
- Windows FS gotcha: `src/resources/emoji/categories/` has a `Recent.png`/`recent.png` case
  collision — one is missing on Windows checkouts; expect a benign resource warning.

## Harness (same as energen-os-suite)

- **Worktree discipline:** root checkout is Kevin's; agents edit in `.claude/worktrees/<name>`
  (enforced by `worktree-strict-guard`, exit 2). Full protocol: `.claude/rules/multi-agent-coordination.md`.
- **Workflow contract:** `.claude/rules/agentic-workflow.md` (Intent Lock, Quality Gates, SCP,
  Phase Reset). Spec template: `.claude/templates/feature-spec.md`.
- **Decisions:** `.claude/decisions/<topic>.jsonl`, append-only shards.
- **Plans:** `.claude/plans/` (plansDirectory).
- **Agents:** builder / code-reviewer / debugger / planner / security-reviewer (`.claude/agents/`).
- **brv:** this repo gets its own context tree (`brv` from repo root); same curate/query contract
  as energen (`gemini-3-flash-preview`, local-only). Loop pulses: `.claude/rules/loop-protocol.md`.

## Backlog seeds (upstream's most-wanted, all unfixed there)

1. HiDPI scaling ("Display enormous", upstream #1426) — Kevin's 4K machine reproduces it.
2. Settings-dialog crash on 2.1.16 (upstream #1419).
3. License outreach to upstream (blocks publishing a revived fork).
