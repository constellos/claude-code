/**
 * Unified Stop hook: Auto-commit, PR status check, CI waiting, and agent communication
 *
 * This hook performs four main functions at session end:
 *
 * 1. **Blocking validation checks** - Ensures clean git state:
 * - Merge conflicts detection
 * - Branch sync status (behind remote)
 * - Claude settings validation
 * - Hook file existence checks
 *
 * 2. **Auto-commit** - Preserves work in progress:
 * - Automatically commits any uncommitted changes
 * - Adds session metadata to commit message
 * - Tracks commit SHA for one-time blocking
 *
 * 3. **Agent communication** - First-time blocking on new commits:
 * - Blocks ONCE when new commits are detected without a PR
 * - Tracks lastSeenCommitSha to only block on first sight of commits
 * - Subsequent stops show informational message but don't block
 * - Resets when PR created or progress documented via comment
 *
 * 4. **PR status reporting and CI waiting** - Provides PR visibility and ensures quality:
 * - Checks if PR exists for current branch
 * - **Waits for all CI checks to complete** (including Vercel, Supabase integrations)
 * - **Blocks if any CI check fails** (10-minute timeout)
 * - Fetches latest CI run status and link
 * - Extracts Vercel preview URLs (web and marketing apps)
 * - Detects subagent activity to skip instructions intelligently
 *
 * **Session state tracking:**
 * - State stored in `.claude/logs/session-stops.json`
 * - Tracks block count per session
 * - Tracks whether progress has been documented
 *
 * **GitHub comment integration:**
 * - Detects comments with session ID markers
 * - Discovers linked issues from branch context
 * - Accepts progress documentation as alternative to PR
 * @module commit-session-await-status
 */

import type { StopInput, StopHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { getSessionStopState, updateSessionStopState, resetSessionStopState } from '../shared/hooks/utils/session-state.js';
import { hasCommentForSession, getLinkedIssueNumber } from '../shared/hooks/utils/github-comments.js';
import {
  saveOutputToLog,
  formatCiChecksTable,
} from '../shared/hooks/utils/log-file.js';
import {
  awaitCIWithFailFast,
  getLatestCIRun as getCIRunDetails,
  extractAllPreviews,
  extractLinkedIssuesWithInfo,
  type GroupedPreviewUrls,
  type LinkedIssueInfo,
} from '../shared/hooks/utils/ci-status.js';
import { getSessionIssues, type IssueReference } from '../shared/hooks/utils/session-issues.js';
import { addPRToState } from '../shared/hooks/utils/github-state.js';
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

/**
 * Load branch issue state from disk
 * @param cwd - Working directory
 * @returns Branch issue state object
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
 * @param branch - Branch name
 * @param cwd - Working directory
 * @returns Issue info or null
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
// Command Execution
// ============================================================================

/**
 * Execute a shell command and return the result
 * @param command - Shell command to execute
 * @param cwd - Working directory
 * @returns Command result with success flag, stdout, and stderr
 * @example
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
// Git State Checks
// ============================================================================

/**
 * Check if there are uncommitted changes in the working directory
 * Filters out gitignored files - only returns true for tracked/untracked non-ignored files
 * @param cwd - Working directory
 * @returns True if there are non-gitignored uncommitted changes
 * @example
 */
async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await execCommand('git status --porcelain', cwd);
  if (!result.success || !result.stdout) {
    return false;
  }

  // Filter out gitignored files
  const lines = result.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    // Git porcelain format: XY<space>filename (XY = 2 status chars)
    // But stdout.trim() may have removed a leading space from " M filename"
    // Detect by checking if position 2 is a space (not trimmed) or not (trimmed)
    const pathStart = (line.length >= 3 && line[2] === ' ') ? 3 : 2;
    const filePath = line.slice(pathStart).split(' -> ')[0];

    // Check if file is gitignored
    const ignoreCheck = await execCommand(`git check-ignore -q "${filePath}"`, cwd);
    if (!ignoreCheck.success) {
      // File is NOT ignored - we have real uncommitted changes
      return true;
    }
  }

  // All files were gitignored
  return false;
}

/**
 * Get list of non-gitignored uncommitted files for staging
 * @param cwd - Working directory
 * @returns List of file paths to stage
 * @example
 */
async function getNonIgnoredChanges(cwd: string): Promise<string[]> {
  const result = await execCommand('git status --porcelain', cwd);
  if (!result.success || !result.stdout) {
    return [];
  }

  const nonIgnoredFiles: string[] = [];
  const lines = result.stdout.split('\n').filter(Boolean);

  for (const line of lines) {
    // Git porcelain format: XY<space>filename (XY = 2 status chars)
    // But stdout.trim() may have removed a leading space from " M filename"
    // Detect by checking if position 2 is a space (not trimmed) or not (trimmed)
    const pathStart = (line.length >= 3 && line[2] === ' ') ? 3 : 2;
    const filePath = line.slice(pathStart).split(' -> ')[0];
    const ignoreCheck = await execCommand(`git check-ignore -q "${filePath}"`, cwd);
    if (!ignoreCheck.success) {
      nonIgnoredFiles.push(filePath);
    }
  }

  return nonIgnoredFiles;
}

/**
 * Get current git branch name
 * @param cwd - Working directory
 * @returns Branch name or null if detached HEAD
 * @example
 */
async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  return result.success ? result.stdout : null;
}

/**
 * Get current HEAD commit SHA
 * @param cwd - Working directory
 * @returns Full commit SHA or null if not in git repo
 * @example
 */
async function getCurrentHeadSha(cwd: string): Promise<string | null> {
  const result = await execCommand('git rev-parse HEAD', cwd);
  return result.success ? result.stdout : null;
}

