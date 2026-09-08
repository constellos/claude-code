/**
 * Post Explore agent findings to GitHub issues
 *
 * SubagentStop hook that automatically posts Explore agent findings as comments
 * on the linked GitHub issue. This creates a persistent record of codebase
 * exploration that can be referenced later.
 *
 * This hook:
 * - Only runs for Explore agents (other agent types are skipped)
 * - Extracts text content from the agent's transcript
 * - Posts findings as a collapsible comment on the linked issue
 * - Prevents duplicate comments using task ID markers
 *
 * @module post-explore-findings
 */

import type { SubagentStopInput, SubagentStopHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { getTaskEdits } from '../shared/hooks/utils/task-state.js';
import { parseTranscript } from '../shared/hooks/utils/transcripts.js';
import { getLinkedIssueNumber, hasExploreComment, postExploreComment } from '../shared/hooks/utils/github-comments.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Execute a shell command
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
 * Get current git branch name
 */
async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  return result.success ? result.stdout : '';
}

/**
 * Extract all text content from an agent's transcript
 *
 * Combines all TextContent from AssistantMessage entries to get
 * the full text output from the agent.
 */
function extractTextFromTranscript(messages: unknown[]): string {
  const textParts: string[] = [];

  for (const msg of messages) {
    // Type guard for assistant messages
    if (!msg || typeof msg !== 'object') continue;
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.type !== 'assistant') continue;

    // Navigate to content array
    const message = msgObj.message as Record<string, unknown> | undefined;
    if (!message?.content || !Array.isArray(message.content)) continue;

    for (const content of message.content) {
      if (!content || typeof content !== 'object') continue;
      const contentObj = content as Record<string, unknown>;
      if (contentObj.type === 'text' && typeof contentObj.text === 'string') {
        textParts.push(contentObj.text);
      }
    }
  }

  return textParts.join('\n\n');
}

/**
 * SubagentStop hook handler for posting Explore agent findings
 *
 * @param input - SubagentStop hook input from Claude Code
 * @returns Hook output (empty on success)
 */
async function handler(
  input: SubagentStopInput
): Promise<SubagentStopHookOutput> {
  const logger = createDebugLogger(input.cwd, 'post-explore-findings', true);

  try {
    await logger.logInput({
      agent_id: input.agent_id,
      agent_transcript_path: input.agent_transcript_path,
    });

    // Get task edits to determine agent type and prompt
    let taskEdits;
    try {
      taskEdits = await getTaskEdits(input.agent_transcript_path);
    } catch (error) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not analyze task edits',
        error: String(error),
      });
      return {};
    }

    const { subagentType, agentPrompt, agentSessionId } = taskEdits;

    // Only process Explore agents
    if (subagentType.toLowerCase() !== 'explore') {
      await logger.logOutput({
        skipped: true,
        reason: `Not an Explore agent (type: ${subagentType})`,
      });
      return {};
    }

    // Get current branch
    const branch = await getCurrentBranch(input.cwd);
    if (!branch) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not determine current branch',
      });
      return {};
    }

    // Find linked issue
    const issueNumber = await getLinkedIssueNumber(branch, input.cwd);
    if (!issueNumber) {
      await logger.logOutput({
        skipped: true,
        reason: 'No linked issue found for branch',
        branch,
      });
      return {};
    }

    // Use agent session ID as task ID for duplicate detection
    const taskId = agentSessionId;

    // Check for duplicate comment
    const alreadyPosted = await hasExploreComment(issueNumber, taskId, input.cwd);
    if (alreadyPosted) {
      await logger.logOutput({
        skipped: true,
        reason: 'Explore comment already posted for this task',
        taskId,
        issueNumber,
      });
      return {};
    }

    // Parse transcript to extract text findings
    const transcript = await parseTranscript(input.agent_transcript_path);
    const findings = extractTextFromTranscript(transcript.messages);

    if (!findings || findings.trim().length === 0) {
      await logger.logOutput({
        skipped: true,
        reason: 'No text findings in transcript',
      });
      return {};
    }

    // Post the comment
    const posted = await postExploreComment(
      issueNumber,
      taskId,
      agentPrompt,
      findings,
      branch,
      input.cwd
    );

    if (posted) {
      await logger.logOutput({
        success: true,
        issueNumber,
        taskId,
        findingsLength: findings.length,
      });

      return {
        systemMessage: `📝 Posted Explore findings to issue #${issueNumber}`,
      };
    } else {
      await logger.logOutput({
        success: false,
        reason: 'Failed to post comment',
        issueNumber,
      });
      return {};
    }
  } catch (error) {
    await logger.logError(error as Error);
    // Non-blocking - just log and continue
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
