/**
 * PostToolUse Hook: Test Output Verification
 *
 * Warns when test commands produce vacuous results
 * (0 passed, all skipped, no assertions).
 */

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    const data = JSON.parse(input);
    const toolInput = data.tool_input || {};
    const toolResult = data.tool_result || {};
    const command = toolInput.command || '';

    // Only inspect test/playwright commands
    if (!command.includes('playwright') && !/\btest\b/.test(command)) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    const output = [
      toolResult.stdout || '',
      toolResult.stderr || '',
      typeof toolResult === 'string' ? toolResult : ''
    ].join('\n');

    const warnings = [];

    if (/0 passed/i.test(output)) {
      warnings.push('0 tests passed');
    }
    if (/0 tests/i.test(output) && !/[1-9]\d* tests/i.test(output)) {
      warnings.push('0 tests found');
    }
    if (/all.*skip|skip.*all|\bskipped\b.*\ball\b/i.test(output) && !/[1-9]\d* passed/i.test(output)) {
      warnings.push('all tests appear skipped');
    }
    if (output.length > 50 && !/assert|expect|should|toBe|toEqual|toMatch|toHave|passed/i.test(output)) {
      warnings.push('no assertion keywords detected in output');
    }

    if (warnings.length > 0) {
      process.stdout.write(JSON.stringify({
        decision: 'approve',
        message: `WARNING: Test run appears vacuous - ${warnings.join(', ')}. Tests that only check DOM presence are not tests.`
      }));
    } else {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
    }
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }
}

main();
