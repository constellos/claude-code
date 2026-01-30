/**
 * Automatic commit generation from agent task completion
 *
 * SubagentStop hook that automatically creates git commits when agents complete
 * tasks. Analyzes the agent's file operations and generates commits with rich
 * metadata including the original task prompt and execution statistics.
 *
 * This hook:
 * - Only commits files modified by the specific agent (not all changes)
 * - Generates commit messages from task prompts
 * - Adds git trailers with agent metadata
 * - Handles new files, edits, and deletions separately
 * - Skips commit if no files were modified
 *
 * Commit message format:
 * ```
 * [AgentType] Task description
 *
 * Full task prompt
 *
 * Agent-Type: Explore
 * Agent-ID: agent-abc123
 * Files-Edited: 2
 * Files-New: 1
 * Files-Deleted: 0
 * ```
 *
 * @module commit-task
 */

import type { SubagentStopInput, SubagentStopHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { getTaskEdits } from '../shared/hooks/utils/task-state.js';
import { execCommand } from '../shared/hooks/utils/ci-status.js';
import { getStackedBranchEntry } from '../shared/hooks/utils/stacked-branches.js';

// Using shared execCommand from ci-status.ts

/**
 * Format commit message with task prompt and git trailers
 */
function formatCommitMessage(options: {
  agentType: string;
  agentId: string;
  prompt: string;
  filesEdited: number;
  filesNew: number;
  filesDeleted: number;
}): string {
  const { agentType, agentId, prompt, filesEdited, filesNew, filesDeleted } = options;

  // Create concise title from prompt (first line or first 50 chars)
  const promptLines = prompt.split('\n').map(l => l.trim()).filter(Boolean);
  let title = promptLines[0] || 'Agent task completed';

  // Truncate title if too long (72 chars is git convention)
  if (title.length > 72) {
    title = title.slice(0, 69) + '...';
  }

  // Build commit message with title, body, and git trailers
  const lines: string[] = [];

  // Title with agent type prefix
  lines.push(`[${agentType}] ${title}`);
  lines.push('');

  // Body: Full prompt (if longer than title)
  if (promptLines.length > 1 || prompt.length > 100) {
    lines.push('Task prompt:');
    lines.push(prompt);
    lines.push('');
  }

  // Git trailers for metadata
  lines.push(`Agent-Type: ${agentType}`);
  lines.push(`Agent-ID: ${agentId}`);
  lines.push(`Files-Edited: ${filesEdited}`);
  lines.push(`Files-New: ${filesNew}`);
  lines.push(`Files-Deleted: ${filesDeleted}`);

  return lines.join('\n');
}

/**
 * SubagentStop hook handler for auto-committing agent work
 *
 * Analyzes the agent's transcript, extracts file edits and task prompt,
 * and creates a commit with only the files edited by this specific agent.
 *
 * @param input - SubagentStop hook input from Claude Code
 * @returns Hook output (empty on success, blocking on critical error)
 */
async function handler(
  input: SubagentStopInput
): Promise<SubagentStopHookOutput> {
  const logger = createDebugLogger(input.cwd, 'commit-task', true);

  try {
    await logger.logInput({
      agent_id: input.agent_id,
      agent_transcript_path: input.agent_transcript_path,
    });

    // Check if stacked PR workflow already handled this agent
    const stackedEntry = await getStackedBranchEntry(input.cwd, input.agent_id);
    if (stackedEntry && stackedEntry.status !== 'failed') {
      await logger.logOutput({
        skipped: true,
        reason: 'Stacked PR workflow already handled this agent',
        stackedStatus: stackedEntry.status,
      });
      return {};
    }

    // Check if we're in a git repository
    const gitCheck = await execCommand('git rev-parse --is-inside-work-tree', input.cwd);
    if (!gitCheck.success) {
      await logger.logOutput({ skipped: true, reason: 'Not a git repository' });
      return {};
    }

    // Refuse to auto-commit on protected branches
    const branchResult = await execCommand('git rev-parse --abbrev-ref HEAD', input.cwd);
    const currentBranch = branchResult.success ? branchResult.stdout : null;
    const protectedBranches = ['main', 'master', 'develop'];
    if (currentBranch && protectedBranches.includes(currentBranch)) {
      await logger.logOutput({
        skipped: true,
        reason: `Refusing to auto-commit on protected branch: ${currentBranch}`,
      });
      return {};
    }

    // Get task edits (file operations and prompt)
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

    const {
      agentSessionId,
      subagentType,
      agentPrompt,
      agentNewFiles,
      agentEditedFiles,
      agentDeletedFiles,
    } = taskEdits;

    // Combine all modified files
    const allModifiedFiles = [
      ...agentNewFiles,
      ...agentEditedFiles,
      ...agentDeletedFiles,
    ];

    if (allModifiedFiles.length === 0) {
      await logger.logOutput({ skipped: true, reason: 'No files modified by agent' });
      return {};
    }

    // Stage only the files modified by this agent
    for (const file of allModifiedFiles) {
      // For deleted files, use git rm; for others, use git add
      const isDeleted = agentDeletedFiles.includes(file);
      const cmd = isDeleted ? `git rm "${file}"` : `git add "${file}"`;

      const addResult = await execCommand(cmd, input.cwd);
      if (!addResult.success) {
        // Log warning but continue with other files
        await logger.logOutput({
          warning: `Could not stage file: ${file}`,
          error: addResult.stderr,
        });
      }
    }

    // Check if anything was actually staged
    const statusResult = await execCommand('git diff --cached --name-only', input.cwd);
    if (!statusResult.stdout) {
      await logger.logOutput({ skipped: true, reason: 'No changes staged for commit' });
      return {};
    }

    // Format commit message with trailers
    const commitMessage = formatCommitMessage({
      agentType: subagentType,
      agentId: agentSessionId,
      prompt: agentPrompt,
      filesEdited: agentEditedFiles.length,
      filesNew: agentNewFiles.length,
      filesDeleted: agentDeletedFiles.length,
    });

    // Create commit with properly escaped message
    const escapedMessage = commitMessage.replace(/'/g, "'\\''");
    const commitResult = await execCommand(`git commit -m '${escapedMessage}'`, input.cwd);

    if (!commitResult.success) {
      // Check if it's just "nothing to commit"
      if (commitResult.stdout.includes('nothing to commit') ||
          commitResult.stderr.includes('nothing to commit')) {
        await logger.logOutput({ skipped: true, reason: 'Nothing to commit after staging' });
        return {};
      }

      await logger.logOutput({
        success: false,
        stage: 'commit',
        error: commitResult.stderr,
      });
      return {};
    }

    // Get the commit hash
    const hashResult = await execCommand('git rev-parse --short HEAD', input.cwd);
    const commitHash = hashResult.stdout || 'unknown';

    await logger.logOutput({
      success: true,
      commit_hash: commitHash,
      agent_type: subagentType,
      files_modified: allModifiedFiles.length,
      files_edited: agentEditedFiles.length,
      files_new: agentNewFiles.length,
      files_deleted: agentDeletedFiles.length,
    });

    return {};
  } catch (error) {
    await logger.logError(error as Error);
    // Don't block on commit errors - just log and continue
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
