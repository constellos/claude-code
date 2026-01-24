/**
 * SubagentStop hook - Reviews subagent work completion
 *
 * This hook fires when a subagent completes and reviews its work against
 * the original task. It:
 * - Never blocks Explore agents (informational)
 * - Blocks Plan agents if no plan file was created
 * - Provides context with matching rules for other agents
 *
 * @module review-subagent-completion
 */

import type { SubagentStopInput, SubagentStopHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { getTaskEdits } from '../shared/hooks/utils/task-state.js';
import { discoverRules, matchRulesToFiles, formatRulesContext } from '../shared/hooks/utils/rules-matcher.js';

// ============================================================================
// Constants
// ============================================================================

/** Agent types that should never be blocked */
const NON_BLOCKING_AGENT_TYPES = ['explore', 'claude-code-guide'];

/** File patterns that indicate a plan was created */
const PLAN_FILE_PATTERNS = ['.claude/plans/', '/plans/', 'PLAN.md', 'plan.md'];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a file path looks like a plan file
 */
function isPlanFile(filePath: string): boolean {
  return PLAN_FILE_PATTERNS.some((pattern) => filePath.includes(pattern));
}

/**
 * Normalize agent type for comparison (lowercase, trim)
 */
function normalizeAgentType(agentType: string): string {
  return agentType.toLowerCase().trim();
}

// ============================================================================
// Hook Handler
// ============================================================================

/**
 * SubagentStop hook that reviews subagent work completion
 *
 * Blocking behavior:
 * - Explore agents: Never blocked (informational)
 * - Plan agents: Blocked if no plan file created
 * - Other agents: Non-blocking advisory with rules context
 *
 * @param input - SubagentStop hook input from Claude Code
 * @returns Hook output with optional blocking decision or systemMessage
 */
async function handler(input: SubagentStopInput): Promise<SubagentStopHookOutput> {
  const logger = createDebugLogger(input.cwd, 'review-subagent-completion', true);

  try {
    await logger.logInput({
      agent_id: input.agent_id,
      agent_transcript_path: input.agent_transcript_path,
    });

    // Get task edits and context
    let edits;
    try {
      edits = await getTaskEdits(input.agent_transcript_path);
    } catch (error) {
      // If we can't get task edits, don't block
      await logger.logOutput({
        success: false,
        reason: 'Failed to get task edits',
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }

    const agentType = normalizeAgentType(edits.subagentType);

    // Never block Explore or other informational agents
    if (NON_BLOCKING_AGENT_TYPES.includes(agentType)) {
      await logger.logOutput({
        success: true,
        agentType,
        action: 'passthrough',
        reason: 'Non-blocking agent type',
      });
      return {};
    }

    // For Plan agents, check if a plan file was created
    if (agentType === 'plan') {
      const allFiles = [...edits.agentNewFiles, ...edits.agentEditedFiles];
      const planCreated = allFiles.some(isPlanFile);

      if (!planCreated && allFiles.length === 0) {
        await logger.logOutput({
          success: true,
          agentType,
          action: 'block',
          reason: 'No plan file created',
        });
        return {
          decision: 'block',
          reason: 'Plan agent completed without creating or updating a plan file. Please create a plan in .claude/plans/ before completing.',
        };
      }
    }

    // For other agents, find matching rules and provide context
    const allEditedFiles = [...edits.agentNewFiles, ...edits.agentEditedFiles];

    if (allEditedFiles.length === 0) {
      await logger.logOutput({
        success: true,
        agentType,
        action: 'passthrough',
        reason: 'No files modified',
      });
      return {};
    }

    // Discover and match rules
    const rules = await discoverRules(input.cwd);
    const matchingRules = matchRulesToFiles(rules, allEditedFiles, input.cwd);
    const rulesContext = formatRulesContext(matchingRules);

    // Build review context
    const promptPreview = edits.agentPrompt.length > 500
      ? edits.agentPrompt.slice(0, 500) + '...'
      : edits.agentPrompt;

    const contextLines: string[] = [
      '## Subagent Completion Review',
      '',
      `**Task:** ${promptPreview}`,
      `**Agent Type:** ${edits.subagentType}`,
      `**Files Created:** ${edits.agentNewFiles.length} | **Edited:** ${edits.agentEditedFiles.length}`,
    ];

    if (edits.agentDeletedFiles.length > 0) {
      contextLines.push(`**Files Deleted:** ${edits.agentDeletedFiles.length}`);
    }

    if (rulesContext) {
      contextLines.push('', rulesContext);
    }

    contextLines.push('', 'Verify the task was completed and any applicable rules were followed.');

    await logger.logOutput({
      success: true,
      agentType,
      action: 'context',
      filesCreated: edits.agentNewFiles.length,
      filesEdited: edits.agentEditedFiles.length,
      matchingRules: matchingRules.length,
    });

    return {
      systemMessage: contextLines.join('\n'),
    };
  } catch (error: unknown) {
    // Non-blocking on errors
    await logger.logError(error as Error);
    return {};
  }
}

// Export handler for testing
export { handler };

// Export helpers for testing
export { isPlanFile, normalizeAgentType, NON_BLOCKING_AGENT_TYPES, PLAN_FILE_PATTERNS };

// Make this file self-executable with tsx
runHook(handler);
