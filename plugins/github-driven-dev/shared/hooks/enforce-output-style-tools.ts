#!/usr/bin/env npx tsx

/**
 * Output style tool enforcement hook
 *
 * PreToolUse hook that enforces tool restrictions defined in output style frontmatter.
 * When an output style specifies a `tools` array in its frontmatter, only those tools
 * are allowed for the main agent. Subagents can use any tools they need.
 *
 * This enables output styles to restrict Claude's capabilities to specific tools,
 * for example:
 * - Read-only mode: only Read, Glob, Grep tools
 * - Research mode: Read, Glob, Grep, WebSearch, WebFetch
 * - Full mode: all tools allowed (no restrictions)
 *
 * Output style files are located in .claude/output-styles/ with frontmatter like:
 * ```yaml
 * ---
 * name: read-only
 * description: Read-only access to codebase
 * tools: [Read, Glob, Grep]
 * ---
 * ```
 *
 * @module enforce-output-style-tools
 */

import type { PreToolUseInput, PreToolUseHookOutput } from '../types/types.js';
import { runHook, wasToolEventMainAgent } from './utils/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from './utils/frontmatter.js';

const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('output-styles-permission-modes');

interface OutputStyleFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
}

/**
 * Read settings.json to get the current output style name
 *
 * Checks both settings.local.json (project-specific) and settings.json (committed)
 * for the outputStyle configuration. Returns the first match found.
 *
 * @param cwd - The working directory to search for settings files
 * @returns The output style name, or undefined if not configured
 *
 * @example
 * ```typescript
 * const styleName = await getCurrentOutputStyle('/path/to/project');
 * console.log(styleName); // 'read-only' or undefined
 * ```
 */
async function getCurrentOutputStyle(cwd: string): Promise<string | undefined> {
  const settingsPaths = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
  ];

  for (const settingsPath of settingsPaths) {
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.outputStyle) {
        return settings.outputStyle;
      }
    } catch {
      // File doesn't exist or is invalid JSON, try next path
      continue;
    }
  }

  return undefined;
}

/**
 * Load and parse output style file to get frontmatter
 *
 * Reads the output style markdown file and extracts its YAML frontmatter,
 * which contains the style configuration including tool restrictions.
 *
 * @param cwd - The working directory where output styles are stored
 * @param styleName - The name of the output style (without .md extension)
 * @returns The parsed frontmatter, or undefined if file not found
 *
 * @example
 * ```typescript
 * const frontmatter = await loadOutputStyleFrontmatter(
 *   '/path/to/project',
 *   'read-only'
 * );
 *
 * if (frontmatter) {
 *   console.log('Allowed tools:', frontmatter.tools);
 *   // ['Read', 'Glob', 'Grep']
 * }
 * ```
 */
async function loadOutputStyleFrontmatter(
  cwd: string,
  styleName: string
): Promise<OutputStyleFrontmatter | undefined> {
  const stylePaths = [
    path.join(cwd, '.claude', 'output-styles', `${styleName}.md`),
    // Note: User-level styles would be in ~/.claude/output-styles/
    // but we can't easily access user home in hooks without assumptions
  ];

  for (const stylePath of stylePaths) {
    try {
      const content = await fs.readFile(stylePath, 'utf-8');
      const { data } = matter(content);
      return data as OutputStyleFrontmatter;
    } catch {
      // File doesn't exist, try next path
      continue;
    }
  }

  return undefined;
}

/**
 * PreToolUse hook that enforces tool restrictions from output style frontmatter
 *
 * Checks if the current tool is allowed by the active output style's tool restrictions.
 * This hook only applies to the main agent - subagents can use any tools they need
 * to complete their tasks.
 *
 * The enforcement flow:
 * 1. Check if this is the main agent (skip for subagents)
 * 2. Read current output style from settings.json
 * 3. Load output style frontmatter to get allowed tools list
 * 4. Check if current tool is in the allowed list
 * 5. Allow or deny based on the check
 *
 * @param input - PreToolUse hook input with tool information
 * @returns Hook output with permissionDecision (allow/deny)
 *
 * @example
 * ```typescript
 * // Example output style: .claude/output-styles/read-only.md
 * // ---
 * // name: read-only
 * // tools: [Read, Glob, Grep]
 * // ---
 *
 * // Settings: .claude/settings.json
 * // { "outputStyle": "read-only" }
 *
 * // When main agent tries to use Read tool:
 * const result = await handler({
 *   tool_name: 'Read',
 *   tool_use_id: 'toolu_123',
 *   transcript_path: '/path/.claude/logs/session-abc.jsonl',
 *   cwd: '/path/to/project'
 *   // ... other fields
 * });
 * // Returns: { hookSpecificOutput: { permissionDecision: 'allow' } }
 *
 * // When main agent tries to use Write tool (not in allowed list):
 * const result2 = await handler({
 *   tool_name: 'Write',
 *   tool_use_id: 'toolu_456',
 *   transcript_path: '/path/.claude/logs/session-abc.jsonl',
 *   cwd: '/path/to/project'
 *   // ... other fields
 * });
 * // Returns: {
 * //   hookSpecificOutput: {
 * //     permissionDecision: 'deny',
 * //     permissionDecisionReason: 'The "Write" tool is not allowed...'
 * //   }
 * // }
 *
 * // When subagent tries to use Write tool:
 * const result3 = await handler({
 *   tool_name: 'Write',
 *   tool_use_id: 'toolu_789',
 *   transcript_path: '/path/.claude/logs/agent-xyz.jsonl', // Subagent transcript
 *   cwd: '/path/to/project'
 *   // ... other fields
 * });
 * // Returns: { hookSpecificOutput: { permissionDecision: 'allow' } }
 * // (Subagents are never restricted)
 * ```
 */
async function handler(input: PreToolUseInput): Promise<PreToolUseHookOutput> {
  if (DEBUG) {
    console.log('[enforce-output-style-tools] Hook triggered');
    console.log('[enforce-output-style-tools] Tool:', input.tool_name);
  }

  // Only enforce for main agent, not subagents
  const isMainAgent = await wasToolEventMainAgent(input.transcript_path, input.tool_use_id);
  if (!isMainAgent) {
    if (DEBUG) {
      console.log('[enforce-output-style-tools] Subagent detected, skipping enforcement');
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  // Get current output style
  const styleName = await getCurrentOutputStyle(input.cwd);
  if (!styleName) {
    if (DEBUG) {
      console.log('[enforce-output-style-tools] No output style configured, allowing all tools');
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  if (DEBUG) {
    console.log('[enforce-output-style-tools] Current output style:', styleName);
  }

  // Load output style frontmatter
  const frontmatter = await loadOutputStyleFrontmatter(input.cwd, styleName);
  if (!frontmatter || !frontmatter.tools || frontmatter.tools.length === 0) {
    if (DEBUG) {
      console.log('[enforce-output-style-tools] No tool restrictions defined, allowing all tools');
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  const allowedTools = frontmatter.tools;
  if (DEBUG) {
    console.log('[enforce-output-style-tools] Allowed tools:', allowedTools);
  }

  // Check if current tool is allowed
  const isAllowed = allowedTools.includes(input.tool_name);

  if (!isAllowed) {
    if (DEBUG) {
      console.log('[enforce-output-style-tools] Tool not allowed, blocking');
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `The "${input.tool_name}" tool is not allowed by the current output style "${styleName}". Allowed tools: ${allowedTools.join(', ')}`,
      },
    };
  }

  if (DEBUG) {
    console.log('[enforce-output-style-tools] Tool allowed');
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
}

// Export for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
