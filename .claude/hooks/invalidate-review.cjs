/**
 * PostToolUse Hook: Review Invalidation
 *
 * Deletes .claude/reviewed marker when apps/** files are modified,
 * forcing a fresh review before commit.
 */
const fs = require('fs');
const path = require('path');

const REVIEWED_MARKER = path.join(__dirname, '..', 'reviewed');

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/');
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    const data = JSON.parse(input);
    const toolInput = data.tool_input || {};
    const filePath = normalizePath(toolInput.file_path || '');

    if (filePath.startsWith('apps/') || filePath.includes('/apps/')) {
      try {
        fs.unlinkSync(REVIEWED_MARKER);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // ignore — marker didn't exist
        }
      }
    }

    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }
}

main();
