/**
 * Log File Utilities
 *
 * Functions for saving hook output to log files in `.claude/logs/`.
 * Used to preserve full output while returning concise summaries to Claude.
 *
 * @module utils/log-file
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Saves output content to a log file and returns the relative path.
 *
 * Creates timestamped log files in `.claude/logs/` directory.
 * The directory is created if it doesn't exist.
 *
 * @param cwd - Current working directory (project root)
 * @param category - Log category (e.g., 'eslint', 'tsc', 'ci')
 * @param identifier - Unique identifier (e.g., filename, check name)
 * @param content - Content to save to the log file
 * @returns Relative path to the created log file
 *
 * @example
 * ```typescript
 * const logPath = await saveOutputToLog(
 *   '/project',
 *   'eslint',
 *   'Button.tsx',
 *   eslintOutput
 * );
 * // Returns: '.claude/logs/eslint-Button.tsx-2025-01-02T10-30-00-000Z.log'
 * ```
 */
export async function saveOutputToLog(
  cwd: string,
  category: string,
  identifier: string,
  content: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Sanitize identifier to be filesystem-safe
  const safeIdentifier = identifier.replace(/[/\\:*?"<>|]/g, '-');
  const filename = `${category}-${safeIdentifier}-${timestamp}.log`;
  const logDir = path.join(cwd, '.claude', 'logs');
  const logPath = path.join(logDir, filename);

  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(logPath, content, 'utf-8');

  // Return relative path for display
  return `.claude/logs/${filename}`;
}

/**
 * Parses error/warning counts from ESLint output.
 *
 * @param output - ESLint stdout/stderr output
 * @returns Object with error and warning counts
 *
 * @example
 * ```typescript
 * const counts = parseEslintCounts(eslintOutput);
 * // Returns: { errors: 3, warnings: 2 }
 * ```
 */
export function parseEslintCounts(output: string): { errors: number; warnings: number } {
  // ESLint summary line format: "✖ 5 problems (3 errors, 2 warnings)"
  const summaryMatch = output.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/i);
  if (summaryMatch) {
    return {
      errors: parseInt(summaryMatch[2], 10),
      warnings: parseInt(summaryMatch[3], 10),
    };
  }

  // Alternative: count individual error/warning lines
  const errorLines = (output.match(/error\s/gi) || []).length;
  const warningLines = (output.match(/warning\s/gi) || []).length;

  return { errors: errorLines, warnings: warningLines };
}

/**
 * Parses error count from TypeScript compiler output.
 *
 * @param output - TypeScript compiler stdout/stderr output
 * @returns Number of type errors found
 *
 * @example
 * ```typescript
 * const errorCount = parseTscErrorCount(tscOutput);
 * // Returns: 5
 * ```
 */
export function parseTscErrorCount(output: string): number {
  // TypeScript summary: "Found 5 errors in 3 files."
  const summaryMatch = output.match(/Found\s+(\d+)\s+errors?/i);
  if (summaryMatch) {
    return parseInt(summaryMatch[1], 10);
  }

  // Alternative: count "error TS" occurrences
  const errorMatches = output.match(/error\s+TS\d+/gi) || [];
  return errorMatches.length;
}

/**
 * Parses test results from Vitest output.
 *
 * @param output - Vitest stdout/stderr output
 * @returns Object with passed, failed, and skipped counts
 *
 * @example
 * ```typescript
 * const results = parseVitestResults(vitestOutput);
 * // Returns: { passed: 10, failed: 2, skipped: 1 }
 * ```
 */
export function parseVitestResults(output: string): {
  passed: number;
  failed: number;
  skipped: number;
} {
  // Vitest summary: "Tests  2 failed | 10 passed | 1 skipped (13)"
  const passed = parseInt(output.match(/(\d+)\s+passed/i)?.[1] || '0', 10);
  const failed = parseInt(output.match(/(\d+)\s+failed/i)?.[1] || '0', 10);
  const skipped = parseInt(output.match(/(\d+)\s+skipped/i)?.[1] || '0', 10);

  return { passed, failed, skipped };
}

/**
 * Parses CI check status from `gh pr checks` output.
 *
 * @param output - Output from `gh pr checks` command
 * @returns Array of check statuses with name, status, and duration
 *
 * @example
 * ```typescript
 * const checks = parseCiChecks(ghOutput);
 * // Returns: [
 * //   { name: 'lint', status: 'pass', duration: '2m30s' },
 * //   { name: 'test', status: 'fail', duration: '5m10s' }
 * // ]
 * ```
 */
export function parseCiChecks(
  output: string
): Array<{ name: string; status: 'pass' | 'fail' | 'pending' | 'skipped'; duration: string }> {
  const checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'pending' | 'skipped';
    duration: string;
  }> = [];

  // gh pr checks output format:
  // lint    pass    2m30s   https://github.com/...
  // test    fail    5m10s   https://github.com/...
  const lines = output.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    // Split by whitespace, handling variable spacing
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const name = parts[0];
      const statusRaw = parts[1].toLowerCase();

      let status: 'pass' | 'fail' | 'pending' | 'skipped';
      if (statusRaw === 'pass' || statusRaw === 'success' || statusRaw === '✓') {
        status = 'pass';
      } else if (statusRaw === 'fail' || statusRaw === 'failure' || statusRaw === '✗') {
        status = 'fail';
      } else if (statusRaw === 'skipped' || statusRaw === 'neutral') {
        status = 'skipped';
      } else {
        status = 'pending';
      }

      const duration = parts[2] || '';

      checks.push({ name, status, duration });
    }
  }

  return checks;
}

