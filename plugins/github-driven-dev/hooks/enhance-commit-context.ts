/**
 * Enhance commit context with task and issue metadata
 *
 * PostToolUse[Bash] hook that detects git commits and enhances them with context:
 * - **Subagent commits**: Amends commit message with task prompt
 * - **Main agent commits**: Links commit to GitHub issue context
 * - **Future**: Triggers CI review workflow and returns blocking/non-blocking decision
 *
 * Handles both main agent and subagent tool call cases automatically.
 *
 * @module enhance-commit-context
 */

import type {
  PostToolUseInput,
  PostToolUseHookOutput,
} from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { wasToolEventMainAgent } from '../shared/hooks/utils/was-tool-event-main-agent.js';
import { loadTaskCallContext } from '../shared/hooks/utils/task-state.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execAsync = promisify(exec);

interface PlanIssueState {
  [sessionId: string]: {
    planPath: string;
    issueNumber: number;
    issueUrl: string;
    branch: string;
    createdAt: string;
    lastUpdated: string;
  };
}

interface ReviewDecision {
  action: 'BLOCK' | 'APPROVE';
  notes: string;
  docsNeeded: string;
}

/**
 * Execute a shell command
 *
 * @param command - Command to execute
 * @param cwd - Working directory
 * @returns Command result with success flag and output
 */
async function execCommand(
  command: string,
  cwd: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30000 });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || err.message || '',
    };
  }
}

/**
 * Load plan issue state from disk
 *
 * @param cwd - Working directory
 * @returns Plan issue state mapping
 */
