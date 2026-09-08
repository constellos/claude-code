/**
 * SessionEnd hook to close linked GitHub issues when session ends without PR
 *
 * This hook:
 * 1. Checks if current branch has a linked GitHub issue
 * 2. Checks if a PR exists for the branch
 * 3. If no PR, closes the issue with explanatory comment
 *
 * Non-blocking - fires after session ends, no output needed.
 * @module close-issue-on-session-end
 */

import type { SessionEndInput, SessionEndHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { getLinkedIssueNumber } from '../shared/hooks/utils/github-comments.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

interface BranchIssueEntry {
  issueNumber: number;
  issueUrl: string;
  createdAt: string;
  createdFromPrompt: boolean;
  linkedFromBranchPrefix?: boolean;
}

interface BranchIssueState {
  [branchName: string]: BranchIssueEntry;
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Execute a shell command and return the result
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

// ============================================================================
// Git Operations
// ============================================================================

/**
 * Get git repository root directory
 */
async function getRepoRoot(cwd: string): Promise<string> {
  const result = await execCommand('git rev-parse --show-toplevel', cwd);
  return result.success ? result.stdout : cwd;
}

/**
 * Get current git branch name
 */
async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  return result.success ? result.stdout : null;
}

// ============================================================================
// Branch Issue State
// ============================================================================

/**
 * Load branch issue state from disk
 */
async function loadBranchIssueState(cwd: string): Promise<BranchIssueState> {
  const stateFile = join(cwd, '.claude', 'logs', 'branch-issues.json');

  try {
    if (!existsSync(stateFile)) {
      return {};
    }
    const data = readFileSync(stateFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Get issue info for a branch from branch-issues.json
 */
async function getBranchIssueInfo(
  branch: string,
  cwd: string
): Promise<{ issueNumber: number; issueUrl: string } | null> {
  const state = await loadBranchIssueState(cwd);
  if (state[branch]) {
    return {
      issueNumber: state[branch].issueNumber,
      issueUrl: state[branch].issueUrl,
    };
  }
  return null;
}

// ============================================================================
// GitHub CLI Operations
// ============================================================================

/**
 * Check if a PR exists for the current branch
 */
async function checkPRExists(
  branch: string,
  cwd: string
): Promise<{ exists: boolean; prNumber?: number; error?: string }> {
  // Check if gh CLI is available
  const ghCheck = await execCommand('gh --version', cwd);
  if (!ghCheck.success) {
    return { exists: false, error: 'GitHub CLI not installed' };
  }

  // Check if gh is authenticated
  const authCheck = await execCommand('gh auth status', cwd);
  if (!authCheck.success) {
    return { exists: false, error: 'GitHub CLI not authenticated' };
  }

  // List PRs for current branch
  const prListResult = await execCommand(
    `gh pr list --head ${branch} --json number --limit 1`,
    cwd
  );

  if (!prListResult.success) {
    return { exists: false, error: `gh pr list failed: ${prListResult.stderr}` };
  }

  try {
    const prs = JSON.parse(prListResult.stdout);
    if (Array.isArray(prs) && prs.length > 0) {
      return { exists: true, prNumber: prs[0].number };
    }
    return { exists: false };
  } catch {
    return { exists: false, error: 'Failed to parse gh output' };
  }
}

/**
 * Close a GitHub issue with a session end comment
 */
async function closeIssueWithComment(
  issueNumber: number,
  sessionId: string,
  reason: string,
  cwd: string
): Promise<{ success: boolean; error?: string }> {
  const reasonMap: Record<string, string> = {
    'clear': 'Session was cleared',
    'logout': 'User logged out',
    'prompt_input_exit': 'User exited session',
    'other': 'Session ended',
  };

  const reasonText = reasonMap[reason] || 'Session ended';
  const timestamp = new Date().toISOString();

  const comment = `## Session Closed - No PR Created

**Session ID:** \`${sessionId}\`
**Reason:** ${reasonText}
**Closed at:** ${timestamp}

This issue was automatically closed because the session ended without creating a pull request.

Reopen this issue to continue work.

---
*Closed automatically via SessionEnd hook*`;

  // Close the issue with comment
  const closeResult = await execCommand(
    `gh issue close ${issueNumber} --comment ${JSON.stringify(comment)}`,
    cwd
  );

  if (!closeResult.success) {
    return { success: false, error: closeResult.stderr };
  }

  return { success: true };
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * SessionEnd hook handler
 *
 * Closes linked GitHub issues when session ends without a PR.
 * Non-blocking - always returns empty output.
 */
async function handler(input: SessionEndInput): Promise<SessionEndHookOutput> {
  const logger = createDebugLogger(input.cwd, 'close-issue-on-session-end', true);

  try {
    await logger.logInput({ session_id: input.session_id, reason: input.reason });

    // Normalize to repo root
    const repoRoot = await getRepoRoot(input.cwd);

    // Check if in git repository
    const gitCheck = await execCommand('git rev-parse --is-inside-work-tree', repoRoot);
    if (!gitCheck.success) {
      await logger.logOutput({ skipped: true, reason: 'Not a git repository' });
      return {};
    }

    // Get current branch
    const currentBranch = await getCurrentBranch(repoRoot);
    const mainBranches = ['main', 'master', 'develop'];
    if (!currentBranch || mainBranches.includes(currentBranch)) {
      await logger.logOutput({ skipped: true, reason: 'On main branch or no branch' });
      return {};
    }

    // Get linked issue from branch-issues.json
    let issueNumber: number | null = null;
    const branchIssueInfo = await getBranchIssueInfo(currentBranch, repoRoot);
    if (branchIssueInfo) {
      issueNumber = branchIssueInfo.issueNumber;
    } else {
      // Fallback: try to discover via github-comments utility
      issueNumber = await getLinkedIssueNumber(currentBranch, repoRoot);
    }

    if (!issueNumber) {
      await logger.logOutput({ skipped: true, reason: 'No linked issue found' });
      return {};
    }

    // Check if PR exists
    const prCheck = await checkPRExists(currentBranch, repoRoot);
    if (prCheck.exists) {
      await logger.logOutput({
        skipped: true,
        reason: 'PR exists',
        prNumber: prCheck.prNumber,
      });
      return {};
    }

    // No PR - close the issue with comment
    const closeResult = await closeIssueWithComment(
      issueNumber,
      input.session_id,
      input.reason,
      repoRoot
    );

    await logger.logOutput({
      closed: closeResult.success,
      issueNumber,
      reason: input.reason,
      error: closeResult.error,
    });

    return {};
  } catch (error) {
    await logger.logError(error as Error);
    return {}; // Non-blocking - always return empty
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