/**
 * Get git repository root directory
 * Normalizes cwd to repo root to ensure git commands work correctly
 * even when hook is invoked from a subdirectory (e.g., subagent in apps/web/)
 * @param cwd - Working directory (may be subdirectory)
 * @returns Repository root path, or original cwd if not in a git repo
 * @example
 */
async function getRepoRoot(cwd: string): Promise<string> {
  const result = await execCommand('git rev-parse --show-toplevel', cwd);
  return result.success ? result.stdout : cwd;
}

/**
 * Check if there are merge conflicts in the working directory
 * @param cwd - Working directory
 * @returns Object with conflict status and list of conflicted files
 * @example
 */
async function checkMergeConflicts(cwd: string): Promise<{
  hasConflicts: boolean;
  conflictedFiles: string[];
}> {
  // Check git status for unmerged paths
  const unmergedResult = await execCommand('git ls-files --unmerged', cwd);
  const hasUnmerged = unmergedResult.stdout.length > 0;

  // Get list of conflicted files
  const conflictFilesResult = await execCommand('git diff --name-only --diff-filter=U', cwd);
  const conflictedFiles = conflictFilesResult.stdout
    ? conflictFilesResult.stdout.split('\n').filter(Boolean)
    : [];

  return {
    hasConflicts: hasUnmerged || conflictedFiles.length > 0,
    conflictedFiles,
  };
}

/**
 * Check if branch is up to date with remote
 * @param cwd - Working directory
 * @returns Object with sync status, commits behind/ahead, and remote branch name
 * @example
 */
async function checkBranchSync(cwd: string): Promise<{
  isSynced: boolean;
  behindBy: number;
  aheadBy: number;
  remoteBranch: string;
}> {
  // Get current branch
  const branchResult = await execCommand('git branch --show-current', cwd);
  const currentBranch = branchResult.stdout;

  if (!currentBranch) {
    return {
      isSynced: true,
      behindBy: 0,
      aheadBy: 0,
      remoteBranch: '',
    };
  }

  // Fetch latest from remote
  await execCommand('git fetch', cwd);

  // Get tracking branch
  const trackingResult = await execCommand(
    `git rev-parse --abbrev-ref ${currentBranch}@{upstream}`,
    cwd
  );

  if (!trackingResult.success) {
    // No tracking branch set up
    return {
      isSynced: true,
      behindBy: 0,
      aheadBy: 0,
      remoteBranch: '',
    };
  }

  const remoteBranch = trackingResult.stdout;

  // Check how many commits behind/ahead we are
  const revListResult = await execCommand(
    `git rev-list --left-right --count ${currentBranch}...${remoteBranch}`,
    cwd
  );

  if (!revListResult.success) {
    return {
      isSynced: true,
      behindBy: 0,
      aheadBy: 0,
      remoteBranch,
    };
  }

  // Parse output: "ahead\tbehind"
  const [aheadStr, behindStr] = revListResult.stdout.split('\t');
  const aheadBy = parseInt(aheadStr || '0', 10);
  const behindBy = parseInt(behindStr || '0', 10);

  return {
    isSynced: behindBy === 0,
    behindBy,
    aheadBy,
    remoteBranch,
  };
}

/**
 * Get number of commits ahead of origin/main (or origin/master)
 * Used to determine if a PR is needed (separate from sync check)
 */
async function getCommitsAheadOfMain(cwd: string): Promise<number> {
  // Try origin/main first, then origin/master
  for (const mainBranch of ['origin/main', 'origin/master']) {
    const result = await execCommand(
      `git rev-list --count ${mainBranch}..HEAD`,
      cwd
    );
    if (result.success) {
      return parseInt(result.stdout || '0', 10);
    }
  }
  return 0;
}

// ============================================================================
// GitHub CLI Operations
// ============================================================================

/**
 * Check if a PR exists for the current branch
 *
 * Uses GitHub CLI to query for existing PRs where the head branch
 * matches the current branch name.
 * @param branch - Current branch name
 * @param cwd - Working directory
 * @returns Object with PR existence status, number, URL, or error
 * @example
 */
async function checkPRExists(
  branch: string,
  cwd: string
): Promise<{
  exists: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}> {
  // Check if gh CLI is available
  const ghCheck = await execCommand('gh --version', cwd);
  if (!ghCheck.success) {
    return {
      exists: false,
      error: 'GitHub CLI not installed'
    };
  }

  // Check if gh is authenticated
  const authCheck = await execCommand('gh auth status', cwd);
  if (!authCheck.success) {
    return {
      exists: false,
      error: 'GitHub CLI not authenticated'
    };
  }

  // List PRs for current branch
  const prListResult = await execCommand(
    `gh pr list --head ${branch} --json number,url --limit 1`,
    cwd
  );

  if (!prListResult.success) {
    return {
      exists: false,
      error: `gh pr list failed: ${prListResult.stderr}`
    };
  }

  // Parse JSON output
  try {
    const prs = JSON.parse(prListResult.stdout);

    if (Array.isArray(prs) && prs.length > 0) {
      return {
        exists: true,
        prNumber: prs[0].number,
        prUrl: prs[0].url,
      };
    }

    return { exists: false };
  } catch (parseError) {
    return {
      exists: false,
      error: `Failed to parse gh output: ${parseError}`
    };
  }
}

// Local CI functions removed - using shared utilities from ci-status.ts:
// - getLatestCIRun -> getCIRunDetails
// - getVercelPreviewUrls -> extractPreviewUrls
// - waitForCIChecks -> awaitCIWithFailFast

