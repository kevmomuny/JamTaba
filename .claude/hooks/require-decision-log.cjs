/**
 * PreToolUse Hook: Decision Log Requirement
 *
 * Blocks Edit/Write to apps/** or packages/** unless a recent
 * decision log entry exists in the decision log.
 *
 * The decision log is sharded as of the decisions-shard sprint:
 *   - Legacy root file: .claude/decisions.jsonl (still read for back-compat)
 *   - Per-sprint shards: .claude/decisions/<sprint>.jsonl (preferred)
 * The hook concatenates the lines of the legacy file AND every shard
 * before the recency scan. Distinct shard files never collide on the
 * GitHub merge button (which does NOT run the merge=union git driver),
 * so concurrent agents stop conflicting on a single append-only file.
 *
 * Supports two entry types:
 *   1. Per-file entries (default): 5-minute TTL, matches on basename
 *   2. Sprint-scoped entries: custom TTL (e.g. "2h"), matches against a files[] glob array
 */
const fs = require('fs');
const path = require('path');

const DECISIONS_FILE = path.join(__dirname, '..', 'decisions.jsonl');
const DECISIONS_DIR = path.join(__dirname, '..', 'decisions');
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/');
}

function isProtectedPath(filePath) {
  const norm = normalizePath(filePath);
  return norm.startsWith('apps/') || norm.startsWith('packages/') ||
    norm.includes('/apps/') || norm.includes('/packages/');
}

/**
 * Parse TTL string like "2h", "30m", "1d" into milliseconds.
 * Falls back to DEFAULT_MAX_AGE_MS on invalid input.
 */
function parseTtl(ttl) {
  if (!ttl) return DEFAULT_MAX_AGE_MS;
  const match = String(ttl).match(/^(\d+)(m|h|d)$/);
  if (!match) return DEFAULT_MAX_AGE_MS;
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 'm': return num * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    case 'd': return num * 24 * 60 * 60 * 1000;
    default: return DEFAULT_MAX_AGE_MS;
  }
}

/**
 * Simple glob match: supports trailing /* and ** patterns.
 *   "mcp-energen-ops/*"  matches any file under mcp-energen-ops/
 *   "skills/energen-*"   matches skills/energen-pricing/SKILL.md etc.
 *   "config/agents/*"    matches config/agents/kevin/agent/system.md etc.
 */
function globMatches(pattern, filePath) {
  const norm = normalizePath(filePath);
  const normPat = normalizePath(pattern);

  // Exact basename match
  if (!normPat.includes('/') && !normPat.includes('*')) {
    return norm.endsWith('/' + normPat) || path.basename(norm) === normPat;
  }

  // Trailing /* or /** — match anything under that prefix
  if (normPat.endsWith('/*') || normPat.endsWith('/**')) {
    const prefix = normPat.replace(/\/\*+$/, '');
    return norm.includes(prefix + '/');
  }

  // Wildcard in the middle (e.g. "skills/energen-*") — convert to simple check
  if (normPat.includes('*')) {
    const parts = normPat.split('*');
    return parts.every(part => norm.includes(part));
  }

  // Exact path substring
  return norm.includes(normPat);
}

/**
 * Read one decision-log file and push its non-empty trimmed lines into `out`.
 * Missing / unreadable file is non-fatal (returns silently).
 */
function pushLines(filePath, out) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return;
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t) out.push(t);
    }
  } catch {
    // unreadable file — skip it, don't fail the whole scan
  }
}

/**
 * Collect every decision-log line from the legacy root file AND every
 * .claude/decisions/*.jsonl shard. Returns a flat array of raw lines.
 * A repo with no shards dir behaves exactly as before (root file only).
 */
function collectLines() {
  const lines = [];

  // Legacy root file (back-compat)
  pushLines(DECISIONS_FILE, lines);

  // Per-sprint shards
  try {
    if (fs.existsSync(DECISIONS_DIR) && fs.statSync(DECISIONS_DIR).isDirectory()) {
      const shards = fs.readdirSync(DECISIONS_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .sort();
      for (const shard of shards) {
        pushLines(path.join(DECISIONS_DIR, shard), lines);
      }
    }
  } catch {
    // no shards dir (or unreadable) — root-only behavior preserved
  }

  return lines;
}

function hasRecentEntry(filePath) {
  try {
    const lines = collectLines();
    if (lines.length === 0) return false;

    const now = Date.now();

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!entry.timestamp) continue;

        const maxAge = entry.scope === 'sprint' ? parseTtl(entry.ttl) : DEFAULT_MAX_AGE_MS;
        const age = now - new Date(entry.timestamp).getTime();
        if (age > maxAge) continue; // skip expired (don't break — older sprint entries may still be valid)

        // Sprint-scoped: match against files[] glob array
        if (entry.scope === 'sprint' && Array.isArray(entry.files)) {
          for (const pattern of entry.files) {
            if (globMatches(pattern, filePath)) return true;
          }
        }

        // Per-file: match on basename
        if (entry.what && normalizePath(entry.what).includes(normalizePath(path.basename(filePath)))) {
          return true;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // if we can't read the log at all, don't block
    return true;
  }
  return false;
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const filePath = toolInput.file_path || '';

    if (!['Edit', 'Write'].includes(toolName)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    if (!isProtectedPath(filePath)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    if (hasRecentEntry(filePath)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    const basename = path.basename(filePath);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `No decision log entry found for ${basename}. Add an entry to .claude/decisions/<sprint>.jsonl (preferred) or .claude/decisions.jsonl before editing.\nFormat: {"timestamp":"${new Date().toISOString()}","what":"${basename} + change description","why":"business reason","verify":"grep pattern"}`
    }));
    process.exit(0);
  } catch (err) {
    // hooks should never crash — approve on error
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }
}

main();
