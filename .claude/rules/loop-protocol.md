# Loop Protocol

Universal contract for all pulse skills. Every pulse follows this 6-phase cycle.

## 6-Phase Cycle

### 1. RECALL
Search brv for the prior cycle: `brv query "loop:{recipe} latest"`. If empty, this is cycle 0 (baseline). (Was Cipher `cipher_memory_search` — Cipher is decommissioned; see `reference_decommissioned_systems`.)

### 2. EXECUTE
Run recipe-specific queries (SSH, SQLite, Gmail, Calendar, etc.)

### 3. COMPARE
Diff current state against prior. Compute deltas for numerics. Flag new/missing items.

### 4. STORE
Write cycle state to brv: `brv curate "loop:{recipe} cycle {n}: <state-summary>"` (project `energen-loop`). (Was Cipher `cipher_extract_and_operate_memory` — Cipher is decommissioned; see `reference_decommissioned_systems`.)

### 5. CURATE
If finding meets BRV threshold (see below), run `brv curate`. Most cycles skip this. **Reconcile-then-append: if a prior curate already covers the same finding, supersede/update it rather than adding a near-duplicate (per `agentic-workflow.md` SCP).**

**Decommission = first-class write.** If a cycle confirms a system/host/path/model/service is now DEAD (a host gone, a service retired, a model deprecated, a network path removed), append a row to the canonical ledger `reference_decommissioned_systems.md` — that single write is the durable decommission record. The consolidate loop (`brv-dream.cjs` → `decommission-ingest.cjs`) feeds it to the local pgvector memory service (`memory_service_pg.py` on :8077, which applies the ledger as retrieval-time precedence — replaced the retired Memory Machine/Graphiti substrate 2026-06-23, see `groovy-brewing-yao.md`), and `hot-tier-staleness-lint.cjs` flags any markdown still asserting it live. Don't just note the death in the cycle report; record it in the ledger.

### 6. REPORT
Output ONLY actionable items. Nothing changed = output nothing.

## Output Rules

- **Stable:** silence (not "all clear")
- **Minor drift:** `[health-pulse #5] API response +200ms (320->520ms)`
- **Critical:** `[ALERT health-pulse #5] Photo API DOWN since cycle #3`
- **Curated:** append `[curated to BRV]`

## BRV Curation Thresholds

Curate when ANY of these are met:
- Service outage lasting 2+ consecutive cycles
- Data quality metric drift >10% in one session
- Sprint blocker not in original plan
- Pattern recognized across 3+ cycles
- Infrastructure state change

## Error Handling

- **brv unavailable** -> skip RECALL, note "baseline (brv unavailable)"
- **Data source unreachable** -> record as finding, don't crash cycle
- **BRV curate fails** -> log failure, knowledge-pulse handles later

## CronCreate Conventions

- Avoid :00 and :30 marks (fleet load balancing)
- Nudge to odd minutes: 30m -> `7,37 * * * *`, 1h -> `7 * * * *`, 15m -> `3,18,33,48 * * * *`, 20m -> `3,23,43 * * * *`
- All pulse jobs are `recurring: true` and session-scoped (auto-expire 7 days)
