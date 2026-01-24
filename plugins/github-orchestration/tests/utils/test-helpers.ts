/**
 * Formats a test result with a pass/fail prefix.
 * @param passed - Whether the test passed
 * @param message - The test result message
 * @returns Formatted string like "[PASS] message" or "[FAIL] message"
 */
export function formatTestResult(passed: boolean, message: string): string {
  const prefix = passed ? '[PASS]' : '[FAIL]';
  return `${prefix} ${message}`;
}

export function assertTestPassed(condition: boolean, testName: string): void {
  if (!condition) {
    throw new Error(`Test failed: ${testName}`);
  }
  console.log(formatTestResult(true, testName));
}

let testCounter = 0;

export function getNextTestId(): string {
  testCounter++;
  return `test-${testCounter}`;
}
