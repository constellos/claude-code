/**
 * PreToolUse Hook - Validate Folder Structure (Bash mkdir)
 *
 * This hook fires before Bash operations to validate directory creation against
 * CLAUDE.md folder specifications. Validates:
 * - mkdir commands creating new directories
 * - Checks parent's subfolder spec for allowed patterns
 *
 * Checks CLAUDE.md for folder specifications:
 * - folder.subfolders: Controls what subdirectories can exist
 *
 * @module hooks/validate-folder-structure-mkdir
 */

import type { PreToolUseInput, PreToolUseHookOutput } from '../types/types.js';
import { createDebugLogger } from './utils/debug.js';
import { runHook } from './utils/io.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from './utils/frontmatter.js';

interface ValidationSpec {
  allowed?: string[];
  required?: string[];
  forbidden?: string[];
}

interface FolderSpec {
  subfolders?: ValidationSpec;
  files?: ValidationSpec;
}

interface ClaudeMdFrontmatter {
  title?: string;
  description?: string;
  folder?: FolderSpec;
  [key: string]: unknown;
}

/**
 * Check if a string matches a gitignore-style pattern
 */
function matchesGitignorePattern(value: string, pattern: string): boolean {
  if (value === pattern) {
    return true;
  }

  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(value);
}

/**
 * Find CLAUDE.md file in a specific directory
 */
async function findClaudeMdInDir(dirPath: string): Promise<string | null> {
  const claudeMdPath = path.join(dirPath, 'CLAUDE.md');

  try {
    await fs.access(claudeMdPath);
    return claudeMdPath;
  } catch {
    return null;
  }
}

/**
 * Validate item against spec (files or folders)
 */
function validateAgainstSpec(
  itemName: string,
  spec: ValidationSpec,
  itemType: string
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check forbidden patterns
  if (spec.forbidden) {
    for (const forbiddenPattern of spec.forbidden) {
      if (matchesGitignorePattern(itemName, forbiddenPattern)) {
        errors.push(
          `${itemType} "${itemName}" matches forbidden pattern "${forbiddenPattern}"`
        );
      }
    }
  }

  // Check allowed patterns (if specified, item must match at least one)
  if (spec.allowed && spec.allowed.length > 0) {
    const isAllowed = spec.allowed.some(pattern =>
      matchesGitignorePattern(itemName, pattern)
    );

    if (!isAllowed) {
      errors.push(
        `${itemType} "${itemName}" is not allowed. Allowed patterns: ${spec.allowed.join(', ')}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract directory paths from mkdir commands
 * Handles: mkdir dir, mkdir -p dir, mkdir -p dir1 dir2, etc.
 */
function extractMkdirPaths(command: string): string[] {
  const paths: string[] = [];

  // Extract the actual command (before pipes, semicolons, &&, etc.)
  // This prevents false positives from strings containing "mkdir"
  const actualCommand = command.split(/[|;&]/)[0].trim();

  // Check if this is actually a mkdir command (not just containing "mkdir" in a string)
  if (!actualCommand.match(/^\s*(sudo\s+)?mkdir\b/)) {
    return paths;
  }

  // Remove mkdir and common flags
  const remainder = command
    .replace(/^.*mkdir\s+/, '')
    .replace(/-[pv]+\s+/g, '');

  // Extract all path arguments (space-separated)
  // Handle quoted paths
  const pathMatches = remainder.match(/(?:"([^"]+)"|'([^']+)'|(\S+))/g);

  if (pathMatches) {
    for (const match of pathMatches) {
      // Remove quotes if present
      const cleanPath = match.replace(/^["']|["']$/g, '');
      // Skip flags
      if (!cleanPath.startsWith('-')) {
        paths.push(cleanPath);
      }
    }
  }

  return paths;
}

/**
 * PreToolUse hook handler for validating folder structure in Bash mkdir operations
 */
async function handler(input: PreToolUseInput): Promise<PreToolUseHookOutput> {
  // Only run for Bash tool
  if (input.tool_name !== 'Bash') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  const logger = createDebugLogger(input.cwd, 'validate-folder-structure-mkdir', true);

  try {
    const toolInput = input.tool_input as { command?: string };
    const command = toolInput.command;

    if (!command) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Extract mkdir paths from command
    const mkdirPaths = extractMkdirPaths(command);

    if (mkdirPaths.length === 0) {
      // Not a mkdir command - don't log anything, just allow
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Only log input for actual mkdir commands
    await logger.logInput({
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      command,
      mkdirPaths,
    });

    await logger.logOutput({
      command,
      mkdirPaths,
    });

    const allErrors: string[] = [];

    // Validate each directory path
    for (const dirPath of mkdirPaths) {
      // Resolve to absolute path
      const absolutePath = path.isAbsolute(dirPath)
        ? dirPath
        : path.resolve(input.cwd, dirPath);

      const parentDir = path.dirname(absolutePath);
      const folderName = path.basename(absolutePath);

      await logger.logOutput({
        dirPath,
        absolutePath,
        parentDir,
        folderName,
      });

      // Check if directory already exists
      try {
        await fs.access(absolutePath);
        // Directory exists, no need to validate
        await logger.logOutput({
          dirPath,
          status: 'exists',
        });
        continue;
      } catch {
        // Directory doesn't exist, proceed with validation
      }

      // Validate the directory is allowed in parent's subfolder spec
      const parentClaudeMd = await findClaudeMdInDir(parentDir);

      if (parentClaudeMd) {
        const parentContent = await fs.readFile(parentClaudeMd, 'utf-8');
        const { data: parentData } = matter(parentContent);
        const parentFrontmatter = parentData as ClaudeMdFrontmatter;

        await logger.logOutput({
          check: 'parent-subfolder-validation',
          dirPath,
          parentClaudeMd,
          parentFrontmatter,
        });

        if (parentFrontmatter.folder?.subfolders) {
          const validation = validateAgainstSpec(
            folderName,
            parentFrontmatter.folder.subfolders,
            'Folder'
          );

          if (!validation.valid) {
            allErrors.push(
              `Cannot create directory "${folderName}" in "${parentDir}":\n` +
                validation.errors.map(e => `  - ${e}`).join('\n') +
                `\n\nParent folder restrictions defined in: ${parentClaudeMd}`
            );
          }
        }
      }
    }

    // If any validations failed, deny the operation
    if (allErrors.length > 0) {
      const errorMessage = allErrors.join('\n\n');

      await logger.logOutput({
        valid: false,
        errors: allErrors,
      });

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `Folder structure validation failed:\n\n${errorMessage}\n\n` +
            `Check the CLAUDE.md files for allowed patterns.`,
        },
      };
    }

    await logger.logOutput({ valid: true });

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
      systemMessage: `Folder structure validation hook failed: ${(error as Error).message || 'Unknown error'}`,
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
