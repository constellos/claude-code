/**
 * Stop hook: PR status check and CI waiting
 *
 * This hook performs two main functions at session end:
 *
 * 1. **Blocking validation checks** - Ensures clean git state:
 *    - Merge conflicts detection
 *    - Branch sync status (behind remote)
 *    - Claude settings validation
 *    - Hook file existence checks
 *
 * 2. **PR status reporting and CI waiting** - Provides PR visibility and ensures quality:
 *    - Checks for uncommitted changes (non-blocking message)
 *    - Checks if PR exists for current branch
 *    - **Waits for all CI checks to complete** (including Vercel, Supabase integrations)
 *    - **Blocks if any CI check fails** (10-minute timeout)
 *    - Extracts Vercel preview URLs (web and marketing apps)
 *
 * @module commit-session-await-status
 */

import type { StopInput, StopHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
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

// ============================================================================
// Command Execution
// ============================================================================

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

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await execCommand('git status --porcelain', cwd);
  if (!result.success || !result.stdout) {
    return false;
  }

  const lines = result.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const pathStart = (line.length >= 3 && line[2] === ' ') ? 3 : 2;
    const filePath = line.slice(pathStart).split(' -> ')[0];
    const ignoreCheck = await execCommand(`git check-ignore -q "${filePath}"`, cwd);
    if (!ignoreCheck.success) {
      return true;
    }
  }

  return false;
}

async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  return result.success ? result.stdout : null;
}

async function getRepoRoot(cwd: string): Promise<string> {
  const result = await execCommand('git rev-parse --show-toplevel', cwd);
  return result.success ? result.stdout : cwd;
}

async function checkMergeConflicts(cwd: string): Promise<{
  hasConflicts: boolean;
  conflictedFiles: string[];
}> {
  const unmergedResult = await execCommand('git ls-files --unmerged', cwd);
  const hasUnmerged = unmergedResult.stdout.length > 0;

  const conflictFilesResult = await execCommand('git diff --name-only --diff-filter=U', cwd);
  const conflictedFiles = conflictFilesResult.stdout
    ? conflictFilesResult.stdout.split('\n').filter(Boolean)
    : [];

  return {
    hasConflicts: hasUnmerged || conflictedFiles.length > 0,
    conflictedFiles,
  };
}

async function checkBranchSync(cwd: string): Promise<{
  isSynced: boolean;
  behindBy: number;
  aheadBy: number;
  remoteBranch: string;
}> {
  const branchResult = await execCommand('git branch --show-current', cwd);
  const currentBranch = branchResult.stdout;

  if (!currentBranch) {
    return { isSynced: true, behindBy: 0, aheadBy: 0, remoteBranch: '' };
  }

  await execCommand('git fetch', cwd);

  const trackingResult = await execCommand(
    `git rev-parse --abbrev-ref ${currentBranch}@{upstream}`,
    cwd
  );

  if (!trackingResult.success) {
    return { isSynced: true, behindBy: 0, aheadBy: 0, remoteBranch: '' };
  }

  const remoteBranch = trackingResult.stdout;
  const revListResult = await execCommand(
    `git rev-list --left-right --count ${currentBranch}...${remoteBranch}`,
    cwd
  );

  if (!revListResult.success) {
    return { isSynced: true, behindBy: 0, aheadBy: 0, remoteBranch };
  }

  const [aheadStr, behindStr] = revListResult.stdout.split('\t');
  const aheadBy = parseInt(aheadStr || '0', 10);
  const behindBy = parseInt(behindStr || '0', 10);

  return { isSynced: behindBy === 0, behindBy, aheadBy, remoteBranch };
}

// ============================================================================
// GitHub CLI Operations
// ============================================================================