async function loadPlanIssueState(cwd: string): Promise<PlanIssueState> {
  const stateFile = path.join(cwd, '.claude', 'logs', 'plan-issues.json');

  try {
    const data = await fs.readFile(stateFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Amend commit message with task prompt
 *
 * @param cwd - Working directory
 * @param prompt - Task prompt to append
 */
async function amendCommitWithPrompt(cwd: string, prompt: string): Promise<void> {
  // Get current commit message
  const msgResult = await execCommand('git log -1 --pretty=%B', cwd);
  if (!msgResult.success) {
    return;
  }

  const currentMsg = msgResult.stdout;

  // Append prompt section
  const enhancedMsg = `${currentMsg}

---
## Prompt
${prompt}`;

  // Amend commit (no-edit to avoid opening editor)
  await execCommand(`git commit --amend --no-edit -m "${enhancedMsg.replace(/"/g, '\\"')}"`, cwd);
}

/**
 * Dispatch GitHub Actions workflow for commit review (future use)
 *
 * @param _cwd - Working directory
 * @param _sha - Commit SHA
 * @param _agentType - main or subagent
 * @param _contextType - issue, plan, or prompt
 * @param _contextId - Issue number or context identifier
 */
async function _dispatchReviewWorkflow(
  _cwd: string,
  _sha: string,
  _agentType: string,
  _contextType: string,
  _contextId: string
): Promise<void> {
  // TODO: Implement when CI review is ready
  // const payload = JSON.stringify({
  //   event_type: 'commit_review',
  //   client_payload: {
  //     commit_sha: sha,
  //     agent_type: agentType,
  //     context_type: contextType,
  //     context_id: contextId,
  //   },
  // });
  // await execCommand(`gh api repos/:owner/:repo/dispatches -f ${payload}`, cwd);
}

/**
 * Poll for review comment on commit (future use)
 *
 * @param _cwd - Working directory
 * @param _sha - Commit SHA
 * @param _maxAttempts - Maximum polling attempts
 * @param _intervalMs - Polling interval in milliseconds
 * @returns Review comment body or null
 */
async function _pollForReviewComment(
  _cwd: string,
  _sha: string,
  _maxAttempts = 60,
  _intervalMs = 5000
): Promise<string | null> {
  // TODO: Implement when CI review is ready
  // for (let i = 0; i < maxAttempts; i++) {
  //   const result = await execCommand(
  //     `gh api repos/:owner/:repo/commits/${sha}/comments --jq '.[].body'`,
  //     cwd
  //   );
  //   if (result.success && result.stdout) {
  //     const comments = result.stdout.split('\n').filter(Boolean);
  //     for (const comment of comments) {
  //       if (comment.includes('## Commit Review') && comment.includes('DECISION:')) {
  //         return comment;
  //       }
  //     }
  //   }
  //   await new Promise((resolve) => setTimeout(resolve, intervalMs));
  // }
  return null;
}

/**
 * Parse review decision from comment (future use)
 *
 * @param _comment - Review comment body
 * @returns Parsed review decision
 */
function _parseReviewDecision(_comment: string): ReviewDecision {
  // TODO: Implement when CI review is ready
  // const decisionMatch = comment.match(/DECISION:\s*(BLOCK|APPROVE)/);
  // const notesMatch = comment.match(/NOTES:\s*([\s\S]*?)(?=DOCUMENTATION_UPDATES:|$)/);
  // const docsMatch = comment.match(/DOCUMENTATION_UPDATES:\s*([\s\S]*?)$/);
  return {
    action: 'APPROVE',
    notes: '',
    docsNeeded: 'No documentation updates needed',
  };
}

/**
 * PostToolUse[Bash] hook handler
 *
 * Detects git commits and enhances them with task context and CI review.
 *
 * @param input - PostToolUse hook input from Claude Code
 * @returns Hook output with review decision
 *
 * @example
 * ```typescript
 * // This hook is automatically called by Claude Code after Bash commands
 * ```
 */
async function handler(input: PostToolUseInput): Promise<PostToolUseHookOutput> {
  const logger = createDebugLogger(input.cwd, 'enhance-commit-context', true);

  try {
    // Only process if this is a Bash tool use
    if (input.tool_name !== 'Bash') {
      return {};
    }

    // Type-cast tool_input
    const toolInput = input.tool_input as { command?: string };

    // Check if git commit command
    const command = toolInput.command;
    if (!command || !command.includes('git commit')) {
      return {};
    }

    await logger.logInput({
      session_id: input.session_id,
      command,
    });

    // Detect agent type
    const isMainAgent = await wasToolEventMainAgent(input.cwd, input.session_id);

    // Get latest commit SHA
    const shaResult = await execCommand('git rev-parse HEAD', input.cwd);
    if (!shaResult.success) {
      await logger.logOutput({ skipped: true, reason: 'Could not get commit SHA' });
      return {};
    }

    const sha = shaResult.stdout;

    // Load context based on agent type
    let contextType: string;
    let contextId: string;

    if (isMainAgent) {
      // Main agent: get linked issue from plan-issues.json
      const state = await loadPlanIssueState(input.cwd);
      const sessionState = state[input.session_id];

      if (sessionState) {
        contextType = 'issue';
        contextId = sessionState.issueNumber.toString();
      } else {
        contextType = 'none';
        contextId = '';
      }
    } else {
      // Subagent: get task prompt and amend commit
      const taskContext = await loadTaskCallContext(input.cwd, input.session_id);

      if (taskContext) {
        await amendCommitWithPrompt(input.cwd, taskContext.prompt);
        contextType = 'prompt';
        contextId = 'embedded';
      } else {
        contextType = 'none';
        contextId = '';
      }
    }

    await logger.logOutput({
      sha,
      agent_type: isMainAgent ? 'main' : 'subagent',
      context_type: contextType,
      context_id: contextId,
    });

    // Note: CI review workflow dispatch and polling is disabled for now
    // This will be implemented when the review-commit.yml workflow is fully configured
    // For now, just allow the commit to proceed

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `✅ Commit ${sha.substring(0, 7)} enhanced with ${contextType} context`,
      },
    };

    /* TODO: Enable when CI review is ready

    // Trigger review workflow
    await dispatchReviewWorkflow(
      input.cwd,
      sha,
      isMainAgent ? 'main' : 'subagent',
      contextType,
      contextId
    );

    // Poll for review comment
    const review = await pollForReviewComment(input.cwd, sha);

    if (!review) {
      // Timeout - allow commit but warn
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: '⚠️ Commit review timed out - proceeding without review',
        },
      };
    }

    // Parse decision
    const decision = parseReviewDecision(review);

    await logger.logOutput({
      decision: decision.action,
      notes: decision.notes,
      docs_needed: decision.docsNeeded,
    });

    // Return hook decision
    if (decision.action === 'BLOCK') {
      return {
        decision: 'block',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `⚠️ Commit review blocked:\n\n${decision.notes}\n\n${decision.docsNeeded}`,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `✅ Commit review approved:\n\n${decision.notes}\n\n${decision.docsNeeded}`,
      },
    };
    */
  } catch (error) {
    await logger.logError(error as Error);

    // Non-blocking - allow commit on error
    // Return empty object to avoid showing errors to user
    // Errors are already logged to hook-events.json for debugging
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
