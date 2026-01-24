/**
 * Issue creation tracking hook
 *
 * PostToolUse hook that automatically tracks GitHub issues created via gh CLI.
 * Detects `gh issue create` commands and stores issue references in session state.
 *
 * This hook provides:
 * - **Automatic issue tracking** - Detects issue creation from gh CLI
 * - **Session association** - Links issues to the session that created them
 * - **Cross-session discovery** - Enables related issue discovery in future sessions
 * - **Repository context** - Tracks repo and branch information
 *
 * State is tracked in .claude/logs/session-issues.json to enable cross-session
 * issue discovery and awareness.
 *
 * @module track-issue-creation
 */

import type { PostToolUseInput, PostToolUseHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { addIssueToSession } from '../shared/hooks/utils/session-issues.js';
import { addIssueToState } from '../shared/hooks/utils/github-state.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================================
// Command Execution
// ============================================================================

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

// ============================================================================
// Issue Detection
// ============================================================================

/**
 * Extract issue URL from gh CLI output
 *
 * Looks for GitHub issue URL pattern in command output.
 * @param output - Command output from gh issue create
 * @returns Issue URL if found, null otherwise
 */
function extractIssueUrl(output: string): string | null {
  // Pattern: https://github.com/owner/repo/issues/123
  const urlMatch = output.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/);
  return urlMatch ? urlMatch[0] : null;
}

/**
 * Extract issue number from GitHub URL
 * @param url - GitHub issue URL
 * @returns Issue number
 */
function extractIssueNumber(url: string): number {
  const match = url.match(/\/issues\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// ============================================================================
// Hook Handler
// ============================================================================

/**
 * PostToolUse hook handler for tracking issue creation
 *
 * Detects gh issue create commands and tracks the created issues in session state.
 *
 * @param input - PostToolUse hook input from Claude Code
 * @returns Hook output with tracking status
 *
 * @example
 * ```typescript
 * // This hook is automatically called by Claude Code after Bash tool execution
 * // When: gh issue create --title "Bug fix" --body "Description"
 * // Result: Issue tracked in .claude/logs/session-issues.json
 * ```
 */
async function handler(input: PostToolUseInput): Promise<PostToolUseHookOutput> {
  const logger = createDebugLogger(input.cwd, 'track-issue-creation', true);

  try {
    // Only process Bash tool
    if (input.tool_name !== 'Bash') {
      return {};
    }

    // Type-cast tool_input for Bash
    const toolInput = input.tool_input as { command?: string };
    const command = toolInput?.command;
    if (!command || !command.includes('gh issue create')) {
      return {};
    }

    await logger.logInput({
      session_id: input.session_id,
      tool_name: input.tool_name,
      command_preview: command.substring(0, 100),
    });

    // Extract issue URL from tool response
    const toolResponse = input.tool_response as { content?: Array<{ text?: string }> };
    const resultText = toolResponse?.content?.[0]?.text || '';
    const issueUrl = extractIssueUrl(resultText);
    if (!issueUrl) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not find issue URL in command output',
      });
      return {};
    }

    const issueNumber = extractIssueNumber(issueUrl);
    if (!issueNumber) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not extract issue number from URL',
      });
      return {};
    }

    // Fetch issue details
    const issueResult = await execCommand(
      `gh issue view ${issueNumber} --json number,title,url`,
      input.cwd
    );

    if (!issueResult.success) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not fetch issue details',
        error: issueResult.stderr,
      });
      return {};
    }

    let issueDetails;
    try {
      issueDetails = JSON.parse(issueResult.stdout);
    } catch {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not parse issue details JSON',
      });
      return {};
    }

    // Get repository name
    const repoResult = await execCommand(
      'gh repo view --json nameWithOwner -q .nameWithOwner',
      input.cwd
    );

    if (!repoResult.success) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not determine repository',
        error: repoResult.stderr,
      });
      return {};
    }

    const repo = repoResult.stdout;

    // Get current branch
    const branchResult = await execCommand('git rev-parse --abbrev-ref HEAD', input.cwd);

    if (!branchResult.success) {
      await logger.logOutput({
        skipped: true,
        reason: 'Could not determine current branch',
        error: branchResult.stderr,
      });
      return {};
    }

    const branch = branchResult.stdout;

    const createdAt = new Date().toISOString();

    // Add issue to session tracking (session-issues.json)
    await addIssueToSession(
      input.session_id,
      {
        repo,
        number: issueNumber,
        title: issueDetails.title,
        url: issueUrl,
        createdAt,
      },
      branch,
      repo,
      input.cwd
    );

    // Also add issue to unified github.json state
    await addIssueToState(
      input.session_id,
      {
        number: issueNumber,
        url: issueUrl,
        title: issueDetails.title,
        createdAt,
      },
      input.cwd
    );

    await logger.logOutput({
      success: true,
      issue_number: issueNumber,
      issue_url: issueUrl,
      branch,
      repo,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `Tracked issue #${issueNumber} in session state`,
      },
    };
  } catch (error) {
    await logger.logError(error as Error);

    // Non-blocking - just log error
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
