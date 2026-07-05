<!--
  Trustworthy Memory — Curation Contract (P2).
  Author durable memory to this shape, not as freeform prose. Two machine-checkable gates read it:
    • memory-codification-gate.cjs (PreToolUse) — BLOCKS a write that makes an unsourced
      external-world numeric claim (wage/price/market) or discusses auth/access with no framing
      directive, or carries a policy-forbidden loaded term on a classified node path.
    • memory-readback-verify.cjs (--surfaced) — FLAGS a node whose pinned Canonical block or framing
      directive did not survive brv's consolidate/read-time summarizer unmodified.
  Both are 100% deterministic and FLAG-OR-BLOCK only — neither ever rewords your memory.
  Spec: .claude/plans/trustworthy-memory-spec.md + trustworthy-memory-p2-codification-gate.md
  safety_sanitized: true   (this template quotes loaded terms only as defensive examples)
-->
---
intent: <one line — what this node records and why it matters>
provenance:
  source_type: code | doc | human | agent-derived   # where the fact came from
  source_ref: <PR #, commit sha, file path, URL, IFB #, or DIR determination — or "none">
  verified: true | false                            # true only if re-checked against the cited source
forbidden: []        # OPTIONAL node-specific terms that must never appear here (adds to policy globals)
required: []         # OPTIONAL terms that MUST appear (e.g. a craft+county qualifier on a wage node)
safety_sanitized: false   # set true ONLY for genuine defensive-security nodes (exempts forbidden-term + framing checks)
---

## Canonical (authoritative framing — do not reword)

<The pinned fact(s), in the exact framing you mean. This block is the immutable anchor: the read-back
verifier asserts its first sentence survives brv's summarizer into the surfaced text unmodified. Keep
the first sentence tight (<=140 chars) and self-contained — it is what gets checked. Do NOT bury a
number here without a source_ref above.>

framing: <explicit lens directive — the positive frame the summarizer must keep. Required for
auth/access/identity nodes. e.g. "authorized, authenticated capability; describe as authenticate, not
bypass" — starves the consolidator of the ambiguity that lets it reach for loaded terms.>

## Derived / notes (may be reworded by brv; NOT authoritative)

<Everything else: working notes, associations, context. brv's consolidate/read-time layers may reword
this freely — it is the derived tier, never injected as bare truth.>

<!--
WHY THE GATE BLOCKS (so you can fix it in one edit, not fight it):
  • "no-provenance"  — your payload makes a wage/price/market numeric claim with no source_ref / -f file
                       / verified:true. Add the source, or write the figure as "(unverified)".
                       A gap beats a confident fabrication (master spec Principle 6).
  • "no-framing"     — an auth/access node with no `framing:` directive (or `## Canonical` block).
                       Add the positive lens. The framing-distortion incident ("hijack"/"bypass" reach)
                       happened precisely because the lens was implicit.
  • "forbidden-term" — a policy-forbidden loaded term on a classified node (e.g. "bypass"/"hijack" on an
                       identity/access node). Reframe to control-gap language, or — for a genuine
                       defensive-security node — set safety_sanitized:true (exempts the check).
  • "missing-required" — a node-specific `required:` term is absent. Add the qualifier.
The gate NEVER rewrites your text; it returns the reason and you author the fix. Determinism + your
authored framing is the whole mechanism — an LLM gate would reintroduce the poorly-tuned-saver failure
this program exists to prevent.
-->