/**
 * Formats CI checks as a concise emoji status table.
 *
 * @param checks - Array of parsed CI checks
 * @param logPath - Optional path to full log file (shown for failures)
 * @returns Formatted string with emoji status indicators
 *
 * @example
 * ```typescript
 * const table = formatCiChecksTable(checks, '.claude/logs/ci.log');
 * // Returns:
 * // ✅ lint (2m30s)
 * // ❌ test (5m10s) → .claude/logs/ci.log
 * // ⏳ deploy
 * ```
 */
export function formatCiChecksTable(
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'pending' | 'skipped'; duration: string }>,
  logPath?: string
): string {
  const statusEmoji = {
    pass: '✅',
    fail: '❌',
    pending: '⏳',
    skipped: '⏭️',
  };

  const lines = checks.map((check) => {
    const emoji = statusEmoji[check.status];
    const duration = check.duration ? ` (${check.duration})` : '';
    const logLink = check.status === 'fail' && logPath ? ` → ${logPath}` : '';
    return `${emoji} ${check.name}${duration}${logLink}`;
  });

  return lines.join('\n');
}

/**
 * Formats a concise error summary with log file link.
 *
 * @param tool - Tool name (e.g., 'ESLint', 'TypeScript', 'Vitest')
 * @param summary - Brief summary of issues (e.g., '3 errors, 2 warnings')
 * @param logPath - Path to the full log file
 * @returns Formatted summary string
 *
 * @example
 * ```typescript
 * const summary = formatErrorSummary('ESLint', '3 errors, 2 warnings', logPath);
 * // Returns: '❌ ESLint: 3 errors, 2 warnings\n→ .claude/logs/eslint-file.log'
 * ```
 */
export function formatErrorSummary(tool: string, summary: string, logPath: string): string {
  return `❌ ${tool}: ${summary}\n→ ${logPath}`;
}

/**
 * Formats a success message.
 *
 * @param tool - Tool name (e.g., 'ESLint', 'TypeScript', 'Vitest')
 * @returns Formatted success string
 *
 * @example
 * ```typescript
 * const msg = formatSuccessMessage('ESLint');
 * // Returns: '✅ ESLint: No issues'
 * ```
 */
export function formatSuccessMessage(tool: string): string {
  return `✅ ${tool}: No issues`;
}
