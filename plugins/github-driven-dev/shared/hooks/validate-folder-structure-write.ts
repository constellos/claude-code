/**
 * PreToolUse Hook - Validate Folder Structure (Write)
 *
 * This hook fires before Write operations to validate file creation against
 * CLAUDE.md folder specifications. Validates both:
 * 1. File is in an allowed subdirectory (checks parent's subfolder spec)
 * 2. File matches allowed patterns in its immediate directory (checks files spec)
 *
 * Checks CLAUDE.md for folder specifications:
 * - folder.subfolders: Controls what subdirectories can exist
 * - folder.files: Controls what files can exist in the folder
 *
 * @module hooks/validate-folder-structure-write
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
 * PreToolUse hook handler for validating folder structure in Write operations
 */
async function handler(input: PreToolUseInput): Promise<PreToolUseHookOutput> {
  // Only run for Write tool
  if (input.tool_name !== 'Write') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  const logger = createDebugLogger(input.cwd, 'validate-folder-structure-write', true);

  try {
    await logger.logInput({
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
    });

    const toolInput = input.tool_input as { file_path?: string };
    const filePath = toolInput.file_path;

    if (!filePath) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Resolve to absolute path
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(input.cwd, filePath);

    const fileDir = path.dirname(absolutePath);
    const fileName = path.basename(absolutePath);
    const parentDir = path.dirname(fileDir);
    const folderName = path.basename(fileDir);

    await logger.logOutput({
      filePath,
      absolutePath,
      fileDir,
      fileName,
      parentDir,
      folderName,
    });

    const allErrors: string[] = [];

    // Check 1: Validate the directory itself is allowed (check parent's subfolder spec)
    const parentClaudeMd = await findClaudeMdInDir(parentDir);

    if (parentClaudeMd) {
      const parentContent = await fs.readFile(parentClaudeMd, 'utf-8');
      const { data: parentData } = matter(parentContent);
      const parentFrontmatter = parentData as ClaudeMdFrontmatter;

      await logger.logOutput({
        check: 'parent-subfolder-validation',
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
            `Cannot create file in directory "${folderName}":\n` +
              validation.errors.map(e => `  - ${e}`).join('\n') +
              `\n\nParent folder restrictions defined in: ${parentClaudeMd}`
          );
        }
      }
    }

    // Check 2: Validate the file itself is allowed (check directory's files spec)
    const dirClaudeMd = await findClaudeMdInDir(fileDir);

    if (dirClaudeMd) {
      const dirContent = await fs.readFile(dirClaudeMd, 'utf-8');
      const { data: dirData } = matter(dirContent);
      const dirFrontmatter = dirData as ClaudeMdFrontmatter;

      await logger.logOutput({
        check: 'file-validation',
        dirClaudeMd,
        dirFrontmatter,
      });

      if (dirFrontmatter.folder?.files) {
        const validation = validateAgainstSpec(
          fileName,
          dirFrontmatter.folder.files,
          'File'
        );

        if (!validation.valid) {
          allErrors.push(
            `Cannot create file "${fileName}" in this directory:\n` +
              validation.errors.map(e => `  - ${e}`).join('\n') +
              `\n\nFile restrictions defined in: ${dirClaudeMd}`
          );
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
            `File structure validation failed:\n\n${errorMessage}\n\n` +
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
      systemMessage: `File structure validation hook failed: ${(error as Error).message || 'Unknown error'}`,
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
