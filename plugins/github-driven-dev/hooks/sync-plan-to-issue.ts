/**
 * Plan-to-issue synchronization hook
 *
 * PostToolUse hook that automatically creates GitHub issues from plan files when
 * they are written or edited. Maintains a 1:1 relationship between plan sessions
 * and GitHub issues for better project tracking and collaboration.
 *
 * This hook provides:
 * - **Automatic issue creation** - Creates issue on first plan Write/Edit
 * - **Duplicate prevention** - Tracks created issues to avoid duplicates on plan updates
 * - **Branch linking** - Associates issues with the current branch
 * - **Auto-close on merge** - Issues close automatically when PR is merged (via "Closes #N" syntax)
 *
 * State is tracked in .claude/logs/plan-issues.json to remember which plan
 * sessions have already created issues.
 *
 * @module sync-plan-to-issue
 */

import type { PostToolUseInputTyped, PostToolUseHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { postPlanUpdateComment } from '../shared/hooks/utils/github-comments.js';
import { exec, spawn } from 'child_process';
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
 * Execute gh command with stdin for large body content
 * This avoids shell escaping issues when passing markdown content
 */
async function execGhWithStdin(
  args: string[],
  stdin: string,
  cwd: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { cwd });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        stdout: '',
        stderr: error.message,
      });
    });

    // Write body to stdin and close
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Get current git branch name
 */
async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  return result.success ? result.stdout : '';
}

/**
 * Check if gh CLI is available and authenticated
 */
async function isGhAvailable(cwd: string): Promise<boolean> {
  const authCheck = await execCommand('gh auth status', cwd);
  return authCheck.success;
}

/**
 * Extract plan title from content (first # heading or filename)
 */
function extractPlanTitle(content: string, filePath: string): string {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  // Fallback to filename without extension
  const basename = path.basename(filePath, '.md');
  return basename.charAt(0).toUpperCase() + basename.slice(1);
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
    // File doesn't exist yet or is invalid
    return {};
  }
}

/**
 * Load branch issue state from disk
 */
