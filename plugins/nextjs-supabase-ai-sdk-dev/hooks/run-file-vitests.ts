/**
 * Vitest check for PostToolUse[Write|Edit] hooks
 *
 * Runs vitest for related tests when a file is edited.
 * Non-blocking - only warns if tests fail.
 * Only runs on .ts, .tsx files.
 *
 * @module run-file-vitests
 */

import type { PostToolUseInput, PostToolUseHookOutput } from '../shared/types/types.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { findConfigFile } from '../shared/hooks/utils/config-resolver.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'path';

const execAsync = promisify(exec);

/** Maximum characters for check output to prevent context bloat */
const MAX_OUTPUT_CHARS = 500;

/** Timeout for vitest in milliseconds (30 seconds) */
const TIMEOUT_MS = 30000;

/** File extensions to check for tests */
const TEST_EXTENSIONS = ['.ts', '.tsx'];

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
 * Check if file should have tests checked
 */
function shouldCheckTests(filePath: string): boolean {
  // Don't run tests for test files themselves
  if (filePath.includes('.test.') || filePath.includes('.spec.')) {
    return false;
  }
  return TEST_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * Find the test file for a given source file
 * Looks for foo.test.ts or foo.test.tsx next to the source file
 */
async function findTestFile(filePath: string): Promise<string | null> {
  const dir = dirname(filePath);
  const base = basename(filePath);

  // Remove extension to get base name
  const extMatch = base.match(/\.(ts|tsx)$/);
  if (!extMatch) return null;

  const nameWithoutExt = base.slice(0, -extMatch[0].length);

  // Try .test.ts and .test.tsx
  for (const ext of ['.test.ts', '.test.tsx']) {
    const testPath = join(dir, nameWithoutExt + ext);
    try {
      await access(testPath);
      return testPath;
    } catch {
      // File doesn't exist
    }
  }

  return null;
}

/**
 * PostToolUse[Write|Edit] hook handler
 *
 * Runs vitest for related tests. Non-blocking - warns only.
 */
async function handler(input: PostToolUseInput): Promise<PostToolUseHookOutput> {
  // Only process Write and Edit tools
  if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') {
    return {};
  }

  // Get file path from tool input
  const toolInput = input.tool_input as { file_path?: string };
  const filePath = toolInput?.file_path;

  if (!filePath || !shouldCheckTests(filePath)) {
    return {};
  }

  // Find related test file
  const testFile = await findTestFile(filePath);

  if (!testFile) {
    // No test file found, skip silently
    return {};
  }

  // Find vitest config
  let vitestConfigDir = await findConfigFile(input.cwd, 'vitest.config.ts');

  // Try alternative configs
  if (!vitestConfigDir) {
    vitestConfigDir = await findConfigFile(input.cwd, 'vitest.config.js');
  }
  if (!vitestConfigDir) {
    vitestConfigDir = await findConfigFile(input.cwd, 'vitest.config.mjs');
  }

  // Fallback to input.cwd if no config found
  const runDir = vitestConfigDir || input.cwd;

  // Make test file path relative to run directory
  const relativeTestFile = isAbsolute(testFile)
    ? relative(runDir, testFile)
    : testFile;

  // Run vitest for the test file
  const command = `npx vitest run "${relativeTestFile}" --reporter=verbose`;

  try {
    await execAsync(command, {
      cwd: runDir,
      timeout: TIMEOUT_MS,
    });

    // Tests passed
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `✓ Tests passed for ${basename(testFile)}`,
      },
    };
  } catch (error) {
    // Tests failed - warn but don't block
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = err.stdout || err.stderr || err.message || 'Tests failed';

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `⚠️ Tests failed for ${basename(testFile)}:\n\n${truncateOutput(output)}`,
      },
    };
  }
}

export { handler };
runHook(handler);
