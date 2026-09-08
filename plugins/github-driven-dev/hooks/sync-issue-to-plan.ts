/**
 * Issue-to-plan synchronization hook
 *
 * PostToolUse hook that detects when Claude uses `gh issue edit` to modify
 * an issue body and syncs those changes back to the local plan file.
 *
 * This hook provides:
 * - **Bidirectional sync** - Issue body changes sync back to plan file
 * - **Internal operations only** - Only catches Claude's gh commands, not external edits
 * - **State tracking** - Updates plan-issues.json with new version
 *
 * @module sync-issue-to-plan
 */

import type { PostToolUseInputTyped, PostToolUseHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
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
    version: number;
  };
}

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
 * Load plan issue state from disk
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
 * Save plan issue state to disk
 */
async function savePlanIssueState(cwd: string, state: PlanIssueState): Promise<void> {
  const stateDir = path.join(cwd, '.claude', 'logs');
  const stateFile = path.join(stateDir, 'plan-issues.json');

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Extract issue number from gh issue edit command
 *
 * Handles patterns like:
 * - gh issue edit 123 --body "..."
 * - gh issue edit 123 --body-file -
 * - gh issue edit 123 --title "..." --body "..."
 */
function extractIssueNumber(command: string): number | null {
  // Match: gh issue edit <number>
  const match = command.match(/gh\s+issue\s+edit\s+(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Check if command is a gh issue edit with body change
 */
function isBodyEditCommand(command: string): boolean {
  if (!command.includes('gh issue edit')) {
    return false;
  }
  // Check for --body or --body-file flag
  return command.includes('--body') || command.includes('--body-file');
}

/**
 * Fetch issue body from GitHub
 */
async function fetchIssueBody(issueNumber: number, cwd: string): Promise<string | null> {
  const result = await execCommand(
    `gh issue view ${issueNumber} --json body --jq '.body'`,
    cwd
  );

  if (result.success && result.stdout) {
    return result.stdout;
  }
  return null;
}

/**
 * Extract plan content from issue body
 *
 * Issue body format:
 * **Branch:** `branch-name`
 * **Plan file:** `/path/to/plan.md`
 *
 * ---
 *
 * <plan content here>
 */
function extractPlanContent(issueBody: string): string {
  // Find the --- separator and return everything after it
  const separatorIndex = issueBody.indexOf('\n---\n');
  if (separatorIndex !== -1) {
    return issueBody.slice(separatorIndex + 5).trim();
  }
  // If no separator, return the whole body (might be manually edited)
  return issueBody.trim();
}

/**
 * Find session ID for a given issue number
 */
function findSessionForIssue(
  state: PlanIssueState,
  issueNumber: number
): { sessionId: string; entry: PlanIssueState[string] } | null {
  for (const [sessionId, entry] of Object.entries(state)) {
    if (entry.issueNumber === issueNumber) {
      return { sessionId, entry };
    }
  }
  return null;
}

/**
 * PostToolUse hook handler for issue-to-plan sync
 *
 * Detects gh issue edit commands and syncs body changes back to plan file.
 *
 * @param input - PostToolUse hook input from Claude Code
 * @returns Hook output with sync status
 */
async function handler(input: PostToolUseInputTyped): Promise<PostToolUseHookOutput> {
  const logger = createDebugLogger(input.cwd, 'sync-issue-to-plan', true);

  try {
    // Only process Bash tool
    if (input.tool_name !== 'Bash') {
      return {};
    }

    // Get command from input
    const command = (input as Extract<PostToolUseInputTyped, { tool_name: 'Bash' }>).tool_input.command;

    // Check if this is a gh issue edit with body change
    if (!isBodyEditCommand(command)) {
      return {};
    }

    // Extract issue number
    const issueNumber = extractIssueNumber(command);
    if (!issueNumber) {
      return {};
    }

    await logger.logInput({
      session_id: input.session_id,
      tool_name: input.tool_name,
      command,
      issueNumber,
    });

    // Load plan state to find associated plan file
    const planState = await loadPlanIssueState(input.cwd);
    const sessionInfo = findSessionForIssue(planState, issueNumber);

    if (!sessionInfo) {
      await logger.logOutput({
        skipped: true,
        reason: 'No plan file associated with this issue',
        issueNumber,
      });
      return {};
    }

    const { sessionId, entry } = sessionInfo;

    // Fetch the new issue body
    const issueBody = await fetchIssueBody(issueNumber, input.cwd);
    if (!issueBody) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not fetch issue body',
        issueNumber,
      });
      return {};
    }

    // Extract plan content from issue body
    const planContent = extractPlanContent(issueBody);

    // Update the local plan file
    await fs.writeFile(entry.planPath, planContent, 'utf-8');

    // Update state with new version
    const newVersion = (entry.version || 0) + 1;
    planState[sessionId] = {
      ...entry,
      lastUpdated: new Date().toISOString(),
      version: newVersion,
    };
    await savePlanIssueState(input.cwd, planState);

    await logger.logOutput({
      success: true,
      issueNumber,
      planPath: entry.planPath,
      version: newVersion,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `↻ Synced issue #${issueNumber} body to plan file: ${entry.planPath} (v${newVersion})`,
      },
    };
  } catch (error) {
    await logger.logError(error as Error);

    // Non-blocking error - just inform Claude
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `⚠ Could not sync issue to plan: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
