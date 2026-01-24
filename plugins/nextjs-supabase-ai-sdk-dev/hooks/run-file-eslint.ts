/**
 * ESLint check for PostToolUse[Write|Edit] hooks
 *
 * Runs eslint on the edited file and blocks if there are errors.
 * Only runs on .ts, .tsx, .js, .jsx files.
 *
 * @module run-file-eslint
 */

import type { PostToolUseInput, PostToolUseHookOutput } from '../shared/types/types.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { findConfigFile } from '../shared/hooks/utils/config-resolver.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Maximum characters for check output to prevent context bloat */
const MAX_OUTPUT_CHARS = 500;

/** Timeout for eslint in milliseconds (30 seconds) */
const TIMEOUT_MS = 30000;

/** File extensions to lint */
const LINT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * Truncate output to MAX_OUTPUT_CHARS
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  const truncated = output.slice(0, MAX_OUTPUT_CHARS);
  const remaining = output.length - MAX_OUTPUT_CHARS;
  return `${truncated}\n... (${remaining} more chars truncated)`;
}

/**
 * Check if file should be linted based on extension
 */
function shouldLint(filePath: string): boolean {
  return LINT_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * PostToolUse[Write|Edit] hook handler
 *
 * Runs eslint on the edited file. Blocks if eslint fails.
 */
async function handler(input: PostToolUseInput): Promise<PostToolUseHookOutput> {
  // Only process Write and Edit tools
  if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') {
    return {};
  }

  // Get file path from tool input
  const toolInput = input.tool_input as { file_path?: string };
  const filePath = toolInput?.file_path;

  if (!filePath || !shouldLint(filePath)) {
    return {};
  }

  // Find eslint config directory
  let eslintConfigDir = await findConfigFile(input.cwd, 'eslint.config.mjs');

  // Try alternative flat config format
  if (!eslintConfigDir) {
    eslintConfigDir = await findConfigFile(input.cwd, 'eslint.config.js');
  }

  if (!eslintConfigDir) {
    // No ESLint flat config found - skip validation with warning
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `⚠️ ESLint config not found (searched from ${input.cwd} to git root). Skipping lint check. Expected: eslint.config.mjs or eslint.config.js`,
      },
    };
  }

  // Run eslint
  const command = `npx eslint --max-warnings 0 "${filePath}"`;

  try {
    await execAsync(command, {
      cwd: eslintConfigDir,
      timeout: TIMEOUT_MS,
    });

    // ESLint passed
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `✓ ESLint passed`,
      },
    };
  } catch (error) {
    // ESLint failed
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = err.stdout || err.stderr || err.message || 'ESLint failed';

    return {
      decision: 'block',
      reason: `Fix ESLint errors before continuing:\n\n${truncateOutput(output)}`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `❌ ESLint failed:\n\n${truncateOutput(output)}`,
      },
    };
  }
}

export { handler };
runHook(handler);
