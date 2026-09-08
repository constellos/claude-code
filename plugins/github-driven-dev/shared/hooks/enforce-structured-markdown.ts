#!/usr/bin/env npx tsx
/**
 * Structured markdown validation hook
 *
 * PreToolUse hook that validates structure and metadata for markdown files before
 * Write and Edit operations. Enforces consistent documentation structure across
 * different file types in the Claude Code project.
 *
 * This hook validates six types of markdown files:
 *
 * 1. Agent files in .claude/agents/ directory
 *    Required headings: Objective, Principles, Agent-scoped project context
 *
 * 2. Skill files in .claude/skills/ subdirectories (excludes SKILL.md templates)
 *    Required headings: Purpose, Skill-scoped context
 *
 * 3. Rules files in .claude/rules/ directory
 *    Required headings: Rules
 *
 * 4. Plugin README files in plugins README.md
 *    Required headings: Badge section, TOC, Overview, Features, Installation,
 *    Hooks, Configuration, Use Cases, Troubleshooting, Contributing, See Also, License
 *
 * 5. Plugin CLAUDE.md files in plugins CLAUDE.md
 *    Required headings: Quick Reference, Hook Summary, Key Features,
 *    Installation, Debug Logging, See Also
 *
 * 6. CLAUDE.md files in any other directory
 *    Required metadata: name, description
 *
 * The hook blocks Write/Edit operations if validation fails, providing detailed
 * error messages about missing headings and metadata fields.
 *
 * @module enforce-structured-markdown
 */

import type { PreToolUseInput, PreToolUseHookOutput } from '../types/types.js';
import { createDebugLogger } from './utils/debug.js';
import { runHook } from './utils/io.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from './utils/frontmatter.js';

const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('enforce-structured-markdown');

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Extract markdown headings from content
 *
 * Parses markdown content and extracts all headings (lines starting with #).
 * Preserves the full heading text including the hash symbols for pattern matching.
 *
 * @param content - The markdown content to parse
 * @returns Array of heading strings (e.g., ["# Title", "## Section"])
 *
 * @example
 * ```typescript
 * const content = `
 * # My Document
 * ## Overview
 * Some content
 * ## Implementation
 * `;
 * const headings = extractHeadings(content);
 * // Returns: ["# My Document", "## Overview", "## Implementation"]
 * ```
 */
function extractHeadings(content: string): string[] {
  const lines = content.split('\n');
  const headings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/^#{1,6}\s+/)) {
      headings.push(trimmed);
    }
  }

  return headings;
}

/**
 * Check if a heading matches a pattern with wildcard support
 *
 * Compares a markdown heading against a pattern, supporting wildcard (*) matching.
 * Normalizes whitespace and performs case-insensitive comparison.
 *
 * @param heading - The heading to test (e.g., "## Required Skills: None")
 * @param pattern - The pattern to match against (e.g., "## Required Skills:*")
 * @returns True if the heading matches the pattern, false otherwise
 *
 * @example
 * ```typescript
 * // Exact match
 * matchesHeadingPattern("## Overview", "## Overview"); // true
 *
 * // Wildcard match
 * matchesHeadingPattern("## Required Skills: None", "## Required Skills:*"); // true
 * matchesHeadingPattern("## Required Skills: foo, bar", "## Required Skills:*"); // true
 *
 * // No match
 * matchesHeadingPattern("## Implementation", "## Overview"); // false
 * ```
 */
function matchesHeadingPattern(heading: string, pattern: string): boolean {
  // Normalize whitespace
  const normalizedHeading = heading.replace(/\s+/g, ' ').trim();
  const normalizedPattern = pattern.replace(/\s+/g, ' ').trim();

  // Exact match
  if (normalizedHeading === normalizedPattern) {
    return true;
  }

  // Wildcard pattern
  const regexPattern = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(normalizedHeading);
}

/**
 * Validate that all required headings are present in content
 *
 * Checks that each required heading pattern has at least one match in the
 * provided headings array. Supports wildcard patterns for flexible matching.
 *
 * @param headings - Array of headings extracted from markdown content
 * @param required - Array of required heading patterns (supports wildcards)
 * @returns Validation result with valid flag and error messages
 *
 * @example
 * ```typescript
 * const headings = ["# Title", "## Overview", "## Implementation"];
 * const required = ["## Overview", "## Implementation", "## Testing"];
 *
 * const result = validateRequiredHeadings(headings, required);
 * // Returns: {
 * //   valid: false,
 * //   errors: ['Required heading missing: "## Testing"']
 * // }
 * ```
 */