async function checkPRExists(
  branch: string,
  cwd: string
): Promise<{
  exists: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}> {
  const ghCheck = await execCommand('gh --version', cwd);
  if (!ghCheck.success) {
    return { exists: false, error: 'GitHub CLI not installed' };
  }

  const authCheck = await execCommand('gh auth status', cwd);
  if (!authCheck.success) {
    return { exists: false, error: 'GitHub CLI not authenticated' };
  }

  const prListResult = await execCommand(
    `gh pr list --head ${branch} --json number,url --limit 1`,
    cwd
  );

  if (!prListResult.success) {
    return { exists: false, error: `gh pr list failed: ${prListResult.stderr}` };
  }

  try {
    const prs = JSON.parse(prListResult.stdout);
    if (Array.isArray(prs) && prs.length > 0) {
      return { exists: true, prNumber: prs[0].number, prUrl: prs[0].url };
    }
    return { exists: false };
  } catch (parseError) {
    return { exists: false, error: `Failed to parse gh output: ${parseError}` };
  }
}

// ============================================================================
// Validation Checks
// ============================================================================

async function checkClaudeDoctor(cwd: string): Promise<{
  healthy: boolean;
  issues: string[];
  error?: string;
}> {
  const claudeCheck = await execCommand('claude --version', cwd);
  if (!claudeCheck.success) {
    return { healthy: true, issues: [], error: 'Claude CLI not available' };
  }

  const doctorResult = await execCommand('claude doctor --json 2>&1', cwd);

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
    return { healthy: true, issues: [], error: 'Claude doctor failed due to terminal limitations (non-blocking)' };
  }

  try {
    if (doctorResult.stdout) {
      const doctorOutput = JSON.parse(doctorResult.stdout);
      const issues: string[] = [];
      if (doctorOutput.errors && Array.isArray(doctorOutput.errors)) {
        issues.push(...doctorOutput.errors);
      }
      if (doctorOutput.warnings && Array.isArray(doctorOutput.warnings)) {
        issues.push(...doctorOutput.warnings);
      }
      return { healthy: issues.length === 0, issues };
    }
    if (!doctorResult.success && !isNonSettingsError) {
      return { healthy: false, issues: [doctorResult.stderr || 'Unknown error'] };
    }
    return { healthy: true, issues: [] };
  } catch {
    if (!doctorResult.success && !isNonSettingsError) {
      return { healthy: false, issues: [doctorResult.stderr || doctorResult.stdout || 'Claude doctor failed'] };
    }
    return { healthy: true, issues: [] };
  }
}