// ============================================================================
// Subagent Activity Detection
// ============================================================================

/**
 * Check if there has been recent subagent activity
 *
 * Detects if a subagent just stopped and may be awaiting user input.
 * If true, skips PR encouragement to avoid interrupting workflow.
 * @param cwd - Working directory
 * @returns True if recent subagent activity detected
 * @example
 */
async function hasRecentSubagentActivity(cwd: string): Promise<boolean> {
  const tasksFilePath = join(cwd, '.claude', 'logs', 'subagent-tasks.json');

  try {
    if (!existsSync(tasksFilePath)) {
      return false;
    }

    const content = readFileSync(tasksFilePath, 'utf-8');
    const tasks = JSON.parse(content);

    // If any subagent contexts exist, there's recent subagent activity
    return Object.keys(tasks).length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Validation Checks
// ============================================================================

/**
 * Run claude doctor to check for settings issues
 *
 * Executes `claude doctor` command and parses output for errors.
 * @param cwd - Working directory
 * @returns Object with health status and any issues found
 * @example
 */
async function checkClaudeDoctor(cwd: string): Promise<{
  healthy: boolean;
  issues: string[];
  error?: string;
}> {
  // Check if claude CLI is available
  const claudeCheck = await execCommand('claude --version', cwd);
  if (!claudeCheck.success) {
    return {
      healthy: true, // Don't block if claude not available
      issues: [],
      error: 'Claude CLI not available'
    };
  }

  // Run claude doctor
  const doctorResult = await execCommand('claude doctor --json 2>&1', cwd);

  // Check for known non-settings errors first
  const knownNonSettingsErrors = [
    'Raw mode is not supported',
    'isRawModeSupported',
    'Ink',
    'Command failed: claude doctor',
  ];

  const errorText = doctorResult.stderr || doctorResult.stdout || '';
  const isNonSettingsError = knownNonSettingsErrors.some(
    pattern => errorText.includes(pattern)
  );

  if (!doctorResult.success && isNonSettingsError) {
    // Terminal/UI error, not a settings issue
    return {
      healthy: true,
      issues: [],
      error: 'Claude doctor failed due to terminal limitations (non-blocking)'
    };
  }

  // Parse output
  try {
    // Try to parse as JSON first
    if (doctorResult.stdout) {
      const doctorOutput = JSON.parse(doctorResult.stdout);

      // Check for errors or warnings in output
      const issues: string[] = [];

      if (doctorOutput.errors && Array.isArray(doctorOutput.errors)) {
        issues.push(...doctorOutput.errors);
      }

      if (doctorOutput.warnings && Array.isArray(doctorOutput.warnings)) {
        issues.push(...doctorOutput.warnings);
      }

      return {
        healthy: issues.length === 0,
        issues
      };
    }

    // If no JSON output, check exit code
    if (!doctorResult.success && !isNonSettingsError) {
      return {
        healthy: false,
        issues: [doctorResult.stderr || 'Unknown error']
      };
    }

    return {
      healthy: true,
      issues: []
    };
  } catch {
    // If JSON parsing fails, check exit code
    if (!doctorResult.success && !isNonSettingsError) {
      return {
        healthy: false,
        issues: [doctorResult.stderr || doctorResult.stdout || 'Claude doctor failed']
      };
    }

    return {
      healthy: true,
      issues: []
    };
  }
}

/**
 * Validate all registered hooks point to real files
 *
 * Checks both plugin hooks and .claude/hooks directory for missing files.
 * @param cwd - Working directory
 * @returns Object with validation status and missing files
 * @example
 */
async function validateHookFiles(cwd: string): Promise<{
  valid: boolean;
  missingFiles: string[];
  error?: string;
}> {
  const missingFiles: string[] = [];

  try {
    // Check .claude/settings.json for enabled plugins
    const settingsPath = join(cwd, '.claude', 'settings.json');

    if (!existsSync(settingsPath)) {
      // No settings file, skip validation
      return { valid: true, missingFiles: [] };
    }

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const enabledPlugins = settings.enabledPlugins || {};

    // For each enabled plugin, check hooks
    for (const [pluginName, enabled] of Object.entries(enabledPlugins)) {
      if (!enabled) continue;

      // Try to find plugin in cache
      const pluginCachePath = join(
        process.env.HOME || '/home',
        '.claude',
        'plugins',
        'cache',
        pluginName.replace('@', '/'),
        'hooks',
        'hooks.json'
      );

      if (existsSync(pluginCachePath)) {
        const hooksConfig = JSON.parse(readFileSync(pluginCachePath, 'utf-8'));

        if (hooksConfig.hooks) {
          // Validate hook files
          for (const eventHooks of Object.values(hooksConfig.hooks)) {
            if (!Array.isArray(eventHooks)) continue;

            for (const hookGroup of eventHooks) {
              if (!hookGroup.hooks) continue;

              for (const hook of hookGroup.hooks) {
                if (hook.type === 'command' && hook.command) {
                  // Extract file path from command (remove npx tsx and ${CLAUDE_PLUGIN_ROOT})
                  const commandMatch = hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/);
                  if (commandMatch) {
                    const hookFile = commandMatch[1];
                    const pluginDir = pluginCachePath.replace('/hooks/hooks.json', '');
                    const hookPath = join(pluginDir, hookFile);

                    if (!existsSync(hookPath)) {
                      missingFiles.push(`${pluginName}: ${hookFile}`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Check local .claude/hooks directory
    const localHooksDir = join(cwd, '.claude', 'hooks');
    if (existsSync(localHooksDir)) {
      const localHooksJson = join(localHooksDir, 'hooks.json');

      if (existsSync(localHooksJson)) {
        const localHooksConfig = JSON.parse(readFileSync(localHooksJson, 'utf-8'));

        if (localHooksConfig.hooks) {
          for (const eventHooks of Object.values(localHooksConfig.hooks)) {
            if (!Array.isArray(eventHooks)) continue;

            for (const hookGroup of eventHooks) {
              if (!hookGroup.hooks) continue;

              for (const hook of hookGroup.hooks) {
                if (hook.type === 'command' && hook.command) {
                  // For local hooks, files should be relative to .claude/hooks
                  const commandMatch = hook.command.match(/hooks\/(.+\.ts)$/);
                  if (commandMatch) {
                    const hookFile = commandMatch[1];
                    const hookPath = join(localHooksDir, hookFile);

                    if (!existsSync(hookPath)) {
                      missingFiles.push(`.claude/hooks: ${hookFile}`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    return {
      valid: missingFiles.length === 0,
      missingFiles
    };
  } catch (error) {
    return {
      valid: true, // Don't block on validation errors
      missingFiles: [],
      error: `Hook validation error: ${error}`
    };
  }
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Format commit message with session metadata
 * @param sessionId - Session ID
 * @param branch - Current branch name
 * @returns Formatted commit message
 * @example
 */
function formatCommitMessage(sessionId: string, branch: string | null): string {
  const timestamp = new Date().toISOString();
  return `Session work

Auto-commit at session end to preserve work in progress.

Session-ID: ${sessionId}
Session-Timestamp: ${timestamp}${branch ? `\nBranch: ${branch}` : ''}

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`;
}

/**
 * Format a linked issue for display
 * @param issue - Issue info with number, url, and repo
 * @param prRepo - PR's repository for comparison
 * @returns Formatted issue string
 */
function formatLinkedIssue(issue: LinkedIssueInfo, prRepo: string): string {
  // If same repo as PR, show just #number
  // If different repo, show owner/repo#number
  const prefix = issue.repo === prRepo ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
  const titlePart = issue.title ? ` - ${issue.title}` : '';
  return `${prefix}${titlePart} → ${issue.url}`;
}

/**
 * Format a session issue for display (other issues section)
 * @param issue - Issue reference from session tracking
 * @param currentRepo - Current repository for comparison
 * @returns Formatted issue string
 */
function formatSessionIssue(issue: IssueReference, currentRepo: string): string {
  // If same repo, show just #number; if different, show owner/repo#number
  const prefix = issue.repo === currentRepo ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
  const titlePart = issue.title ? ` - ${issue.title}` : '';
  return `${prefix}${titlePart} → ${issue.url}`;
}

/**
 * Format PR status message when commit was made and PR exists
 * @param commitSha - Commit SHA
 * @param prCheck - PR details
 * @param prCheck.prNumber - PR number
 * @param prCheck.prUrl - PR URL
 * @param ciRun - CI run details
 * @param ciRun.url - CI run URL
 * @param ciRun.status - CI run status
 * @param ciRun.conclusion - CI run conclusion
 * @param ciRun.name - CI run name
 * @param groupedPreviews - Preview URLs grouped by provider
 * @param linkedIssues - Issues linked from PR body (closes when merged)
 * @param otherIssues - Other issues created during session but not linked to PR
 * @param prRepo - PR's repository name (owner/repo)
 * @returns Formatted message
 * @example
 */
function formatPRStatusWithCommit(
  commitSha: string,
  prCheck: { prNumber: number; prUrl: string },
  ciRun: { url?: string; status?: string; conclusion?: string; name?: string },
  groupedPreviews: GroupedPreviewUrls,
  linkedIssues: LinkedIssueInfo[],
  otherIssues: IssueReference[],
  prRepo: string
): string {
  const ciPassed = ciRun.conclusion === 'success';
  const ciFailed = ciRun.conclusion === 'failure';

  let message = `✅ Auto-committed: ${commitSha}\n\n`;

  // PR link (prominently displayed)
  message += `📋 PR: ${prCheck.prUrl}\n`;

  // CI run link (prominently displayed)
  if (ciRun.url) {
    const statusIcon = ciPassed ? '✅' : ciFailed ? '❌' : '⏳';
    message += `🔄 CI: ${ciRun.url} ${statusIcon} ${ciRun.conclusion || ciRun.status || 'pending'}\n`;
  }

  // Linked issues (closes when merged) - nested under PR
  if (linkedIssues.length > 0) {
    message += '\n   📌 Linked Issues (closes when merged):\n';
    for (const issue of linkedIssues) {
      message += `      • ${formatLinkedIssue(issue, prRepo)}\n`;
    }
  }

  // Other issues created during session (not linked to PR)
  if (otherIssues.length > 0) {
    message += '\n📝 Other Issues Created:\n';
    for (const issue of otherIssues) {
      message += `   • ${formatSessionIssue(issue, prRepo)}\n`;
    }
  }

  // Vercel Previews
  if (groupedPreviews.vercel.length > 0) {
    message += '\n🔼 Vercel Previews:\n';
    for (const url of groupedPreviews.vercel) {
      message += `   • ${url}\n`;
    }
  }

  // Cloudflare Previews
  if (groupedPreviews.cloudflare.length > 0) {
    message += '\n☁️ Cloudflare Worker Previews:\n';
    for (const url of groupedPreviews.cloudflare) {
      message += `   • ${url}\n`;
    }
  }

  // Supabase Previews
  if (groupedPreviews.supabase.length > 0) {
    message += '\n⚡ Supabase Preview Branches:\n';
    for (const url of groupedPreviews.supabase) {
      message += `   • ${url}\n`;
    }
  }

  message += '\nPress enter to continue.';
  return message;
}

/**
 * Format PR status info message
 * @param prCheck - PR details
 * @param prCheck.prNumber - PR number
 * @param prCheck.prUrl - PR URL
 * @param ciRun - CI run details
 * @param ciRun.url - CI run URL
 * @param ciRun.status - CI run status
 * @param ciRun.conclusion - CI run conclusion
 * @param ciRun.name - CI run name
 * @param groupedPreviews - Preview URLs grouped by provider
 * @param linkedIssues - Issues linked from PR body (closes when merged)
 * @param otherIssues - Other issues created during session but not linked to PR
 * @param prRepo - PR's repository name (owner/repo)
 * @returns Formatted message
 * @example
 */
function formatPRStatusInfo(
  prCheck: { prNumber: number; prUrl: string },
  ciRun: { url?: string; status?: string; conclusion?: string; name?: string },
  groupedPreviews: GroupedPreviewUrls,
  linkedIssues: LinkedIssueInfo[],
  otherIssues: IssueReference[],
  prRepo: string
): string {
  // Header (simplified - this function only called when CI passed or pending)
  let message = '✅ PR Ready for Review\n\n';

  // PR link with markdown format (clickable)
  message += `📋 [View PR #${prCheck.prNumber}](${prCheck.prUrl})\n`;

  // CI run link with markdown format
  if (ciRun.url) {
    message += `🔄 [View CI Run](${ciRun.url}) ✅ success\n`;
  }

  // Linked issues (closes when merged) - nested under PR
  if (linkedIssues.length > 0) {
    message += '\n   📌 Linked Issues (closes when merged):\n';
    for (const issue of linkedIssues) {
      message += `      • ${formatLinkedIssue(issue, prRepo)}\n`;
    }
  }

  // Other issues created during session (not linked to PR)
  if (otherIssues.length > 0) {
    message += '\n📝 Other Issues Created:\n';
    for (const issue of otherIssues) {
      message += `   • ${formatSessionIssue(issue, prRepo)}\n`;
    }
  }

  // Vercel Previews
  if (groupedPreviews.vercel.length > 0) {
    message += '\n🔼 Vercel Previews:\n';
    for (const url of groupedPreviews.vercel) {
      message += `   • ${url}\n`;
    }
  }

  // Cloudflare Previews
  if (groupedPreviews.cloudflare.length > 0) {
    message += '\n☁️ Cloudflare Worker Previews:\n';
    for (const url of groupedPreviews.cloudflare) {
      message += `   • ${url}\n`;
    }
  }

  // Supabase Previews
  if (groupedPreviews.supabase.length > 0) {
    message += '\n⚡ Supabase Preview Branches:\n';
    for (const url of groupedPreviews.supabase) {
      message += `   • ${url}\n`;
    }
  }

  message += '\nPress enter to continue.';
  return message;
}

/**
 * Format blocking error messages for various checks
 * @param conflictedFiles - List of files with merge conflicts
 * @returns Formatted error message
 * @example
 */
function formatConflictError(conflictedFiles: string[]): string {
  return [
    '🚨 Merge Conflicts Detected:',
    '',
    `⚠️  ${conflictedFiles.length} file(s) have unresolved conflicts:`,
    ...conflictedFiles.map(f => `  - ${f}`),
    '',
    'Please resolve these conflicts before ending the session:',
    '  • Open conflicted files and resolve markers (<<<<<<, ======, >>>>>>)',
    '  • Stage resolved files: git add <file>',
    '  • Or use: git mergetool',
  ].join('\n');
}

function formatSyncError(syncCheck: { behindBy: number; aheadBy: number; remoteBranch: string }): string {
  return [
    '🚨 Branch Out of Sync:',
    '',
    `⚠️  Your branch is ${syncCheck.behindBy} commit(s) behind ${syncCheck.remoteBranch}`,
    `  (You are ${syncCheck.aheadBy} commit(s) ahead)`,
    '',
    'Please sync your branch before ending the session:',
    '  • Pull and merge: git pull',
    '  • Or rebase: git pull --rebase',
    '',
    'This prevents conflicts and ensures you\'re working with the latest code.',
  ].join('\n');
}

function formatDoctorErrors(issues: string[]): string {
  return [
    '🚨 Claude Code Settings Issues Detected:',
    '',
    ...issues.map(issue => `⚠️  ${issue}`),
    '',
    'Please fix these settings issues before ending the session:',
    '  • Run: claude doctor',
    '  • Review and fix reported issues',
    '  • Check .claude/settings.json for configuration errors',
  ].join('\n');
}

function formatHookErrors(missingFiles: string[]): string {
  return [
    '🚨 Missing Hook Files Detected:',
    '',
    `⚠️  ${missingFiles.length} hook file(s) are missing:`,
    ...missingFiles.map(file => `  - ${file}`),
    '',
    'Please fix these hook issues before ending the session:',
    '  • Reinstall affected plugins: claude plugin install <plugin-name>',
    '  • Or remove broken plugins from .claude/settings.json',
    '  • Check plugin cache: ~/.claude/plugins/cache/',
  ].join('\n');
}

/**
 * Format agent instructions for progressive blocking
 * @param sessionId - Session ID
 * @param branch - Current branch name
 * @param issueNumber - Linked issue number (or null)
 * @param issueUrl - Linked issue URL (or null)
 * @param blockCount - Number of times blocked
 * @param skipInstructions - Skip instructions if subagent active
 * @returns Formatted agent instruction message
 * @example
 */
function formatAgentInstructions(
  sessionId: string,
  branch: string,
  issueNumber: number | null,
  issueUrl: string | null,
  blockCount: number,
  skipInstructions: boolean
): string {
  if (skipInstructions) {
    return `⏸️  Subagent just stopped - awaiting your input (Session: ${sessionId})`;
  }

  const header = blockCount === 1
    ? '🤖 SESSION COMMIT CHECKPOINT'
    : `🤖 SESSION COMMIT CHECKPOINT (Attempt ${blockCount}/3)`;

  let issueSection = '';
  if (issueNumber && issueUrl) {
    issueSection = `
**Linked Issue:** #${issueNumber}
${issueUrl}

   Use ONE of these methods to post your comment:

   METHOD A - Direct command (include the session marker):
   gh issue comment ${issueNumber} --body $'<!-- claude-session: ${sessionId} -->\\n\\nWork completed:\\n- Item 1\\n- Item 2'

   METHOD B - Helper function (recommended for complex content):
   Use Bash tool to run:
   npx tsx -e "import { postSessionComment } from './plugins/github-context/shared/hooks/utils/github-comments.js'; await postSessionComment(${issueNumber}, '${sessionId}', 'Work completed:\\n- Item 1\\n- Item 2', '${branch}', process.cwd());"`;
  } else {
    issueSection = `
   First discover the linked issue number, then post a comment with your session ID.
   Use gh issue list or parse from branch name pattern.`;
  }

  return `${header}

Session ID: ${sessionId}
Branch: ${branch}

You've made commits but haven't created a PR yet.

Please choose ONE of the following:

1. CREATE A PR
   gh pr create --title "..." --body "..."

2. DOCUMENT PROGRESS
   Post a comment to the linked issue documenting:
   - What work you checked/reviewed
   - What you accomplished
   - Any issues or confusion noted
${issueSection}

   IMPORTANT: Your comment must include the session ID marker shown above.
   The hook detects either the HTML marker or the plain session ID in your comment.`;
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Stop hook handler
 *
 * Unified hook that combines auto-commit and PR status checking.
 * Executes in four phases:
 * 1. Blocking validation checks (merge conflicts, branch sync, etc.)
 * 2. Auto-commit uncommitted changes
 * 3. PR status check (if applicable)
 * 4. Output decision based on state
 * @param input - Stop hook input from Claude Code
 * @returns Hook output with blocking decision or system message
 * @example
 */
async function handler(input: StopInput): Promise<StopHookOutput> {
  const logger = createDebugLogger(input.cwd, 'commit-session-check-pr-status', true);

  // Skip blocking behavior in plan mode - Claude is just exploring/planning
  if (input.permission_mode === 'plan') {
    return { decision: 'approve' };
  }

  try {
    await logger.logInput({ session_id: input.session_id });

    // Normalize cwd to repo root - critical for subagents running from subdirectories
    // (e.g., subagent with cwd=apps/web/ needs to check commits at repo root)
    const repoRoot = await getRepoRoot(input.cwd);

    // Load session state for progressive blocking (uses repoRoot for state file location)
    const sessionState = await getSessionStopState(input.session_id, repoRoot);

    // === PHASE 1: BLOCKING CHECKS ===
    // These must pass before we proceed

    // Check if in git repository
    const gitCheck = await execCommand('git rev-parse --is-inside-work-tree', repoRoot);
    if (!gitCheck.success) {
      await logger.logOutput({ skipped: true, reason: 'Not a git repository' });
      return { decision: 'approve' };
    }

    // Check Claude settings health
    const doctorCheck = await checkClaudeDoctor(repoRoot);
    if (!doctorCheck.healthy && doctorCheck.issues.length > 0) {
      return {
        decision: 'block',
        reason: formatDoctorErrors(doctorCheck.issues),
        systemMessage: 'Claude is blocked from stopping due to configuration issues.',
      };
    }

    // Validate hook files exist
    const hookValidation = await validateHookFiles(repoRoot);
    if (!hookValidation.valid && hookValidation.missingFiles.length > 0) {
      return {
        decision: 'block',
        reason: formatHookErrors(hookValidation.missingFiles),
        systemMessage: 'Claude is blocked from stopping due to missing hook files.',
      };
    }

    // Check for merge conflicts
    const conflictCheck = await checkMergeConflicts(repoRoot);
    if (conflictCheck.hasConflicts) {
      return {
        decision: 'block',
        reason: formatConflictError(conflictCheck.conflictedFiles),
        systemMessage: 'Claude is blocked from stopping due to merge conflicts.',
      };
    }

    // Check branch sync status (behind remote)
    const syncCheck = await checkBranchSync(repoRoot);
    if (!syncCheck.isSynced && syncCheck.remoteBranch) {
      return {
        decision: 'block',
        reason: formatSyncError(syncCheck),
        systemMessage: 'Claude is blocked from stopping due to branch sync issues.',
      };
    }

    // Get commits ahead of main (for PR detection - separate from sync check)
    // This determines if a PR is needed, regardless of whether we've pushed
    let commitsAheadOfMain = await getCommitsAheadOfMain(repoRoot);

    // === PHASE 2: AUTO-COMMIT ===
    let commitMade = false;
    let commitSha = '';

    const hasChanges = await hasUncommittedChanges(repoRoot);

    if (hasChanges) {
      const branch = await getCurrentBranch(repoRoot);
      const protectedBranches = ['main', 'master', 'develop'];
      const isProtectedBranch = branch !== null && protectedBranches.includes(branch);

      if (isProtectedBranch) {
        await logger.logOutput({
          skipped: true,
          reason: `Refusing to auto-commit on protected branch: ${branch}`,
        });
      }

      if (!isProtectedBranch) {
        // Only stage non-gitignored files
        const filesToStage = await getNonIgnoredChanges(repoRoot);
        if (filesToStage.length === 0) {
          // All changes are gitignored - skip commit
          await logger.logOutput({ skipped: true, reason: 'All changes are gitignored' });
        } else {
          // Stage only non-ignored files
          for (const file of filesToStage) {
            await execCommand(`git add "${file}"`, repoRoot);
          }

          const commitMessage = formatCommitMessage(input.session_id, branch);
          const commitResult = await execCommand(
            `git commit -m ${JSON.stringify(commitMessage)}`,
            repoRoot
          );

          if (commitResult.success) {
            const shaResult = await execCommand('git rev-parse HEAD', repoRoot);
            const fullSha = shaResult.success ? shaResult.stdout : null;
            commitSha = fullSha ? fullSha.substring(0, 7) : 'unknown';
            commitMade = true;

            await logger.logOutput({ commit_made: true, commit_sha: commitSha });

            // Update state with new commit SHA for tracking
            await updateSessionStopState(input.session_id, {
              blockCount: sessionState.blockCount + 1,
              lastBlockTimestamp: new Date().toISOString(),
              lastSeenCommitSha: fullSha || undefined,
            }, repoRoot);

            // Re-check branch sync after commit
            const postCommitSync = await checkBranchSync(repoRoot);
            syncCheck.aheadBy = postCommitSync.aheadBy;
            // Also update commits ahead of main
            commitsAheadOfMain = await getCommitsAheadOfMain(repoRoot);
          } else {
            await logger.logOutput({ commit_failed: true, error: commitResult.stderr });
          }
        }
      }
    }

    // === PHASE 3: PR STATUS CHECK ===
    const currentBranch = await getCurrentBranch(repoRoot);

    // Skip PR checks for main branches
    const mainBranches = ['main', 'master', 'develop'];
    if (!currentBranch || mainBranches.includes(currentBranch)) {
      if (commitMade) {
        return {
          decision: 'block',
          reason: `✅ Auto-committed session work: ${commitSha}\n\nPush to remote before ending session.`,
        };
      }
      return { decision: 'approve' };
    }

    // Check if subagent just stopped (awaiting user input)
    const hasSubagentActivity = await hasRecentSubagentActivity(repoRoot);

    // Check if PR exists
    const prCheck = await checkPRExists(currentBranch, repoRoot);

    // === PHASE 4: OUTPUT DECISION WITH AGENT COMMUNICATION ===

    // Check if PR created since last block
    if (prCheck.exists && prCheck.prNumber && prCheck.prUrl) {
      // PR exists - wait for CI checks with fail-fast behavior
      await logger.logOutput({
        pr_exists: true,
        pr_number: prCheck.prNumber,
        waiting_for_ci: true
      });

      const ciResult = await awaitCIWithFailFast({ prNumber: prCheck.prNumber }, repoRoot);

      // If CI failed, block with concise error message + log file link
      if (!ciResult.success) {
        // Format checks output for logging
        const checksOutput = ciResult.checks.map(c => `${c.emoji} ${c.name}: ${c.status}`).join('\n');
        const logPath = await saveOutputToLog(repoRoot, 'ci', `pr-${prCheck.prNumber}`, checksOutput);

        // Map ci-status CheckStatus to log-file format
        const mappedChecks = ciResult.checks.map(c => ({
          name: c.name,
          status: (c.status === 'success' ? 'pass' :
                   c.status === 'failure' ? 'fail' :
                   c.status === 'cancelled' ? 'skipped' : 'pending') as 'pass' | 'fail' | 'pending' | 'skipped',
          duration: '',
        }));
        const checksTable = formatCiChecksTable(mappedChecks, logPath);

        await logger.logOutput({
          ci_status: 'failed',
          log_path: logPath,
          ci_error: ciResult.error,
          failed_check: ciResult.failedCheck
        });

        return {
          decision: 'block',
          reason: `${ciResult.blockReason || `❌ CI failed for PR #${prCheck.prNumber}`}

${checksTable}

🔗 [View PR](${prCheck.prUrl})
   \`gh pr checks ${prCheck.prNumber}\``,
          systemMessage: 'Claude is blocked from stopping due to CI check failures.',
        };
      }

      // CI passed - reset state and show success
      await resetSessionStopState(input.session_id, repoRoot);
      await logger.logOutput({
        ci_status: 'passed',
        checks: ciResult.checks
      });

      // Fetch PR details, previews, linked issues, and session issues in parallel
      const [ciRun, groupedPreviews, linkedIssues, sessionIssues] = await Promise.all([
        getCIRunDetails(prCheck.prNumber, repoRoot).then(r => r ?? {}),
        extractAllPreviews(prCheck.prNumber, repoRoot),
        extractLinkedIssuesWithInfo(prCheck.prNumber, repoRoot),
        getSessionIssues(input.session_id, repoRoot),
      ]);

      // Extract PR repo from URL for display formatting
      const prRepoMatch = prCheck.prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
      const prRepo = prRepoMatch ? prRepoMatch[1] : '';

      // Filter session issues to find "other issues" not linked to the PR
      const linkedIssueKeys = new Set(linkedIssues.map(i => `${i.repo}#${i.number}`));
      const otherIssues = sessionIssues.filter(
        issue => !linkedIssueKeys.has(`${issue.repo}#${issue.number}`)
      );

      // Track PR in github.json (store just issue numbers for backwards compatibility)
      await addPRToState(
        input.session_id,
        {
          number: prCheck.prNumber,
          url: prCheck.prUrl,
          title: '', // We don't have title here, could fetch if needed
          createdAt: new Date().toISOString(),
          linkedIssues: linkedIssues.map(i => i.number),
        },
        repoRoot
      );

      // If CI run shows failure, block Claude (don't show to user)
      if (ciRun.conclusion === 'failure' || ciRun.conclusion === 'cancelled') {
        const failedStatus = ciRun.conclusion === 'cancelled' ? 'cancelled' : 'failed';
        return {
          decision: 'block',
          reason: `❌ CI ${failedStatus} for PR #${prCheck.prNumber}

🔗 [View PR](${prCheck.prUrl})
   [View CI Run](${ciRun.url})`,
          systemMessage: `Claude is blocked from stopping due to CI ${failedStatus}.`,
        };
      }

      if (commitMade) {
        // Show PR status after commit (non-blocking)
        return {
          decision: 'approve',
          systemMessage: formatPRStatusWithCommit(commitSha, { prNumber: prCheck.prNumber, prUrl: prCheck.prUrl }, ciRun, groupedPreviews, linkedIssues, otherIssues, prRepo),
        };
      } else if (commitsAheadOfMain > 0) {
        // Show PR status to user (non-blocking)
        return {
          decision: 'approve',
          systemMessage: formatPRStatusInfo({ prNumber: prCheck.prNumber, prUrl: prCheck.prUrl }, ciRun, groupedPreviews, linkedIssues, otherIssues, prRepo),
        };
      } else {
        // Always show PR status when PR exists, even if no new commits this session (non-blocking)
        return {
          decision: 'approve',
          systemMessage: formatPRStatusInfo({ prNumber: prCheck.prNumber, prUrl: prCheck.prUrl }, ciRun, groupedPreviews, linkedIssues, otherIssues, prRepo),
        };
      }
    }

    // No PR - check if comment posted for this session
    // First check session state flag (survives across stop attempts)
    // BUT also check if new commits were made since the comment was posted
    if (sessionState.commentPosted) {
      const currentHeadSha = await getCurrentHeadSha(repoRoot);

      // If we have a commentPostedAtSha, check if new commits were made since then
      if (sessionState.commentPostedAtSha &&
          currentHeadSha !== sessionState.commentPostedAtSha) {
        // New commits since comment - reset flag and require new documentation
        await logger.logOutput({ debug: 'New commits since comment - resetting commentPosted flag' });
        await updateSessionStopState(input.session_id, {
          commentPosted: false,
          commentPostedAtSha: undefined,
        }, repoRoot);
        // Fall through to blocking logic below
      } else {
        // Same commit or no tracking - allow stop
        await logger.logOutput({ debug: 'Comment previously posted - allowing stop' });
        return {
          decision: 'approve',
          systemMessage: '✅ Session progress already documented'
        };
      }
    }

    // Try to discover linked issue
    // First try branch-issues.json, then fallback to linked issue discovery
    const branchIssueInfo = await getBranchIssueInfo(currentBranch, repoRoot);
    const issueNumber = branchIssueInfo?.issueNumber ?? await getLinkedIssueNumber(currentBranch, repoRoot);
    const issueUrl = branchIssueInfo?.issueUrl ?? null;

    // Check GitHub for comment if we have an issue number
    if (issueNumber && await hasCommentForSession(issueNumber, input.session_id, repoRoot)) {
      // Comment posted - update state flag, save SHA, and reset block count
      const currentSha = await getCurrentHeadSha(repoRoot);
      await updateSessionStopState(input.session_id, {
        commentPosted: true,
        commentPostedAtSha: currentSha || undefined,  // Track when comment was posted
        blockCount: 0,
      }, repoRoot);

      return {
        decision: 'approve',
        systemMessage: `✅ Session progress documented in issue #${issueNumber}`
      };
    }

    // Log if issue discovery failed (helps debug blocking issues)
    if (!issueNumber) {
      await logger.logOutput({ debug: 'Could not discover linked issue number for branch: ' + currentBranch });
    }

    // No PR and no comment - determine blocking behavior based on commit tracking
    // Get current HEAD to compare with last seen commit
    const currentHeadSha = await getCurrentHeadSha(repoRoot);
    const sawNewCommits = currentHeadSha !== sessionState.lastSeenCommitSha;

    // If we saw new commits (either just made or from previous session without PR)
    // Use commitsAheadOfMain (not syncCheck.aheadBy) to detect if PR is needed
    if (sawNewCommits && commitsAheadOfMain > 0) {
      // Update lastSeenCommitSha so we only block ONCE for these commits
      await updateSessionStopState(input.session_id, {
        lastSeenCommitSha: currentHeadSha || undefined,
        lastBlockTimestamp: new Date().toISOString(),
      }, repoRoot);

      // Block with agent instructions - first time seeing these commits
      return {
        decision: 'block',
        reason: formatAgentInstructions(input.session_id, currentBranch, issueNumber, issueUrl, 1, hasSubagentActivity),
        systemMessage: 'Claude is blocked from stopping - PR or issue comment required.',
      };
    }

    // Already saw these commits (lastSeenCommitSha matches current HEAD)
    // Branch is ahead of main but we've already blocked once for these commits
    if (commitsAheadOfMain > 0) {
      return {
        decision: 'approve',
        systemMessage: `ℹ️ Branch has ${commitsAheadOfMain} commit(s) ahead of main without a PR. Agent chose to stop without creating one.`,
      };
    }

    // No commits ahead of main - nothing to do
    return {
      decision: 'approve',
      systemMessage: 'No commits ahead of main. PR not needed.'
    };
  } catch (error) {
    await logger.logError(error as Error);

    // Don't block on errors - just log them
    return { decision: 'approve' };
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
