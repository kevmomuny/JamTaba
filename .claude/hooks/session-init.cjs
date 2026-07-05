/**
 * Session Initialization Hook
 *
 * Suggests loop presets based on current context:
 * - Active sprint plan -> /loops sprint
 * - Morning -> /loops dev
 * - Afternoon -> /loops monitor
 */
const fs = require('fs');
const path = require('path');

try {
  const lines = [];

  // Check for active sprint plan
  const planPath = path.join(__dirname, '..', 'plan.json');
  let hasActivePlan = false;
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    if (plan.status === 'IN_PROGRESS') hasActivePlan = true;
  } catch { /* no plan or invalid json */ }

  // Check time of day
  const hour = new Date().getHours();

  if (hasActivePlan) {
    lines.push('Suggested: /loops sprint');
  } else if (hour >= 6 && hour < 13) {
    lines.push('Suggested: /loops dev');
  } else if (hour >= 13 && hour < 20) {
    lines.push('Suggested: /loops monitor');
  }
  // Evening (20-6): no suggestion

  if (lines.length > 0) {
    process.stdout.write(lines.join('\n') + '\n');
  }
} catch {
  // Never crash the session
}

process.exit(0);
