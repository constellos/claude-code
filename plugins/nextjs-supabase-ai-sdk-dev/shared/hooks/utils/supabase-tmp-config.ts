/**
 * Supabase Temporary Config Directory Utility
 * Manages /tmp/ directories for Supabase config to avoid modifying checked-in files.
 * Uses symlinks for migrations, seed.sql, functions, and templates.
 * @module supabase-tmp-config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { SupabasePortSet } from './supabase-ports.js';

/**
 * Configuration for a temporary Supabase directory
 */
export interface TmpSupabaseConfig {
  /** Path to the tmp directory (e.g., /tmp/supabase-abc12345) */
  tmpDir: string;
  /** Path to config.toml in tmp directory */
  configPath: string;
  /** Path to original supabase/ directory */
  originalDir: string;
  /** Modified project_id for this instance */
  projectId: string;
  /** Assigned ports for this instance */
  ports: SupabasePortSet;
}

/**
 * Items to symlink from original supabase/ directory
 * These stay in sync with the original project
 */
const SYMLINK_ITEMS = ['seed.sql', 'migrations', 'functions', 'templates'] as const;


/**
 * Generate the tmp directory path for a Supabase instance
 *
 * IMPORTANT: Supabase CLI uses the workdir directory basename for container naming,
 * NOT the project_id from config.toml. So we must name the directory after the projectId.
 *
 * @param projectId - The full project ID including slot suffix (e.g., "constellos" or "constellos-1")
 * @returns Path to tmp directory (e.g., /tmp/constellos or /tmp/constellos-1)
 *
 * @example
 * ```typescript
 * getTmpSupabasePath('constellos')    // Returns: '/tmp/constellos'
 * getTmpSupabasePath('constellos-1')  // Returns: '/tmp/constellos-1'
 * getTmpSupabasePath('constellos-2')  // Returns: '/tmp/constellos-2'
 * ```
 */
export function getTmpSupabasePath(projectId: string): string {
  // Normalize project ID to lowercase alphanumeric with dashes
  const normalizedId = projectId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `/tmp/${normalizedId}`;
}

/**
 * Create a fresh temporary Supabase directory with symlinks
 * Cleans up any existing directory first (fresh each session)
 *
 * @param projectId - Full project ID including slot suffix (e.g., "constellos" or "constellos-1")
 * @param originalSupabaseDir - Path to original supabase/ directory
 * @param ports - Port set to configure
 * @returns Configuration for the tmp directory
 * @throws Error if original directory doesn't exist or can't create tmp
 */
export function createTmpSupabaseDir(
  projectId: string,
  originalSupabaseDir: string,
  ports: SupabasePortSet
): TmpSupabaseConfig {
  const tmpDir = getTmpSupabasePath(projectId);
  // Supabase CLI expects supabase/ subdirectory inside --workdir
  const tmpSupabaseDir = join(tmpDir, 'supabase');

  // Verify original directory exists
  if (!existsSync(originalSupabaseDir)) {
    throw new Error(`Original Supabase directory not found: ${originalSupabaseDir}`);
  }

  const originalConfigPath = join(originalSupabaseDir, 'config.toml');
  if (!existsSync(originalConfigPath)) {
    throw new Error(`Original config.toml not found: ${originalConfigPath}`);
  }

  // Clean up existing tmp directory (fresh each session)
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Create tmp directory with supabase/ subdirectory
  // Structure: /tmp/{projectId}/supabase/config.toml
  // This matches what Supabase CLI expects with --workdir flag
  mkdirSync(tmpSupabaseDir, { recursive: true });

  // Create symlinks for allowed items inside supabase/ subdirectory
  createSymlinks(tmpSupabaseDir, originalSupabaseDir);

  // Copy and update config.toml inside supabase/ subdirectory
  const tmpConfigPath = join(tmpSupabaseDir, 'config.toml');
  copyAndUpdateConfig(originalConfigPath, tmpConfigPath, projectId, ports);

  return {
    tmpDir,
    configPath: tmpConfigPath,
    originalDir: originalSupabaseDir,
    projectId,
    ports,
  };
}

/**
 * Create symlinks from tmp directory to original supabase/ items
 * Only symlinks items that exist in original directory
 *
 * @param tmpDir - Tmp directory to create symlinks in
 * @param originalDir - Original supabase/ directory
 */
export function createSymlinks(tmpDir: string, originalDir: string): void {
  for (const item of SYMLINK_ITEMS) {
    const originalPath = join(originalDir, item);
    const tmpPath = join(tmpDir, item);

    // Only create symlink if original exists
    if (existsSync(originalPath)) {
      try {
        symlinkSync(originalPath, tmpPath, 'junction');
      } catch (err) {
        // Fallback to regular symlink if junction fails (non-Windows)
        try {
          symlinkSync(originalPath, tmpPath);
        } catch {
          // If symlink fails entirely, skip this item
          console.error(`Warning: Could not create symlink for ${item}: ${err}`);
        }
      }
    }
  }
}