function validateRequiredHeadings(headings: string[], required: string[]): ValidationResult {
  const errors: string[] = [];

  for (const requiredPattern of required) {
    const found = headings.some(h => matchesHeadingPattern(h, requiredPattern));
    if (!found) {
      errors.push(`Required heading missing: "${requiredPattern}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate that all required metadata fields are present in frontmatter
 *
 * Checks that each required metadata field exists in the YAML frontmatter object.
 * Fields with falsy values are considered missing.
 *
 * @param metadata - Parsed YAML frontmatter object
 * @param required - Array of required field names
 * @returns Validation result with valid flag and error messages
 *
 * @example
 * ```typescript
 * const metadata = { name: "My Skill", version: "1.0" };
 * const required = ["name", "description", "version"];
 *
 * const result = validateRequiredMetadata(metadata, required);
 * // Returns: {
 * //   valid: false,
 * //   errors: ['Required metadata field missing: "description"']
 * // }
 * ```
 */
function validateRequiredMetadata(metadata: Record<string, unknown>, required: string[]): ValidationResult {
  const errors: string[] = [];

  for (const field of required) {
    if (!metadata[field]) {
      errors.push(`Required metadata field missing: "${field}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Determine file type and return appropriate validation rules
 *
 * Analyzes the file path to determine its type (agent, skill, rule, or CLAUDE.md)
 * and returns the corresponding validation requirements. Returns null for
 * non-markdown files or files that don't match any validation pattern.
 *
 * @param filePath - The path to the file being validated (absolute or relative)
 * @param cwd - The current working directory for resolving relative paths
 * @returns Validation rules object with type and requirements, or null if no validation needed
 *
 * @example
 * ```typescript
 * // Agent file
 * const rules1 = getFileValidationRules('.claude/agents/explorer.md', '/project');
 * // Returns: {
 * //   type: 'agent',
 * //   requiredHeadings: ['## Objective', '## Principles', '## Agent-scoped project context'],
 * //   shouldValidate: true
 * // }
 *
 * // Skill file
 * const rules2 = getFileValidationRules('.claude/skills/my-skill/docs.md', '/project');
 * // Returns: {
 * //   type: 'skill',
 * //   requiredHeadings: ['## Purpose', '## Skill-scoped context'],
 * //   requiredMetadata: ['name', 'description'],
 * //   shouldValidate: true
 * // }
 *
 * // SKILL.md template (skipped)
 * const rules3 = getFileValidationRules('.claude/skills/my-skill/SKILL.md', '/project');
 * // Returns: { type: 'skill-template', shouldValidate: false }
 *
 * // Non-markdown file
 * const rules4 = getFileValidationRules('src/index.ts', '/project');
 * // Returns: null
 * ```
 */
function getFileValidationRules(filePath: string, cwd: string): {
  type: string;
  requiredHeadings?: string[];
  requiredMetadata?: string[];
  shouldValidate: boolean;
} | null {
  const relativePath = path.isAbsolute(filePath)
    ? path.relative(cwd, filePath)
    : filePath;

  if (DEBUG) {
    console.log('[enforce-structured-markdown] Checking file type:', relativePath);
  }

  // Agent files: .claude/agents/*.md
  if (relativePath.includes(path.join('.claude', 'agents')) && relativePath.endsWith('.md')) {
    return {
      type: 'agent',
      requiredHeadings: ['## Objective', '## Principles', '## Agent-scoped project context'],
      shouldValidate: true,
    };
  }

  // Skill files: .claude/skills/*/*.md (excluding SKILL.md and SKILL.template.md)
  if (relativePath.includes(path.join('.claude', 'skills')) && relativePath.endsWith('.md')) {
    const basename = path.basename(relativePath);
    if (basename === 'SKILL.md' || basename === 'SKILL.template.md') {
      if (DEBUG) {
        console.log('[enforce-structured-markdown] Skipping SKILL.md or SKILL.template.md');
      }
      return { type: 'skill-template', shouldValidate: false };
    }
    return {
      type: 'skill',
      requiredHeadings: ['## Purpose', '## Skill-scoped context'],
      requiredMetadata: ['name', 'description'],
      shouldValidate: true,
    };
  }

  // Rules files: .claude/rules/*.md
  if (relativePath.includes(path.join('.claude', 'rules')) && relativePath.endsWith('.md')) {
    return {
      type: 'rule',
      requiredHeadings: ['## Rules'],
      requiredMetadata: ['Required Skills'],
      shouldValidate: true,
    };
  }

  // Plugin README files: plugins/*/README.md
  if (relativePath.match(/^plugins\/[^/]+\/README\.md$/)) {
    return {
      type: 'plugin-readme',
      requiredHeadings: [
        '# 🔌 *',
        '## 📋 Table of Contents',
        '## 🎯 Overview',
        '## ✨ Features',
        '## 📦 Installation',
        '## 🪝 Hooks',
        '## ⚙️ Configuration',
        '## 💡 Use Cases',
        '## 🐛 Troubleshooting',
        '## 🤝 Contributing',
        '## 📚 See Also',
        '## 📄 License',
      ],
      shouldValidate: true,
    };
  }

  // Plugin CLAUDE.md files: plugins/*/CLAUDE.md (must come before general CLAUDE.md check)
  if (relativePath.match(/^plugins\/[^/]+\/CLAUDE\.md$/)) {
    return {
      type: 'plugin-claude',
      requiredHeadings: [
        '# *',
        '## Quick Reference',
        '## Hook Summary',
        '## Key Features',
        '## Installation',
        '## Debug Logging',
        '## See Also',
      ],
      requiredMetadata: ['title', 'description', 'version', 'folder'],
      shouldValidate: true,
    };
  }

  // CLAUDE.md files (any directory)
  if (path.basename(relativePath) === 'CLAUDE.md') {
    return {
      type: 'claude-md',
      requiredMetadata: ['name', 'description'],
      shouldValidate: true,
    };
  }

  return null;
}

/**
 * Extract the final content that will be written to the file
 *
 * Handles both Write and Edit operations to determine the content that will
 * result from the tool use. For Write, returns the content directly. For Edit,
 * reads the current file and applies the edit operation to get the final content.
 *
 * @param toolName - The tool being used ("Write" or "Edit")
 * @param toolInput - The tool input parameters
 * @param cwd - The current working directory for resolving relative paths
 * @returns The final content after the operation, or null if content cannot be determined
 *
 * @example
 * ```typescript
 * // Write operation
 * const content1 = await getContentFromToolInput(
 *   'Write',
 *   { file_path: 'doc.md', content: '# Title\n## Section' },
 *   '/project'
 * );
 * // Returns: '# Title\n## Section'
 *
 * // Edit operation (replaces text)
 * // Assumes file currently contains: '# Old\n## Section'
 * const content2 = await getContentFromToolInput(
 *   'Edit',
 *   {
 *     file_path: 'doc.md',
 *     old_string: '# Old',
 *     new_string: '# New'
 *   },
 *   '/project'
 * );
 * // Returns: '# New\n## Section'
 * ```
 */
async function getContentFromToolInput(
  toolName: string,
  toolInput: {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
  },
  cwd: string
): Promise<string | null> {
  if (toolName === 'Write') {
    return toolInput.content || null;
  } else if (toolName === 'Edit') {
    const filePath = toolInput.file_path;
    if (!filePath || !toolInput.old_string || !toolInput.new_string) {
      return null;
    }

    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const currentContent = await fs.readFile(fullPath, 'utf-8');
      // Apply the edit
      return currentContent.replace(toolInput.old_string, toolInput.new_string);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * PreToolUse hook that validates markdown structure before Write/Edit operations
 *
 * Intercepts Write and Edit tool uses on markdown files to validate that they
 * meet the structural requirements for their file type. Blocks operations that
 * would create invalid agent, skill, rule, or CLAUDE.md files.
 *
 * This hook:
 * 1. Only processes Write and Edit operations on .md files
 * 2. Determines the file type from its path
 * 3. Extracts headings and metadata from the content
 * 4. Validates against type-specific requirements
 * 5. Blocks invalid operations with detailed error messages
 *
 * @param input - PreToolUse hook input with tool information
 * @returns Hook output with permissionDecision (allow/deny)
 *
 * @example
 * ```typescript
 * // Valid agent file - allowed
 * const result1 = await handler({
 *   tool_name: 'Write',
 *   tool_use_id: 'toolu_123',
 *   tool_input: {
 *     file_path: '.claude/agents/my-agent.md',
 *     content: `
 * # My Agent
 * ## Objective
 * Do the task
 * ## Principles
 * Be thorough
 * ## Agent-scoped project context
 * Uses TypeScript
 *     `
 *   },
 *   cwd: '/project',
 *   // ... other fields
 * });
 * // Returns: { hookSpecificOutput: { permissionDecision: 'allow' } }
 *
 * // Invalid skill file (missing required heading) - denied
 * const result2 = await handler({
 *   tool_name: 'Write',
 *   tool_use_id: 'toolu_456',
 *   tool_input: {
 *     file_path: '.claude/skills/my-skill/docs.md',
 *     content: `
 * ---
 * name: My Skill
 * description: Does things
 * ---
 * # My Skill
 * ## Purpose
 * This is the purpose
 * (missing ## Skill-scoped context heading)
 *     `
 *   },
 *   cwd: '/project',
 *   // ... other fields
 * });
 * // Returns: {
 * //   hookSpecificOutput: {
 * //     permissionDecision: 'deny',
 * //     permissionDecisionReason: 'Skill validation failed...\n\nRequired heading missing: "## Skill-scoped context"'
 * //   }
 * // }
 *
 * // Non-markdown file - allowed (no validation)
 * const result3 = await handler({
 *   tool_name: 'Write',
 *   tool_use_id: 'toolu_789',
 *   tool_input: {
 *     file_path: 'src/index.ts',
 *     content: 'export const foo = "bar";'
 *   },
 *   cwd: '/project',
 *   // ... other fields
 * });
 * // Returns: { hookSpecificOutput: { permissionDecision: 'allow' } }
 * ```
 */
async function handler(input: PreToolUseInput): Promise<PreToolUseHookOutput> {
  // Only run for Write and Edit operations
  if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  const logger = createDebugLogger(input.cwd, 'enforce-structured-markdown', DEBUG || false);

  try {
    await logger.logInput({
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
    });

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

    // Only process .md files
    if (!filePath.endsWith('.md')) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Get validation rules for this file type
    const validationRules = getFileValidationRules(filePath, input.cwd);
    if (!validationRules || !validationRules.shouldValidate) {
      await logger.logOutput({ message: 'No validation rules for this file type or validation skipped' });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Get the content (handles both Write and Edit)
    const content = await getContentFromToolInput(input.tool_name, toolInput, input.cwd);
    if (!content) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Parse frontmatter and content
    const { data: metadata } = matter(content);
    const headings = extractHeadings(content);

    const allErrors: string[] = [];

    // Validate required metadata
    if (validationRules.requiredMetadata && validationRules.requiredMetadata.length > 0) {
      const metadataValidation = validateRequiredMetadata(
        metadata as Record<string, unknown>,
        validationRules.requiredMetadata
      );
      if (!metadataValidation.valid) {
        allErrors.push(...metadataValidation.errors);
      }
    }

    // Validate required headings
    if (validationRules.requiredHeadings && validationRules.requiredHeadings.length > 0) {
      const headingValidation = validateRequiredHeadings(headings, validationRules.requiredHeadings);
      if (!headingValidation.valid) {
        allErrors.push(...headingValidation.errors);
      }
    }

    await logger.logOutput({
      fileType: validationRules.type,
      headings,
      metadata: Object.keys(metadata),
      valid: allErrors.length === 0,
      errors: allErrors,
    });

    if (allErrors.length > 0) {
      const errorMessage = allErrors.join('\n');
      const fileTypeDisplay = validationRules.type.replace('-', ' ');

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${fileTypeDisplay.charAt(0).toUpperCase() + fileTypeDisplay.slice(1)} validation failed for ${path.basename(filePath)}:\n\n${errorMessage}\n\nPlease ensure all required headings and metadata fields are present.`,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };

  } catch (error: unknown) {
    await logger.logError(error as Error);

    // On error, allow the operation but log a system message
    return {
      systemMessage: `Structured markdown validation hook failed: ${(error as Error).message || 'Unknown error'}`,
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
