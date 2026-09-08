/**
 * Create GitHub issue on first user prompt
 *
 * UserPromptSubmit hook that automatically creates a GitHub issue on the first
 * user prompt of a session. This ensures every branch has an associated issue
 * for tracking work and progress.
 *
 * Features:
 * - **Auto-create issue** - Creates issue from first user prompt
 * - **Branch linking** - Detects issue number prefix in branch name (e.g., `42-claude-...`)
 * - **State tracking** - Saves to `.claude/logs/branch-issues.json` by branch name
 * - **Plan integration** - sync-plan-to-issue.ts updates this issue instead of creating new
 *
 * @module create-issue-on-prompt
 */

import type { UserPromptSubmitInput, UserPromptSubmitHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'node:fs/promises';
import path from 'node:path';

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
 * Parse issue number from branch name prefix (e.g., "42-claude-agile-narwhal")
 */
function parseIssueFromBranch(branch: string): number | null {
  const match = branch.match(/^(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Get issue URL from issue number
 */
async function getIssueUrl(cwd: string, issueNumber: number): Promise<string | null> {
  const result = await execCommand(`gh issue view ${issueNumber} --json url -q .url`, cwd);
  return result.success ? result.stdout : null;
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
 * Save branch issue state to disk
 */
async function saveBranchIssueState(cwd: string, state: BranchIssueState): Promise<void> {
  const stateDir = path.join(cwd, '.claude', 'logs');
  const stateFile = path.join(stateDir, 'branch-issues.json');

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Create a title from the user prompt (first 80 chars, cleaned up)
 */
function createTitleFromPrompt(prompt: string, branch: string): string {
  // Clean up the prompt: remove markdown, extra whitespace, etc.
  const cleaned = prompt
    .replace(/^#+\s*/gm, '') // Remove markdown headers
    .replace(/\n+/g, ' ') // Replace newlines with spaces
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();

  if (!cleaned) {
    return `Session work on ${branch}`;
  }

  // Truncate to 80 chars
  if (cleaned.length <= 80) {
    return cleaned;
  }

  return cleaned.substring(0, 77) + '...';
}

/**
 * Work type prefixes for branch naming
 */
type WorkType = 'feature' | 'fix' | 'chore' | 'docs' | 'refactor';

/**
 * Detect work type from prompt keywords
 */
function detectWorkType(prompt: string): WorkType {
  const lower = prompt.toLowerCase();

  // Fix patterns
  if (/\b(fix|bug|error|issue|broken|crash|fail|wrong)\b/.test(lower)) {
    return 'fix';
  }

  // Docs patterns
  if (/\b(doc|readme|document|comment|explain)\b/.test(lower)) {
    return 'docs';
  }

  // Refactor patterns
  if (/\b(refactor|clean|improve|optimize|reorganize|restructure)\b/.test(lower)) {
    return 'refactor';
  }

  // Feature patterns (default for most work)
  if (/\b(add|create|implement|build|new|feature|develop)\b/.test(lower)) {
    return 'feature';
  }

  // Default to feature for general work
  return 'feature';
}

/**
 * Convert title to kebab-case for branch name (max 40 chars)
 */
function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim hyphens
    .substring(0, 40); // Max 40 chars
}

/**
 * Rename branch to include issue number and work type
 * Format: {issueNumber}-{workType}/{kebab-name}
 */
async function renameBranch(
  cwd: string,
  oldBranch: string,
  issueNumber: number,
  title: string,
  workType: WorkType
): Promise<{ success: boolean; newBranch: string; error?: string }> {
  const kebabName = toKebabCase(title);
  const newBranch = `${issueNumber}-${workType}/${kebabName}`;

  // Rename local branch
  const renameResult = await execCommand(`git branch -m ${oldBranch} ${newBranch}`, cwd);
  if (!renameResult.success) {
    return { success: false, newBranch: oldBranch, error: renameResult.stderr };
  }

  // Check if old branch exists on remote
  const remoteCheck = await execCommand(`git ls-remote --heads origin ${oldBranch}`, cwd);
  if (remoteCheck.success && remoteCheck.stdout.includes(oldBranch)) {
    // Push new branch and delete old remote branch
    const pushResult = await execCommand(`git push -u origin ${newBranch}`, cwd);
    if (pushResult.success) {
      // Delete old remote branch (non-blocking if fails)
      await execCommand(`git push origin --delete ${oldBranch}`, cwd);
    }
  } else {
    // Just set upstream for new branch
    await execCommand(`git push -u origin ${newBranch}`, cwd);
  }

  return { success: true, newBranch };
}

/**
 * UserPromptSubmit hook handler
 *
 * Creates a GitHub issue on first user prompt if one doesn't exist for the branch.
 *
 * @param input - UserPromptSubmit hook input from Claude Code
 * @returns Hook output with issue creation status
 */
async function handler(input: UserPromptSubmitInput): Promise<UserPromptSubmitHookOutput> {
  const logger = createDebugLogger(input.cwd, 'create-issue-on-prompt', true);

  try {
    await logger.logInput({
      session_id: input.session_id,
      prompt_length: input.prompt.length,
    });

    // Check if we're in a git repository
    const gitCheck = await execCommand('git rev-parse --is-inside-work-tree', input.cwd);
    if (!gitCheck.success) {
      await logger.logOutput({ skipped: true, reason: 'Not a git repository' });
      return {};
    }

    // Get current branch
    const branch = await getCurrentBranch(input.cwd);
    if (!branch) {
      await logger.logOutput({ skipped: true, reason: 'Could not determine current branch' });
      return {};
    }

    // Only process claude-* branches (worktree branches)
    if (!branch.startsWith('claude-') && !branch.match(/^\d+-claude-/)) {
      await logger.logOutput({ skipped: true, reason: 'Not a claude worktree branch' });
      return {};
    }

    // Check if we already have an issue for this branch
    const state = await loadBranchIssueState(input.cwd);
    if (state[branch]) {
      await logger.logOutput({
        skipped: true,
        reason: 'Issue already exists for branch',
        issueNumber: state[branch].issueNumber,
      });
      return {};
    }

    // Check if gh CLI is available
    if (!(await isGhAvailable(input.cwd))) {
      await logger.logOutput({ skipped: true, reason: 'gh CLI not authenticated' });
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: '⚠ Cannot create GitHub issue: gh CLI not authenticated. Run: gh auth login',
        },
      };
    }

    // Check if branch has an issue number prefix (e.g., "42-claude-agile-narwhal")
    const linkedIssueNumber = parseIssueFromBranch(branch);
    if (linkedIssueNumber) {
      // Verify the issue exists
      const issueUrl = await getIssueUrl(input.cwd, linkedIssueNumber);
      if (issueUrl) {
        // Link to existing issue instead of creating new
        state[branch] = {
          issueNumber: linkedIssueNumber,
          issueUrl,
          createdAt: new Date().toISOString(),
          createdFromPrompt: false,
          linkedFromBranchPrefix: true,
        };
        await saveBranchIssueState(input.cwd, state);

        await logger.logOutput({
          action: 'linked',
          issueNumber: linkedIssueNumber,
          issueUrl,
          branch,
        });

        return {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: `Linked to existing issue #${linkedIssueNumber}: ${issueUrl}\n\nThis branch is working on an existing issue (detected from branch prefix).`,
          },
        };
      }
    }

    // Create new issue from user prompt
    const title = createTitleFromPrompt(input.prompt, branch);
    const body = `**Branch:** \`${branch}\`

---

## Initial Prompt

${input.prompt}

---

*Issue created automatically on first user prompt.*`;

    const result = await execGhWithStdin(
      ['issue', 'create', '--title', title, '--body-file', '-'],
      body,
      input.cwd
    );

    if (!result.success) {
      await logger.logError(new Error(`Failed to create issue: ${result.stderr}`));
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `⚠ Could not create GitHub issue: ${result.stderr}`,
        },
      };
    }

    // Extract issue URL and number from output
    const issueUrl = result.stdout.match(/https:\/\/github\.com\/[^\s]+/)?.[0] || '';
    const issueNumber = parseInt(issueUrl.match(/\/(\d+)$/)?.[1] || '0', 10);

    if (!issueNumber) {
      await logger.logError(new Error('Failed to extract issue number from gh output'));
      return {};
    }

    // Detect work type and rename branch to include issue number
    const workType = detectWorkType(input.prompt);
    const renameResult = await renameBranch(input.cwd, branch, issueNumber, title, workType);

    // Use the new branch name for state tracking
    const finalBranch = renameResult.newBranch;

    // Save state with the new branch name
    state[finalBranch] = {
      issueNumber,
      issueUrl,
      createdAt: new Date().toISOString(),
      createdFromPrompt: true,
    };
    // Also keep old branch mapping in case of reference
    if (finalBranch !== branch) {
      state[branch] = state[finalBranch];
    }
    await saveBranchIssueState(input.cwd, state);

    await logger.logOutput({
      action: 'created',
      issueNumber,
      issueUrl,
      oldBranch: branch,
      newBranch: finalBranch,
      workType,
      renamed: renameResult.success,
    });

    // Build response message
    let additionalContext = `Created issue #${issueNumber} for this branch: ${issueUrl}`;

    if (renameResult.success && finalBranch !== branch) {
      additionalContext += `\n\n✓ Branch renamed: \`${branch}\` → \`${finalBranch}\``;
      additionalContext += `\n  Work type: ${workType}`;
    } else if (!renameResult.success) {
      additionalContext += `\n\n⚠️ Could not rename branch: ${renameResult.error}`;
      additionalContext += `\n  To rename manually: \`git branch -m ${branch} ${issueNumber}-${workType}/<name>\``;
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    };
  } catch (error) {
    await logger.logError(error as Error);
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
