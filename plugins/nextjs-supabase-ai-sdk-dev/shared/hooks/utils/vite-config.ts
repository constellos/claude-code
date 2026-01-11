/**
 * Vite Configuration Parser Utility
 * Parses vite.config.ts files to extract server.port configuration.
 * @module vite-config
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Default Vite dev server port
 */
export const VITE_DEFAULT_PORT = 5173;

/**
 * Parse vite.config.ts/js/mjs to extract server.port value
 * Uses regex to extract port from various config patterns:
 * - server: { port: 3000 }
 * - server: { port: Number(3000) }
 * - defineConfig({ server: { port: 3000 } })
 *
 * @param viteConfigPath - Path to vite.config.ts/js/mjs file
 * @returns Configured port number, or null if not found
 * @example
 * ```typescript
 * const port = getViteConfigPort('/path/to/vite.config.ts');
 * // Returns: 3000 (if configured) or null (if not found)
 * ```
 */
export function getViteConfigPort(viteConfigPath: string): number | null {
  if (!existsSync(viteConfigPath)) {
    return null;
  }

  try {
    const content = readFileSync(viteConfigPath, 'utf-8');

    // Pattern 1: server: { port: 3000 } or server: { port: 3000, ... }
    // Handles multiline and various whitespace
    const serverBlockMatch = content.match(
      /server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s
    );
    if (serverBlockMatch) {
      return parseInt(serverBlockMatch[1], 10);
    }

    // Pattern 2: server.port = 3000 (less common but valid)
    const dotNotationMatch = content.match(
      /server\.port\s*[=:]\s*(\d+)/
    );
    if (dotNotationMatch) {
      return parseInt(dotNotationMatch[1], 10);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Find and parse vite.config file in a directory
 * Tries .ts, .js, .mjs extensions in order
 *
 * @param workspacePath - Directory to search for vite config
 * @returns Configured port number, or null if not found
 * @example
 * ```typescript
 * const port = findViteConfigPort('/path/to/project');
 * // Searches for vite.config.ts, vite.config.js, vite.config.mjs
 * ```
 */
export function findViteConfigPort(workspacePath: string): number | null {
  const extensions = ['ts', 'js', 'mjs'];

  for (const ext of extensions) {
    const configPath = join(workspacePath, `vite.config.${ext}`);
    const port = getViteConfigPort(configPath);
    if (port !== null) {
      return port;
    }
  }

  return null;
}

/**
 * Check if a directory contains a Vite configuration file
 *
 * @param workspacePath - Directory to check
 * @returns true if vite.config.{ts,js,mjs} exists
 */
export function hasViteConfig(workspacePath: string): boolean {
  const extensions = ['ts', 'js', 'mjs'];
  return extensions.some(ext =>
    existsSync(join(workspacePath, `vite.config.${ext}`))
  );
}

/**
 * Get the path to the vite config file if it exists
 *
 * @param workspacePath - Directory to search
 * @returns Path to vite config file, or null if not found
 */
export function getViteConfigPath(workspacePath: string): string | null {
  const extensions = ['ts', 'js', 'mjs'];

  for (const ext of extensions) {
    const configPath = join(workspacePath, `vite.config.${ext}`);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}
