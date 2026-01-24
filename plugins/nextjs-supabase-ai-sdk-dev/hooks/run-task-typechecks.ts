/**
 * TypeScript check for SubagentStop hooks
 *
 * Runs tsc --noEmit on the project after a subagent completes.
 * Blocks if there are type errors.
 *
 * @module run-task-typechecks
 */

import type { SubagentStopInput, SubagentStopHookOutput } from '../shared/types/types.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { getAgentEdits } from '../shared/hooks/utils/subagent-state.js';
import { findConfigFile } from '../shared/hooks/utils/config-resolver.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Maximum characters for check output to prevent context bloat */
const MAX_OUTPUT_CHARS = 500;

/** Timeout for tsc in milliseconds (60 seconds - tsc can be slow) */
const TIMEOUT_MS = 60000;

/** File extensions that trigger typecheck */
const TS_EXTENSIONS = ['.ts', '.tsx'];

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
 * Check if any edited files are TypeScript
 */
function hasTypeScriptFiles(files: string[]): boolean {
  return files.some((file) =>
    TS_EXTENSIONS.some((ext) => file.endsWith(ext))
  );
}

/**
 * SubagentStop hook handler
 *
 * Runs tsc --noEmit on the project. Blocks if typecheck fails.
 */
async function handler(input: SubagentStopInput): Promise<SubagentStopHookOutput> {
  const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('task-typechecks');

  if (DEBUG) {
    console.log('[run-task-typechecks] Hook triggered');
    console.log('[run-task-typechecks] Agent ID:', input.agent_id);
  }

  try {
    // Get all files edited by the agent
    const edits = await getAgentEdits(input.agent_transcript_path);
    const allEditedFiles = [...edits.agentNewFiles, ...edits.agentEditedFiles];

    if (DEBUG) {
      console.log('[run-task-typechecks] Edited files:', allEditedFiles.length);
    }

    // Only run typecheck if TypeScript files were edited
    if (!hasTypeScriptFiles(allEditedFiles)) {
      if (DEBUG) {
        console.log('[run-task-typechecks] No TypeScript files edited, skipping');
      }
      return {};
    }

    // Find tsconfig.json
    const tsconfigDir = await findConfigFile(input.cwd, 'tsconfig.json');

    if (!tsconfigDir) {
      // No tsconfig.json found - skip with warning (per user preference)
      if (DEBUG) {
        console.warn(`[run-task-typechecks] TypeScript configuration (tsconfig.json) not found. Searched from ${input.cwd} to git root. Skipping type check.`);
      }
      return {};
    }

    // Run tsc --noEmit on the project
    const command = 'npx tsc --noEmit';

    if (DEBUG) {
      console.log('[run-task-typechecks] Running:', command);
      console.log('[run-task-typechecks] Config dir:', tsconfigDir);
    }

    try {
      await execAsync(command, {
        cwd: tsconfigDir,
        timeout: TIMEOUT_MS,
      });

      // Typecheck passed
      return {};
    } catch (error) {
      // Typecheck failed
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const output = err.stdout || err.stderr || err.message || 'TypeScript check failed';

      return {
        decision: 'block',
        reason: `Fix TypeScript errors before continuing:\n\n${truncateOutput(output)}`,
      };
    }
  } catch (error) {
    if (DEBUG) {
      console.error('[run-task-typechecks] Error:', error);
    }
    // Don't block on transcript parsing errors
    return {};
  }
}

export { handler };
runHook(handler);