async function loadBranchIssueState(cwd: string): Promise<BranchIssueState> {
  const stateFile = path.join(cwd, '.claude', 'logs', 'branch-issues.json');

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
 * Create or update GitHub issue from plan content
 *
 * Priority for finding existing issue:
 * 1. Check branch-issues.json (created by UserPromptSubmit hook)
 * 2. Check plan-issues.json (created by previous plan syncs)
 * 3. Create new issue if none found
 */
async function syncPlanToIssue(
  cwd: string,
  sessionId: string,
  planPath: string,
  planContent: string,
  branch: string
): Promise<{ issueNumber: number; issueUrl: string; action: 'created' | 'updated'; version: number }> {
  const planState = await loadPlanIssueState(cwd);
  const branchState = await loadBranchIssueState(cwd);

  const title = extractPlanTitle(planContent, planPath);

  // Prepare issue body with branch reference
  const body = `**Branch:** \`${branch}\`
**Plan file:** \`${planPath}\`

---

${planContent}`;

  // PRIORITY 1: Check branch-issues.json (from UserPromptSubmit hook)
  const branchIssue = branchState[branch];
  if (branchIssue && branchIssue.issueNumber) {
    // Update existing branch issue with plan content
    const result = await execGhWithStdin(
      ['issue', 'edit', String(branchIssue.issueNumber), '--title', title, '--body-file', '-'],
      body,
      cwd
    );

    if (result.success) {
      // Get current version or start at 1
      const existingPlanState = planState[sessionId];
      const newVersion = existingPlanState?.version ? existingPlanState.version + 1 : 1;

      // Also save to plan-issues.json for consistency
      planState[sessionId] = {
        planPath,
        issueNumber: branchIssue.issueNumber,
        issueUrl: branchIssue.issueUrl,
        branch,
        createdAt: branchIssue.createdAt,
        lastUpdated: new Date().toISOString(),
        version: newVersion,
      };
      await savePlanIssueState(cwd, planState);

      return {
        issueNumber: branchIssue.issueNumber,
        issueUrl: branchIssue.issueUrl,
        action: 'updated',
        version: newVersion,
      };
    }
  }

  // PRIORITY 2: Check plan-issues.json (from previous plan syncs)
  const existing = planState[sessionId];
  if (existing && existing.issueNumber) {
    // Update existing issue using stdin to avoid shell escaping issues
    const result = await execGhWithStdin(
      ['issue', 'edit', String(existing.issueNumber), '--body-file', '-'],
      body,
      cwd
    );

    if (result.success) {
      // Increment version
      const newVersion = (existing.version || 0) + 1;

      // Update state
      existing.lastUpdated = new Date().toISOString();
      existing.version = newVersion;
      await savePlanIssueState(cwd, planState);

      return {
        issueNumber: existing.issueNumber,
        issueUrl: existing.issueUrl,
        action: 'updated',
        version: newVersion,
      };
    }
  }

  // PRIORITY 3: Create new issue
  const result = await execGhWithStdin(
    ['issue', 'create', '--title', title, '--body-file', '-', '--label', 'plan'],
    body,
    cwd
  );

  if (!result.success) {
    throw new Error(`Failed to create issue: ${result.stderr || result.stdout}`);
  }

  // Extract issue URL from output
  const issueUrl = result.stdout.match(/https:\/\/github\.com\/[^\s]+/)?.[0] || '';
  const issueNumber = parseInt(issueUrl.match(/\/(\d+)$/)?.[1] || '0', 10);

  if (!issueNumber) {
    throw new Error('Failed to extract issue number from gh output');
  }

  // Save state with version 1
  planState[sessionId] = {
    planPath,
    issueNumber,
    issueUrl,
    branch,
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    version: 1,
  };
  await savePlanIssueState(cwd, planState);

  return { issueNumber, issueUrl, action: 'created', version: 1 };
}

/**
 * PostToolUse hook handler for plan file sync
 *
 * Detects plan file writes/edits and syncs them to GitHub issues.
 *
 * @param input - PostToolUse hook input from Claude Code
 * @returns Hook output with issue creation status
 */
async function handler(input: PostToolUseInputTyped): Promise<PostToolUseHookOutput> {
  const logger = createDebugLogger(input.cwd, 'sync-plan-to-issue', true);

  try {
    // Only process Write and Edit tools
    if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') {
      return {};
    }

    // Type narrowing: at this point, input is Write or Edit
    const filePath = (input as Extract<PostToolUseInputTyped, { tool_name: 'Write' | 'Edit' }>).tool_input.file_path;

    // Detect if this is a plan file
    const isInPlansDir = filePath.includes('/.claude/plans/');
    const isPlanMode = input.permission_mode === 'plan';

    if (!isInPlansDir && !isPlanMode) {
      // Not a plan file
      return {};
    }

    await logger.logInput({
      session_id: input.session_id,
      tool_name: input.tool_name,
      file_path: filePath,
      permission_mode: input.permission_mode,
    });

    // Check if we're in a git repository
    const gitCheck = await execCommand('git rev-parse --is-inside-work-tree', input.cwd);
    if (!gitCheck.success) {
      await logger.logOutput({ skipped: true, reason: 'Not a git repository' });
      return {};
    }

    // Check if gh CLI is available
    if (!(await isGhAvailable(input.cwd))) {
      await logger.logOutput({ skipped: true, reason: 'gh CLI not authenticated' });
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: '⚠ Cannot sync plan to GitHub: gh CLI not authenticated. Run: gh auth login',
        },
      };
    }

    // Get current branch
    const branch = await getCurrentBranch(input.cwd);
    if (!branch) {
      await logger.logOutput({ skipped: true, reason: 'Could not determine current branch' });
      return {};
    }

    // Get plan content
    let planContent: string;
    if (input.tool_name === 'Write') {
      // Write has full content in tool_input
      planContent = (input as Extract<PostToolUseInputTyped, { tool_name: 'Write' }>).tool_input.content;
    } else {
      // Edit - must read file to get full content
      planContent = await fs.readFile(filePath, 'utf-8');
    }

    // Sync to GitHub issue
    const result = await syncPlanToIssue(
      input.cwd,
      input.session_id,
      filePath,
      planContent,
      branch
    );

    // Post update comment for audit trail
    await postPlanUpdateComment(
      result.issueNumber,
      result.version,
      result.action,
      filePath,
      branch,
      input.cwd
    );

    await logger.logOutput({
      action: result.action,
      issue_number: result.issueNumber,
      issue_url: result.issueUrl,
      version: result.version,
      branch,
    });

    const emoji = result.action === 'created' ? '✓' : '↻';
    const verb = result.action === 'created' ? 'Created' : 'Updated';

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `${emoji} ${verb} GitHub issue #${result.issueNumber} (v${result.version}) from plan: ${result.issueUrl}\n\nTo link this issue to your PR, add "Closes #${result.issueNumber}" to the PR description.`,
      },
    };
  } catch (error) {
    await logger.logError(error as Error);

    // Non-blocking error - just inform Claude
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `⚠ Could not sync plan to GitHub issue: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
