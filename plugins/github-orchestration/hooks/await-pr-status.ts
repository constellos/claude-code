/**
 * Await PR checks after PR creation
 *
 * PostToolUse[Bash] hook that detects `gh pr create` commands and automatically
 * waits for CI checks to complete on the newly created PR.
 *
 * **What it does:**
 * - Detects when a PR is created via `gh pr create`
 * - Extracts PR number from the output URL
 * - Waits for all CI checks to complete (10-minute timeout)
 * - Reports CI status and preview URLs
 * - Blocks if CI fails, approves if CI passes
 *
 * **Non-blocking:** This hook is informational only and does not block execution.
 *
 * @module await-pr-checks
 */

import type {
  PostToolUseInput,
  PostToolUseHookOutput,
} from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import {
  saveOutputToLog,
  formatCiChecksTable,
} from '../shared/hooks/utils/log-file.js';
import {
  awaitCIWithFailFast,
  getLatestCIRun,
  extractPreviewUrls,
  extractLinkedIssuesFromPR,
} from '../shared/hooks/utils/ci-status.js';
import { addPRToState } from '../shared/hooks/utils/github-state.js';

// Local CI functions removed - using shared utilities from ci-status.ts

/**
 * Extract PR number from gh pr create output
 *
 * @param output - Command output containing PR URL
 * @returns PR number or null
 */
function extractPRNumber(output: string): number | null {
  // Look for PR URL pattern: https://github.com/owner/repo/pull/123
  const match = output.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * PostToolUse hook handler for awaiting PR checks
 *
 * Detects `gh pr create` commands and waits for CI checks to complete.
 *
 * @param input - PostToolUse hook input from Claude Code
 * @returns Hook output with CI status as additional context
 */
async function handler(
  input: PostToolUseInput
): Promise<PostToolUseHookOutput> {
  // Only run for Bash tool
  if (input.tool_name !== 'Bash') {
    return {};
  }

  const logger = createDebugLogger(input.cwd, 'await-pr-checks', true);

  try {
    await logger.logInput({
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
    });

    // Get the bash command from tool input
    const toolInput = input.tool_input as { command?: string };
    const command = toolInput?.command || '';

    // Only run for gh pr create commands
    if (!command.includes('gh pr create') && !command.includes('gh pr')) {
      return {};
    }

    // Get the tool response to extract PR number
    const toolResponse = input.tool_response as { content?: Array<{ text?: string }> };
    const resultText = toolResponse?.content?.[0]?.text || '';

    // Extract PR number from output
    const prNumber = extractPRNumber(resultText);

    if (!prNumber) {
      await logger.logOutput({
        success: false,
        reason: 'Could not extract PR number from output',
      });
      return {};
    }

    await logger.logOutput({
      success: true,
      pr_number: prNumber,
      message: 'PR created, waiting for CI checks...',
    });

    // Wait for CI checks with fail-fast behavior
    const ciResult = await awaitCIWithFailFast({ prNumber }, input.cwd);

    // Get latest CI run details, preview URLs, and linked issues in parallel
    const [ciRun, previewUrls, linkedIssues] = await Promise.all([
      getLatestCIRun(prNumber, input.cwd),
      extractPreviewUrls(prNumber, input.cwd),
      extractLinkedIssuesFromPR(prNumber, input.cwd),
    ]);

    // Extract PR URL from original command output
    const prUrlMatch = resultText.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    const prUrl = prUrlMatch ? prUrlMatch[0] : `https://github.com/unknown/unknown/pull/${prNumber}`;

    // Track PR in github.json
    await addPRToState(
      input.session_id,
      {
        number: prNumber,
        url: prUrl,
        title: '', // Title not available from gh pr create output
        createdAt: new Date().toISOString(),
        linkedIssues,
      },
      input.cwd
    );

    // Save full CI output to log file if there are checks
    let logPath: string | undefined;
    if (ciResult.checks.length > 0) {
      const checksOutput = ciResult.checks.map(c => `${c.emoji} ${c.name}: ${c.status}`).join('\n');
      logPath = await saveOutputToLog(input.cwd, 'ci', `pr-${prNumber}`, checksOutput);
    }

    // Map ci-status CheckStatus to log-file format for table
    const mappedChecks = ciResult.checks.map(c => ({
      name: c.name,
      status: (c.status === 'success' ? 'pass' :
               c.status === 'failure' ? 'fail' :
               c.status === 'cancelled' ? 'skipped' : 'pending') as 'pass' | 'fail' | 'pending' | 'skipped',
      duration: '',
    }));
    const checksTable = formatCiChecksTable(mappedChecks, logPath);

    // Build concise status message
    let statusMessage = `**PR #${prNumber}**\n`;

    if (ciResult.success) {
      statusMessage += `✅ All CI checks passed\n`;
    } else if (ciResult.blockReason) {
      statusMessage += `${ciResult.blockReason}\n`;
    } else if (ciResult.error) {
      statusMessage += `⏱️ ${ciResult.error}\n`;
    } else {
      statusMessage += `❌ CI checks failed\n`;
    }

    // Add emoji status table
    if (checksTable) {
      statusMessage += `\n${checksTable}\n`;
    }

    // Add CI run link
    if (ciRun?.url) {
      statusMessage += `\n🔗 [CI Run](${ciRun.url})`;
    }

    // Add Vercel preview URLs (concise)
    if (previewUrls.allUrls.length > 0) {
      statusMessage += `\n🔗 Preview: ${previewUrls.allUrls[0]}`;
      if (previewUrls.allUrls.length > 1) {
        statusMessage += ` (+${previewUrls.allUrls.length - 1} more)`;
      }
    }

    await logger.logOutput({
      success: ciResult.success,
      ci_status: ciRun?.status,
      vercel_urls: previewUrls.allUrls,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: statusMessage,
      },
    };
  } catch (error: unknown) {
    await logger.logError(error as Error);
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with npx tsx
runHook(handler);