async function validateHookFiles(cwd: string): Promise<{
  valid: boolean;
  missingFiles: string[];
  error?: string;
}> {
  const missingFiles: string[] = [];

  try {
    const settingsPath = join(cwd, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) {
      return { valid: true, missingFiles: [] };
    }

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const enabledPlugins = settings.enabledPlugins || {};

    for (const [pluginName, enabled] of Object.entries(enabledPlugins)) {
      if (!enabled) continue;

      const pluginCachePath = join(
        process.env.HOME || '/home',
        '.claude', 'plugins', 'cache',
        pluginName.replace('@', '/'),
        'hooks', 'hooks.json'
      );

      if (existsSync(pluginCachePath)) {
        const hooksConfig = JSON.parse(readFileSync(pluginCachePath, 'utf-8'));
        if (hooksConfig.hooks) {
          for (const eventHooks of Object.values(hooksConfig.hooks)) {
            if (!Array.isArray(eventHooks)) continue;
            for (const hookGroup of eventHooks) {
              if (!hookGroup.hooks) continue;
              for (const hook of hookGroup.hooks) {
                if (hook.type === 'command' && hook.command) {
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

    return { valid: missingFiles.length === 0, missingFiles };
  } catch (error) {
    return { valid: true, missingFiles: [], error: `Hook validation error: ${error}` };
  }
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatLinkedIssue(issue: LinkedIssueInfo, prRepo: string): string {
  const prefix = issue.repo === prRepo ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
  const titlePart = issue.title ? ` - ${issue.title}` : '';
  return `${prefix}${titlePart} → ${issue.url}`;
}

function formatSessionIssue(issue: IssueReference, currentRepo: string): string {
  const prefix = issue.repo === currentRepo ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
  const titlePart = issue.title ? ` - ${issue.title}` : '';
  return `${prefix}${titlePart} → ${issue.url}`;
}

function formatPRStatusInfo(
  prCheck: { prNumber: number; prUrl: string },
  ciRun: { url?: string; status?: string; conclusion?: string; name?: string },
  groupedPreviews: GroupedPreviewUrls,
  linkedIssues: LinkedIssueInfo[],
  otherIssues: IssueReference[],
  prRepo: string
): string {
  const ciPassed = ciRun.conclusion === 'success';
  const ciFailed = ciRun.conclusion === 'failure';

  let message = `📋 PR #${prCheck.prNumber}: ${prCheck.prUrl}\n`;

  if (ciRun.url) {
    const statusIcon = ciPassed ? '✅' : ciFailed ? '❌' : '⏳';
    message += `🔄 CI: ${ciRun.url} ${statusIcon} ${ciRun.conclusion || ciRun.status || 'pending'}\n`;
  }

  if (linkedIssues.length > 0) {
    message += '\n   📌 Linked Issues (closes when merged):\n';
    for (const issue of linkedIssues) {
      message += `      • ${formatLinkedIssue(issue, prRepo)}\n`;
    }
  }

  if (otherIssues.length > 0) {
    message += '\n📝 Other Issues Created:\n';
    for (const issue of otherIssues) {
      message += `   • ${formatSessionIssue(issue, prRepo)}\n`;
    }
  }

  if (groupedPreviews.vercel.length > 0) {
    message += '\n🔼 Vercel Previews:\n';
    for (const url of groupedPreviews.vercel) {
      message += `   • ${url}\n`;
    }
  }

  if (groupedPreviews.cloudflare.length > 0) {
    message += '\n☁️ Cloudflare Deployments:\n';
    for (const url of groupedPreviews.cloudflare) {
      message += `   • ${url}\n`;
    }
  }

  if (groupedPreviews.supabase.length > 0) {
    message += '\n⚡ Supabase Preview Branches:\n';
    for (const preview of groupedPreviews.supabase) {
      message += `   • ${preview.dashboardUrl}\n`;
    }
  }

  return message;
}

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

// ============================================================================
// Main Handler
// ============================================================================

async function handler(input: StopInput): Promise<StopHookOutput> {
  const logger = createDebugLogger(input.cwd, 'commit-session-check-pr-status', true);

  // Skip blocking behavior in plan mode
  if (input.permission_mode === 'plan') {
    return { decision: 'approve' };
  }

  try {
    await logger.logInput({ session_id: input.session_id });

    const repoRoot = await getRepoRoot(input.cwd);

    // === PHASE 1: BLOCKING CHECKS ===

    const gitCheck = await execCommand('git rev-parse --is-inside-work-tree', repoRoot);
    if (!gitCheck.success) {
      await logger.logOutput({ skipped: true, reason: 'Not a git repository' });
      return { decision: 'approve' };
    }

    const doctorCheck = await checkClaudeDoctor(repoRoot);
    if (!doctorCheck.healthy && doctorCheck.issues.length > 0) {
      return {
        decision: 'block',
        reason: formatDoctorErrors(doctorCheck.issues),
        systemMessage: 'Claude is blocked from stopping due to configuration issues.',
      };
    }

    const hookValidation = await validateHookFiles(repoRoot);
    if (!hookValidation.valid && hookValidation.missingFiles.length > 0) {
      return {
        decision: 'block',
        reason: formatHookErrors(hookValidation.missingFiles),
        systemMessage: 'Claude is blocked from stopping due to missing hook files.',
      };
    }

    const conflictCheck = await checkMergeConflicts(repoRoot);
    if (conflictCheck.hasConflicts) {
      return {
        decision: 'block',
        reason: formatConflictError(conflictCheck.conflictedFiles),
        systemMessage: 'Claude is blocked from stopping due to merge conflicts.',
      };
    }

    const syncCheck = await checkBranchSync(repoRoot);
    if (!syncCheck.isSynced && syncCheck.remoteBranch) {
      return {
        decision: 'block',
        reason: formatSyncError(syncCheck),
        systemMessage: 'Claude is blocked from stopping due to branch sync issues.',
      };
    }

    // === PHASE 2: STATUS REPORTING ===

    const currentBranch = await getCurrentBranch(repoRoot);
    const messages: string[] = [];

    // Check for uncommitted changes (non-blocking)
    const hasChanges = await hasUncommittedChanges(repoRoot);
    if (hasChanges) {
      messages.push('⚠️ You have uncommitted changes. Consider committing before ending the session.');
    }

    // Skip PR checks for main branches
    const mainBranches = ['main', 'master', 'develop'];
    if (!currentBranch || mainBranches.includes(currentBranch)) {
      if (messages.length > 0) {
        return { decision: 'approve', systemMessage: messages.join('\n') };
      }
      return { decision: 'approve' };
    }

    // Check if PR exists
    const prCheck = await checkPRExists(currentBranch, repoRoot);

    if (prCheck.exists && prCheck.prNumber && prCheck.prUrl) {
      // PR exists - wait for CI checks with fail-fast behavior
      await logger.logOutput({
        pr_exists: true,
        pr_number: prCheck.prNumber,
        waiting_for_ci: true,
      });

      const ciResult = await awaitCIWithFailFast({ prNumber: prCheck.prNumber }, repoRoot);

      // If CI failed, block
      if (!ciResult.success) {
        const checksOutput = ciResult.checks.map(c => `${c.emoji} ${c.name}: ${c.status}`).join('\n');
        const logPath = await saveOutputToLog(repoRoot, 'ci', `pr-${prCheck.prNumber}`, checksOutput);

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
          failed_check: ciResult.failedCheck,
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

      // CI passed - fetch details and show status
      await logger.logOutput({ ci_status: 'passed', checks: ciResult.checks });

      const [ciRun, groupedPreviews, linkedIssues, sessionIssues] = await Promise.all([
        getCIRunDetails(prCheck.prNumber, repoRoot).then(r => r ?? {}),
        extractAllPreviews(prCheck.prNumber, repoRoot),
        extractLinkedIssuesWithInfo(prCheck.prNumber, repoRoot),
        getSessionIssues(input.session_id, repoRoot),
      ]);

      const prRepoMatch = prCheck.prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
      const prRepo = prRepoMatch ? prRepoMatch[1] : '';

      const linkedIssueKeys = new Set(linkedIssues.map(i => `${i.repo}#${i.number}`));
      const otherIssues = sessionIssues.filter(
        issue => !linkedIssueKeys.has(`${issue.repo}#${issue.number}`)
      );

      // Track PR in github.json
      await addPRToState(
        input.session_id,
        {
          number: prCheck.prNumber,
          url: prCheck.prUrl,
          title: '',
          createdAt: new Date().toISOString(),
          linkedIssues: linkedIssues.map(i => i.number),
        },
        repoRoot
      );

      // If CI run shows failure/cancelled, block
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

      const prStatusMessage = formatPRStatusInfo(
        { prNumber: prCheck.prNumber, prUrl: prCheck.prUrl },
        ciRun, groupedPreviews, linkedIssues, otherIssues, prRepo
      );

      if (messages.length > 0) {
        messages.push('');
        messages.push(prStatusMessage);
      } else {
        messages.push(prStatusMessage);
      }

      return {
        decision: 'approve',
        systemMessage: messages.join('\n'),
      };
    }

    // No PR - just approve (with any status messages)
    if (messages.length > 0) {
      return { decision: 'approve', systemMessage: messages.join('\n') };
    }

    return { decision: 'approve' };
  } catch (error) {
    await logger.logError(error as Error);
    return { decision: 'approve' };
  }
}

export { handler };

runHook(handler);
