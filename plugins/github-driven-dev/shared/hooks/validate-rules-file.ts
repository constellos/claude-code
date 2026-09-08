/**
 * PreToolUse Hook - Validate Rules File
 *
 * This hook fires before Write and Edit operations on rule files in .claude/rules
 * to validate that markdown-specific frontmatter is only used in .md-specific rules.
 *
 * Provides guidance:
 * - Warns if markdown frontmatter is used in non-.md rules
 * - Encourages markdown frontmatter in .md rules if not present
 * - Does NOT block operations - only provides context
 *
 * @module hooks/validate-rules-file
 */

import type { PreToolUseInput, PreToolUseHookOutput } from '../types/types.js';
import { createDebugLogger } from './utils/debug.js';
import { runHook } from './utils/io.js';
import * as path from 'path';
import matter from './utils/frontmatter.js';

interface MarkdownValidation {
  headings?: unknown;
  metadata?: unknown;
}

interface RuleFrontmatter {
  markdown?: MarkdownValidation;
  [key: string]: unknown;
}

/**
 * Check if a rule filename indicates it applies to markdown files
 */
function isMarkdownRule(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();

  // Remove .md extension from rule filename for checking
  const ruleName = lowerFilename.replace(/\.md$/, '');

  // Check if rule name suggests markdown files
  return (
    ruleName.includes('markdown') ||
    ruleName.includes('.md') ||
    ruleName === 'md' ||
    ruleName.endsWith('-md')
  );
}

/**
 * PreToolUse hook handler for validating rules files
 *
 * Validates that markdown frontmatter is appropriately used in rule files.
 * Provides guidance but does not block operations.
 *
 * @param input - PreToolUse hook input from Claude Code
 * @returns Hook output with guidance messages
 */
async function handler(
  input: PreToolUseInput
): Promise<PreToolUseHookOutput> {
  // Only run for Write and Edit operations
  if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  const logger = createDebugLogger(input.cwd, 'validate-rules-file', true);

  try {
    await logger.logInput({
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
    });

    // Get the file path and content from tool input
    const toolInput = input.tool_input as {
      file_path?: string;
      content?: string;
      old_string?: string;
      new_string?: string;
    };
    const filePath = toolInput.file_path;

    if (!filePath) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Check if this is a file in .claude/rules
    const normalizedPath = path.normalize(filePath);
    const isRuleFile = normalizedPath.includes(path.join('.claude', 'rules')) &&
                       filePath.endsWith('.md');

    if (!isRuleFile) {
      await logger.logOutput({ message: 'Not a rule file, skipping' });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Get content based on operation type
    let content: string | undefined;

    if (input.tool_name === 'Write') {
      content = toolInput.content;
    } else if (input.tool_name === 'Edit') {
      // For Edit, we need the new content after the edit
      // Since we can't easily reconstruct it, we'll just check the new_string portion
      content = toolInput.new_string;
    }

    if (!content) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Parse frontmatter
    let frontmatter: RuleFrontmatter;
    try {
      const { data } = matter(content);
      frontmatter = data as RuleFrontmatter;
    } catch {
      // If we can't parse frontmatter, allow the operation
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    const filename = path.basename(filePath);
    const hasMarkdownFrontmatter = Boolean(frontmatter.markdown);
    const isMdRule = isMarkdownRule(filename);

    await logger.logOutput({
      filename,
      hasMarkdownFrontmatter,
      isMdRule,
    });

    // Case 1: Has markdown frontmatter but doesn't apply to .md files
    if (hasMarkdownFrontmatter && !isMdRule) {
      const warningMessage =
        `⚠️  Rule file "${filename}" contains markdown-specific frontmatter but doesn't appear to target .md files.\n\n` +
        `The \`markdown:\` frontmatter is designed for validating markdown file structure (headings and metadata).\n` +
        `This rule's filename suggests it targets non-markdown files.\n\n` +
        `Consider:\n` +
        `- Removing the \`markdown:\` frontmatter if this rule doesn't apply to .md files\n` +
        `- Renaming the rule to include ".md" if it does target markdown files (e.g., "*.md.md")`;

      await logger.logOutput({ warning: warningMessage });

      return {
        systemMessage: warningMessage,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Case 2: Applies to .md files but doesn't have markdown frontmatter
    if (isMdRule && !hasMarkdownFrontmatter) {
      const encouragementMessage =
        `💡 Rule file "${filename}" appears to target markdown files but doesn't have \`markdown:\` frontmatter.\n\n` +
        `You can add markdown validation by including a \`markdown:\` section in the frontmatter:\n\n` +
        `\`\`\`yaml\n` +
        `---\n` +
        `markdown:\n` +
        `  headings:\n` +
        `    allowed: ["#*", "##*", "###*"]  # Allow h1, h2, h3\n` +
        `    required: ["# *"]               # Require title heading\n` +
        `  frontmatter:\n` +
        `    allowed: ["*"]                  # Allow any frontmatter fields\n` +
        `    required: ["title"]             # Require title field\n` +
        `---\n` +
        `\`\`\`\n\n` +
        `This enables automatic validation of markdown structure and frontmatter fields.`;

      await logger.logOutput({ encouragement: encouragementMessage });

      return {
        systemMessage: encouragementMessage,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // All good - either has appropriate frontmatter or doesn't need guidance
    await logger.logOutput({ status: 'valid' });

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };

  } catch (error: unknown) {
    await logger.logError(error as Error);

    // On error, allow the operation
    return {
      systemMessage: `Rules file validation hook failed: ${(error as Error).message || 'Unknown error'}`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
