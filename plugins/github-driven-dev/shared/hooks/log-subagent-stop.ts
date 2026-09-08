/**
 * Subagent completion analysis hook
 *
 * SubagentStop hook that analyzes agent execution results when a subagent completes.
 * It parses the agent's transcript to extract file operations and correlates them
 * with the saved context from SubagentStart.
 *
 * This hook analyzes and logs:
 * - New files created by the agent
 * - Files deleted by the agent
 * - Files edited by the agent
 * - Agent type and original task prompt
 * - Preloaded skills used by the agent
 *
 * After analysis, the hook cleans up the saved context from SubagentStart to prevent
 * the context file from growing indefinitely.
 *
 * The analysis results are logged to console when DEBUG mode is enabled, making it
 * easy to understand what each agent did during execution.
 *
 * @module log-subagent-stop
 */

import type { SubagentStopInput, SubagentStopHookOutput } from '../types/types.js';
import { getAgentEdits } from './utils/subagent-state.js';
import { runHook } from './utils/io.js';

/**
 * SubagentStop hook handler that analyzes agent execution results
 *
 * Intercepts subagent completion to analyze what the agent did during execution.
 * Parses the agent transcript to extract file operations and correlates with the
 * saved context from SubagentStart to provide complete execution metadata.
 *
 * The hook is non-blocking - errors are logged but do not prevent session continuation.
 *
 * @param input - SubagentStop hook input with agent transcript path
 * @returns Hook output (empty object, this hook does not modify behavior)
 *
 * @example
 * ```typescript
 * // When an agent completes:
 * const result = await handler({
 *   agent_id: 'agent-abc123',
 *   agent_transcript_path: '/path/.claude/logs/agent-abc123.jsonl',
 *   cwd: '/path/to/project'
 * });
 *
 * // With DEBUG=* enabled, logs output like:
 * // [SubagentStop] ─────────────────────────────────────────
 * // [SubagentStop] Agent Analysis Complete
 * // [SubagentStop] ─────────────────────────────────────────
 * // [SubagentStop] Agent Type: Explore
 * // [SubagentStop] Agent Prompt: Find all API endpoints
 * // [SubagentStop] Files Created: 0
 * // [SubagentStop] Files Edited: 2
 * // [SubagentStop]   ~ src/api/routes.ts
 * // [SubagentStop]   ~ src/api/handlers.ts
 * // [SubagentStop] Files Deleted: 0
 * // [SubagentStop] ─────────────────────────────────────────
 *
 * // The saved context from SubagentStart is automatically cleaned up
 * ```
 */
async function handler(input: SubagentStopInput): Promise<SubagentStopHookOutput> {
  const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('subagent');

  if (DEBUG) {
    console.log('[SubagentStop] Hook triggered');
    console.log('[SubagentStop] Agent ID:', input.agent_id);
    console.log('[SubagentStop] Agent Transcript:', input.agent_transcript_path);
  }

  try {
    const edits = await getAgentEdits(input.agent_transcript_path);

    if (DEBUG) {
      console.log('[SubagentStop] ─────────────────────────────────────────');
      console.log('[SubagentStop] Agent Analysis Complete');
      console.log('[SubagentStop] ─────────────────────────────────────────');
      console.log('[SubagentStop] Agent Type:', edits.subagentType);
      console.log('[SubagentStop] Agent Prompt:', edits.agentPrompt.slice(0, 100) + (edits.agentPrompt.length > 100 ? '...' : ''));

      if (edits.agentFile) {
        console.log('[SubagentStop] Agent Definition:', edits.agentFile);
      }

      if (edits.agentPreloadedSkillsFiles.length > 0) {
        console.log('[SubagentStop] Preloaded Skills:', edits.agentPreloadedSkillsFiles.length);
        edits.agentPreloadedSkillsFiles.forEach((skill) => {
          console.log('[SubagentStop]   -', skill);
        });
      }

      if (edits.agentNewFiles.length > 0) {
        console.log('[SubagentStop] Files Created:', edits.agentNewFiles.length);
        edits.agentNewFiles.forEach((file) => {
          console.log('[SubagentStop]   +', file);
        });
      }

      if (edits.agentEditedFiles.length > 0) {
        console.log('[SubagentStop] Files Edited:', edits.agentEditedFiles.length);
        edits.agentEditedFiles.forEach((file) => {
          console.log('[SubagentStop]   ~', file);
        });
      }

      if (edits.agentDeletedFiles.length > 0) {
        console.log('[SubagentStop] Files Deleted:', edits.agentDeletedFiles.length);
        edits.agentDeletedFiles.forEach((file) => {
          console.log('[SubagentStop]   -', file);
        });
      }

      if (edits.agentNewFiles.length === 0 &&
          edits.agentEditedFiles.length === 0 &&
          edits.agentDeletedFiles.length === 0) {
        console.log('[SubagentStop] No file operations detected');
      }

      console.log('[SubagentStop] ─────────────────────────────────────────');
    }

    return {};
  } catch (error) {
    if (DEBUG) {
      console.error('[SubagentStop] Error analyzing agent edits:', error);
    }
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
