/**
 * TypeScript check for Stop hooks
 *
 * Runs tsc --noEmit on the project before the main session stops.
 * Blocks if there are type errors.
 *
 * @module run-session-typechecks
 */

import type { StopInput, StopHookOutput } from '../shared/types/types.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { findConfigFile } from '../shared/hooks/utils/config-resolver.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Maximum characters for check output to prevent context bloat */
const MAX_OUTPUT_CHARS = 500;

/** Timeout for tsc in milliseconds (60 seconds - tsc can be slow) */
const TIMEOUT_MS = 60000;

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
 * Stop hook handler
 *
 * Runs tsc --noEmit on the project unconditionally. Session Stop is the
 * final checkpoint before work completes, so running tsc on the whole
 * project is reasonable overhead.
 */
async function handler(input: StopInput): Promise<StopHookOutput> {
  const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('session-typechecks');

  if (DEBUG) {
    console.log('[run-session-typechecks] Hook triggered');
    console.log('[run-session-typechecks] Session ID:', input.session_id);
  }

  // Find tsconfig.json
  const tsconfigDir = await findConfigFile(input.cwd, 'tsconfig.json');

  if (!tsconfigDir) {
    // No tsconfig.json found - skip with warning visible in systemMessage
    const warning = `⚠️ TypeScript check skipped: tsconfig.json not found (searched from ${input.cwd})`;
    if (DEBUG) {
      console.warn(`[run-session-typechecks] ${warning}`);
    }
    return {
      systemMessage: warning,
    };
  }

  // Run tsc --noEmit on the project
  const command = 'npx tsc --noEmit';

  if (DEBUG) {
    console.log('[run-session-typechecks] Running:', command);
    console.log('[run-session-typechecks] Config dir:', tsconfigDir);
  }

  try {
    await execAsync(command, {
      cwd: tsconfigDir,
      timeout: TIMEOUT_MS,
    });

    // Typecheck passed - provide visibility
    return {
      systemMessage: '✓ TypeScript check passed',
    };
  } catch (error) {
    // Typecheck failed
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = err.stdout || err.stderr || err.message || 'TypeScript check failed';

    return {
      decision: 'block',
      reason: `Fix TypeScript errors before continuing:\n\n${truncateOutput(output)}`,
    };
  }
}

export { handler };
runHook(handler);
