/**
 * Package manager detection and command utilities
 *
 * Detects which package manager (npm, yarn, pnpm, or bun) a project uses
 * by checking for the presence of lockfiles, and provides utilities for
 * constructing package manager commands.
 *
 * @module package-manager
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Detect which package manager is used in a project
 *
 * Checks for the presence of lockfiles in the following priority order:
 * 1. bun.lockb (Bun)
 * 2. pnpm-lock.yaml (pnpm)
 * 3. yarn.lock (Yarn)
 * 4. package-lock.json (npm)
 * 5. Falls back to bun if no lockfile is found (modern default)
 *
 * @param cwd - The directory to check for lockfiles
 * @returns The detected package manager: 'bun', 'pnpm', 'yarn', or 'npm'
 *
 * @example
 * ```typescript
 * import { detectPackageManager } from './package-manager.js';
 *
 * const pm = detectPackageManager('/path/to/project');
 * console.log(pm); // 'npm' | 'yarn' | 'pnpm' | 'bun'
 * ```
 */
export function detectPackageManager(cwd: string): 'npm' | 'yarn' | 'pnpm' | 'bun' {
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
  return 'bun'; // Modern default when no lockfile found
}

/**
 * Get the command to run a package.json script
 *
 * Constructs the appropriate command for running a package.json script
 * based on the detected package manager. All package managers use the
 * format: `{pm} run {script}`.
 *
 * @param cwd - The project directory to detect the package manager from
 * @param script - The script name from package.json to run (e.g., 'test', 'build')
 * @returns The full command string to execute the script
 *
 * @example
 * ```typescript
 * import { getScriptCommand } from './package-manager.js';
 *
 * const command = getScriptCommand('/path/to/project', 'test');
 * // Returns: 'npm run test' or 'yarn run test' or 'pnpm run test' or 'bun run test'
 * ```
 */
export function getScriptCommand(cwd: string, script: string): string {
  const pm = detectPackageManager(cwd);
  return `${pm} run ${script}`;
}
