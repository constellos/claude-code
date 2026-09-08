/**
 * Detect PR creation and suggest checking CI
 *
 * PostToolUse[Bash] hook that detects `gh pr create` commands and returns
 * a message suggesting the user check CI status.
 *
 * @module await-pr-checks
 */

import type {
  PostToolUseInput,
  PostToolUseHookOutput,
} from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { addPRToState } from '../shared/hooks/utils/github-state.js';

/**
 * Extract PR number from gh pr create output
 */
function extractPRNumber(output: string): number | null {
  const match = output.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function handler(
  input: PostToolUseInput
): Promise<PostToolUseHookOutput> {
  if (input.tool_name !== 'Bash') {
    return {};
  }

  const logger = createDebugLogger(input.cwd, 'await-pr-checks', true);

  try {
    await logger.logInput({
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
    });

    const toolInput = input.tool_input as { command?: string };
    const command = toolInput?.command || '';

    if (!command.includes('gh pr create') && !command.includes('gh pr')) {
      return {};
    }

    const toolResponse = input.tool_response as { content?: Array<{ text?: string }> };
    const resultText = toolResponse?.content?.[0]?.text || '';

    const prNumber = extractPRNumber(resultText);

    if (!prNumber) {
      await logger.logOutput({
        success: false,
        reason: 'Could not extract PR number from output',
      });
      return {};
    }

    const prUrlMatch = resultText.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    const prUrl = prUrlMatch ? prUrlMatch[0] : `PR #${prNumber}`;

    await addPRToState(
      input.session_id,
      {
        number: prNumber,
        url: prUrl,
        title: '',
        createdAt: new Date().toISOString(),
        linkedIssues: [],
      },
      input.cwd
    );

    await logger.logOutput({ success: true, pr_number: prNumber });

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `PR #${prNumber} created. Check CI status: \`gh pr checks ${prNumber}\``,
      },
    };
  } catch (error: unknown) {
    await logger.logError(error as Error);
    return {};
  }
}

export { handler };

runHook(handler);
