## E2E Test Intake: [Feature Name]

### Research (filled by Claude before asking questions)

**Routes found:**
- [ ] `METHOD /api/path` — description

**Tables involved:**
- [ ] `table_name` — columns relevant to this feature

**UI pages:**
- [ ] `PageName.tsx` at `/route`

### Pre-Cog Gate (EHX — ehx-finalization F3)

For any surface where a human reads a computed/inferred/generated result, fill
`.claude/templates/ehx-precog-interrogation.md` BEFORE proceeding to Questions
(`.claude/rules/ehx-testing.md` §1 contract 1 — pre-cog before code). The interrogation's
answers feed this intake directly: **Q4** (what the function produces) → CORRECT STATE;
**Q7** (how they know it fired) → CONSUMER EXPECTATION; **Q13** (doubting-Thomas probe) →
the trust assertions in the Test Plan.

- [ ] Pre-cog interrogation filled at: `<path or N/A: surface renders no computed results>`

### Questions (conversation — not a fixed list)

Start with the essentials, then follow up based on answers. Ask what you need to understand the feature — don't pad, don't cap.

1. **WORKFLOW**: What's the business workflow end-to-end?
   > _Answer:_

2. **CORRECT STATE**: After success, what should be true in the data?
   > _Answer:_

3. **WHAT BREAKS**: What's a real-world failure worth catching?
   > _Answer:_

4. **CONSUMER EXPECTATION**: What does the human consuming this surface expect to see — and
   what on screen would make them doubt it (stale status, unexplained number, silent empty)?
   > _Answer:_

_Continue asking follow-ups based on answers until the feature is understood — not just the code, but the business context._

### Test Plan (filled after answers)

| Test Name | What It Verifies | Boundary Crossing | Key Assertion (field → SoT) |
|-----------|-----------------|-------------------|------------------------------|
| | | UI → API → DB | |
| | | API → DB | |
| | | DB integrity | |

_Key Assertion names the specific rendered field AND its source of truth (the PG column / API
field / engine output it must MATCH — not merely exist; `feedback_verification`)._

### Verification Checklist

- [ ] Every test crosses at least one system boundary
- [ ] Every assertion checks data values, not DOM presence
- [ ] No mocking in any test
- [ ] Test-created data is cleaned up
- [ ] Tests skip gracefully when prerequisite data is missing
- [ ] At least 1 test verifies a mutation (create/update/delete)
- [ ] Rendered values are asserted against the consumer's expected format + trust level
      (status tokens carry freshness; empty states carry an affordance; blocked actions name
      their prerequisite) — per `.claude/rules/ehx-testing.md` §1
