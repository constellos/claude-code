/**
 * Rules matcher utility for Claude Code hooks
 *
 * Discovers rules files in .claude/rules/ and matches them against edited files
 * based on glob patterns in frontmatter. Used by SubagentStop hooks to include
 * relevant rules as validation context.
 *
 * @module rules-matcher
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import matter from './frontmatter.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a parsed rule file with its path patterns
 */
export interface RuleFile {
  /** Absolute path to the rule file */
  filePath: string;
  /** Relative path from rules directory */
  relativePath: string;
  /** Glob patterns from frontmatter that define which files this rule applies to */
  paths?: string[];
  /** Full content of the rule file */
  content: string;
  /** Rule file name without extension */
  name: string;
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Discover all rules files in .claude/rules/ and parse their paths frontmatter
 *
 * Recursively scans the rules directory for markdown files and parses their
 * YAML frontmatter to extract path patterns.
 *
 * @param cwd - Project working directory
 * @returns Array of parsed rule files
 *
 * @example
 * ```typescript
 * const rules = await discoverRules('/path/to/project');
 * for (const rule of rules) {
 *   console.log(rule.name, rule.paths);
 * }
 * ```
 */
export async function discoverRules(cwd: string): Promise<RuleFile[]> {
  const rulesDir = path.join(cwd, '.claude', 'rules');

  // Check if rules directory exists
  try {
    await fs.access(rulesDir);
  } catch {
    return [];
  }

  const rules: RuleFile[] = [];

  // Recursively find all .md files
  async function scanDirectory(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await scanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const { data } = matter(content);
          const relativePath = path.relative(rulesDir, fullPath);

          rules.push({
            filePath: fullPath,
            relativePath,
            paths: data.paths as string[] | undefined,
            content,
            name: path.basename(fullPath, '.md'),
          });
        } catch {
          // Skip files that can't be read or parsed
        }
      }
    }
  }

  await scanDirectory(rulesDir);
  return rules;
}

// ============================================================================
// Matching
// ============================================================================

/**
 * Find rules that match any of the given file paths
 *
 * Uses minimatch to check if edited files match the glob patterns defined
 * in rule frontmatter. Only returns rules that have `paths` defined and
 * match at least one edited file.
 *
 * @param rules - Array of rule files from discoverRules()
 * @param editedFiles - Array of absolute file paths that were edited
 * @param cwd - Project working directory (for relative path calculation)
 * @returns Deduplicated array of matching rules
 *
 * @example
 * ```typescript
 * const rules = await discoverRules(cwd);
 * const editedFiles = ['/project/src/hooks/my-hook.ts'];
 * const matchingRules = matchRulesToFiles(rules, editedFiles, cwd);
 * ```
 */
export function matchRulesToFiles(
  rules: RuleFile[],
  editedFiles: string[],
  cwd: string
): RuleFile[] {
  const matchingRules: RuleFile[] = [];
  const seenPaths = new Set<string>();

  for (const rule of rules) {
    // Rules without paths field don't apply to specific files
    if (!rule.paths || rule.paths.length === 0) {
      continue;
    }

    // Check if any edited file matches any rule path pattern
    let matched = false;
    for (const editedFile of editedFiles) {
      const relativePath = path.relative(cwd, editedFile);

      for (const pattern of rule.paths) {
        if (minimatch(relativePath, pattern, { matchBase: true })) {
          matched = true;
          break;
        }
      }

      if (matched) break;
    }

    if (matched && !seenPaths.has(rule.filePath)) {
      matchingRules.push(rule);
      seenPaths.add(rule.filePath);
    }
  }

  return matchingRules;
}

/**
 * Format matching rules as context string for review hooks
 *
 * Creates a formatted string with rule names and truncated content
 * suitable for inclusion in systemMessage.
 *
 * @param matchingRules - Array of matching rules
 * @param maxContentLength - Maximum characters per rule content (default: 1000)
 * @returns Formatted rules context string
 */
export function formatRulesContext(
  matchingRules: RuleFile[],
  maxContentLength = 1000
): string {
  if (matchingRules.length === 0) {
    return '';
  }

  const lines: string[] = ['## Applicable Rules', ''];

  for (const rule of matchingRules) {
    lines.push(`### ${rule.name}`);

    // Truncate content if too long
    if (rule.content.length > maxContentLength) {
      lines.push(rule.content.slice(0, maxContentLength) + '...');
    } else {
      lines.push(rule.content);
    }

    lines.push('');
  }

  return lines.join('\n');
}