/**
 * Copy config.toml and update with new project_id and ports
 *
 * @param originalConfigPath - Path to original config.toml
 * @param tmpConfigPath - Path to write updated config
 * @param projectId - New project_id to set
 * @param ports - Port values to set
 */
export function copyAndUpdateConfig(
  originalConfigPath: string,
  tmpConfigPath: string,
  projectId: string,
  ports: SupabasePortSet
): void {
  let content = readFileSync(originalConfigPath, 'utf-8');

  // Update project_id
  content = content.replace(
    /^(\s*project_id\s*=\s*)"[^"]*"/m,
    `$1"${projectId}"`
  );

  // Update ports using helper function
  content = updateConfigPorts(content, ports);

  writeFileSync(tmpConfigPath, content, 'utf-8');
}

/**
 * Update port values in config.toml content
 *
 * @param content - Config.toml content
 * @param ports - New port values
 * @returns Updated content
 */
function updateConfigPorts(content: string, ports: SupabasePortSet): string {
  // Helper to update a port value in a section
  const updatePort = (sectionPattern: string, key: string, value: number): void => {
    // Pattern to match [section] followed by key = value
    const regex = new RegExp(
      `(\\[${sectionPattern}\\][\\s\\S]*?)(^\\s*${key}\\s*=\\s*)(\\d+)`,
      'gm'
    );

    if (regex.test(content)) {
      regex.lastIndex = 0;
      content = content.replace(regex, `$1$2${value}`);
    }
  };

  // Update each port
  updatePort('api', 'port', ports.api);
  updatePort('db', 'port', ports.db);
  updatePort('db', 'shadow_port', ports.shadowDb);
  updatePort('db\\.pooler', 'port', ports.pooler);
  updatePort('studio', 'port', ports.studio);
  updatePort('inbucket', 'port', ports.inbucket);
  updatePort('analytics', 'port', ports.analytics);
  updatePort('edge_runtime', 'inspector_port', ports.edgeRuntime);

  return content;
}

/**
 * Clean up a temporary Supabase directory
 * Safe to call even if directory doesn't exist
 *
 * @param tmpDir - Path to tmp directory to remove
 */
export function cleanupTmpSupabaseDir(tmpDir: string): void {
  if (existsSync(tmpDir)) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`Warning: Could not clean up tmp directory ${tmpDir}: ${err}`);
    }
  }
}

/**
 * Add tmp directory pattern to .gitignore if not already present
 *
 * @param projectRoot - Project root directory (where .gitignore is)
 * @param tmpPath - Tmp directory path to add (will be converted to pattern)
 * @returns true if pattern was added, false if already present
 */
export function addToGitignore(projectRoot: string, _tmpPath?: string): boolean {
  const gitignorePath = join(projectRoot, '.gitignore');
  const pattern = '/tmp/supabase-*';

  // Check if .gitignore exists
  if (!existsSync(gitignorePath)) {
    // Create .gitignore with just this pattern
    writeFileSync(gitignorePath, `# Supabase temp config directories\n${pattern}\n`, 'utf-8');
    return true;
  }

  // Read existing content
  const content = readFileSync(gitignorePath, 'utf-8');

  // Check if pattern already exists (with various formats)
  const patterns = [pattern, '/tmp/supabase-', 'tmp/supabase-'];
  for (const p of patterns) {
    if (content.includes(p)) {
      return false; // Already present
    }
  }

  // Add pattern at the end
  const separator = content.endsWith('\n') ? '' : '\n';
  appendFileSync(gitignorePath, `${separator}\n# Supabase temp config directories\n${pattern}\n`, 'utf-8');
  return true;
}

/**
 * Check if a tmp Supabase directory exists for a project
 *
 * @param projectId - The full project ID including slot suffix
 * @returns true if tmp directory exists
 */
export function tmpSupabaseDirExists(projectId: string): boolean {
  const tmpDir = getTmpSupabasePath(projectId);
  return existsSync(tmpDir);
}

/**
 * Get the config.toml path for a tmp Supabase directory
 *
 * @param projectId - The full project ID including slot suffix
 * @returns Path to config.toml in tmp directory
 */
export function getTmpConfigPath(projectId: string): string {
  return join(getTmpSupabasePath(projectId), 'config.toml');
}

/**
 * List all tmp Supabase directories currently on the system
 * Useful for cleanup and diagnostics
 *
 * @returns Array of tmp directory paths
 */
export function listTmpSupabaseDirs(): string[] {
  const tmpDir = '/tmp';
  if (!existsSync(tmpDir)) {
    return [];
  }

  try {
    const entries = readdirSync(tmpDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith('supabase-'))
      .map(entry => join(tmpDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Clean up all tmp Supabase directories
 * Use with caution - will remove all instances
 *
 * @returns Number of directories cleaned up
 */
export function cleanupAllTmpSupabaseDirs(): number {
  const dirs = listTmpSupabaseDirs();
  let cleaned = 0;

  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
      cleaned++;
    } catch {
      // Continue with other directories
    }
  }

  return cleaned;
}
