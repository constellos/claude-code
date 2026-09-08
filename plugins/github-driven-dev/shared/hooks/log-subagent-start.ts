/**
 * Subagent context tracking hook
 *
 * SubagentStart hook that saves agent execution context when a subagent begins.
 * The saved context can be retrieved later in SubagentStop hooks to analyze what
 * the agent did and correlate it with the original Task tool call.
 *
 * This hook saves the following information to .claude/logs/subagent-tasks.json:
 * - Agent ID and type
 * - Session ID
 * - Original task prompt (from Task tool input)
 * - Tool use ID (for correlating with Task call)
 * - Timestamp
 *
 * The saved context enables SubagentStop hooks to generate rich commit messages,
 * track file operations, and analyze agent behavior.
 *
 * @module log-subagent-start
 */

import type { SubagentStartInput, SubagentStartHookOutput } from '../types/types.js';
import { saveAgentStartContext } from './utils/subagent-state.js';
import { runHook } from './utils/io.js';

/**
 * SubagentStart hook handler that saves agent context
 *
 * Intercepts subagent startup to save execution context for later retrieval.
 * This enables tracking what tasks agents were given and correlating SubagentStop
 * events with the original Task tool call.
 *
 * The hook is non-blocking - errors are logged but do not prevent agent execution.
 *
 * @param input - SubagentStart hook input with agent metadata
 * @returns Hook output (empty object, this hook does not modify agent behavior)
 *
 * @example
 * ```typescript
 * // When an agent starts via Task tool:
 * const result = await handler({
 *   agent_id: 'agent-abc123',
 *   agent_type: 'Explore',
 *   session_id: 'session-xyz',
 *   cwd: '/path/to/project',
 *   transcript_path: '/path/.claude/logs/session-xyz.jsonl'
 * });
 *
 * // Context is saved to .claude/logs/subagent-tasks.json:
 * // {
 * //   "agent-abc123": {
 * //     "agentId": "agent-abc123",
 * //     "agentType": "Explore",
 * //     "sessionId": "session-xyz",
 * //     "prompt": "Find all API endpoints",
 * //     "toolUseId": "toolu_xyz",
 * //     "timestamp": "2025-01-19T12:00:00.000Z"
 * //   }
 * // }
 *
 * // Later, in SubagentStop, this context can be retrieved via getAgentEdits()
 * ```
 */
async function handler(input: SubagentStartInput): Promise<SubagentStartHookOutput> {
  const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('subagent');

  if (DEBUG) {
    console.log('[SubagentStart] Hook triggered');
    console.log('[SubagentStart] Agent ID:', input.agent_id);
    console.log('[SubagentStart] Agent Type:', input.agent_type);
    console.log('[SubagentStart] Session ID:', input.session_id);
  }

  try {
    const context = await saveAgentStartContext({
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      session_id: input.session_id,
      cwd: input.cwd,
      transcript_path: input.transcript_path,
    });

    if (DEBUG) {
      console.log('[SubagentStart] Saved agent context');
      console.log('[SubagentStart] Prompt:', context.prompt.slice(0, 100) + (context.prompt.length > 100 ? '...' : ''));
      console.log('[SubagentStart] Tool Use ID:', context.toolUseId);
      console.log('[SubagentStart] Timestamp:', context.timestamp);
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
      },
    };
  } catch (error) {
    if (DEBUG) {
      console.error('[SubagentStart] Error saving agent context:', error);
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
      },
    };
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
