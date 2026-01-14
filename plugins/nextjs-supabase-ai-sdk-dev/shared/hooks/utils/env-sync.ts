/**
 * Environment variable synchronization utilities for turborepo workspaces
 *
 * Provides functions to collect, merge, validate, and distribute environment variables
 * across multiple workspaces in a turborepo project. Ensures consistent environment
 * configuration across all apps.
 *
 * Supported frameworks and their env var prefixes:
 * - Next.js: NEXT_PUBLIC_* for client-side, unprefixed for server-side
 * - Vite: VITE_* for client-side
 * - Cloudflare Workers: Unprefixed in dev.vars
 *
 * @module env-sync
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { isPortAvailable } from './port.js';

/**
 * Workspace framework type for environment variable prefixing
 */
export type WorkspaceFramework = 'nextjs' | 'vite' | 'cloudflare' | 'elysia' | 'unknown';

/**
 * Detect if a workspace uses Supabase by checking dependencies
 *
 * Checks for:
 * 1. Direct Supabase SDK usage (@supabase/supabase-js, @supabase/ssr)
 * 2. Internal packages that wrap Supabase (@scope/supabase, *supabase*)
 *
 * @param workspacePath - Path to the workspace directory
 * @returns True if the workspace uses Supabase
 */
export function detectSupabaseUsage(workspacePath: string): boolean {
  const packageJsonPath = join(workspacePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // Check for direct Supabase SDK usage
    if ('@supabase/supabase-js' in allDeps || '@supabase/ssr' in allDeps) {
      return true;
    }

    // Check for internal packages that wrap Supabase
    // Pattern: @{scope}/supabase, @{scope}/*supabase*, *supabase*
    for (const dep of Object.keys(allDeps)) {
      // Match patterns like @nodes-md/supabase, @repo/supabase, my-supabase-wrapper
      if (
        dep.endsWith('/supabase') || // @scope/supabase
        /^@[^/]+\/.*supabase.*$/.test(dep) // @scope/*supabase*
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if ANY workspace in the monorepo uses Supabase directly
 *
 * This is a fallback for monorepos where apps depend on internal packages
 * that wrap Supabase. If any package in packages/ has @supabase dependencies,
 * we assume all apps may need the env vars.
 *
 * @param cwd - Root directory of the monorepo
 * @returns True if any package uses Supabase
 */
export function hasSupabaseInMonorepo(cwd: string): boolean {
  const packagesDir = join(cwd, 'packages');
  if (!existsSync(packagesDir)) {
    return false;
  }

  try {
    const entries = readdirSync(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pkgPath = join(packagesDir, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;

      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if ('@supabase/supabase-js' in allDeps || '@supabase/ssr' in allDeps) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Detect the framework type of a workspace based on config files
 * Falls back to checking package.json dependencies if no config files found
 *
 * @param workspacePath - Path to the workspace directory
 * @returns Detected framework type
 */
export function detectWorkspaceFramework(workspacePath: string): WorkspaceFramework {
  // Check for Next.js config files first
  if (
    existsSync(join(workspacePath, 'next.config.js')) ||
    existsSync(join(workspacePath, 'next.config.mjs')) ||
    existsSync(join(workspacePath, 'next.config.ts'))
  ) {
    return 'nextjs';
  }

  // Check for Vite config files
  if (
    existsSync(join(workspacePath, 'vite.config.ts')) ||
    existsSync(join(workspacePath, 'vite.config.js')) ||
    existsSync(join(workspacePath, 'vite.config.mjs'))
  ) {
    return 'vite';
  }

  // Check for Cloudflare Workers
  if (
    existsSync(join(workspacePath, 'wrangler.toml')) ||
    existsSync(join(workspacePath, 'wrangler.jsonc'))
  ) {
    return 'cloudflare';
  }

  // Fallback: Check package.json dependencies for framework detection
  // This catches cases where config files are missing but deps indicate the framework
  const packageJsonPath = join(workspacePath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Check for Next.js dependency
      if ('next' in allDeps) {
        return 'nextjs';
      }

      // Check for Vite dependency
      if ('vite' in allDeps) {
        return 'vite';
      }

      // Check for Cloudflare/Wrangler dependency
      if ('wrangler' in allDeps || '@cloudflare/workers-types' in allDeps) {
        return 'cloudflare';
      }

      // Check for Elysia dependency (Bun framework)
      if ('elysia' in allDeps) {
        return 'elysia';
      }
    } catch {
      // Ignore parse errors
    }
  }

  return 'unknown';
}

/**
 * Get the public environment variable prefix for a framework
 *
 * @param framework - The workspace framework type
 * @returns The prefix to use for client-exposed environment variables
 */
export function getPublicEnvPrefix(framework: WorkspaceFramework): string {
  switch (framework) {
    case 'nextjs':
      return 'NEXT_PUBLIC_';
    case 'vite':
      return 'VITE_';
    case 'elysia':
    case 'cloudflare':
    default:
      return '';
  }
}

/**
 * Environment variable sets organized by source
 */
export interface EnvVarSet {
  /** Environment variables from Supabase CLI (SUPABASE_URL, etc.) */
  supabaseVars: Record<string, string>;
  /** Environment variables from Vercel CLI */
  vercelVars: Record<string, string>;
  /** Next.js prefixed variables (NEXT_PUBLIC_*) */
  nextjsVars: Record<string, string>;
  /** Cloudflare variables (unprefixed for dev.vars) */
  cloudflareVars: Record<string, string>;
}

/**
 * Options for distributing environment variables
 */
export interface DistributeOptions {
  /** Create .env.local and dev.vars files if they don't exist */
  createIfMissing: boolean;
  /** Preserve existing environment variables (don't overwrite) */
  preserveExisting: boolean;
  /** Keys that should always be overwritten, even if preserveExisting is true */
  alwaysOverwriteKeys?: string[];
}

/**
 * Validation result for environment variables
 */
export interface ValidationResult {
  /** Whether all required variables are present */
  valid: boolean;
  /** List of missing required variables */
  missing: string[];
}

/**
 * Read and parse a .env.local file
 *
 * Parses a .env.local file into a key-value object. Handles:
 * - Comments starting with #
 * - Empty lines
 * - KEY=value format
 * - Quoted values
 *
 * @param path - Path to the directory containing .env.local
 * @returns Object with parsed environment variables
 *
 * @example
 * ```typescript
 * import { readEnvLocalFile } from './env-sync.js';
 *
 * const vars = await readEnvLocalFile('/path/to/app');
 * console.log(vars.NEXT_PUBLIC_SUPABASE_URL);
 * ```
 */
export async function readEnvLocalFile(path: string): Promise<Record<string, string>> {
  const envPath = join(path, '.env.local');
  if (!existsSync(envPath)) {
    return {};
  }

  const content = readFileSync(envPath, 'utf-8');
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parse KEY=value
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}

/**
 * Merge environment variables from multiple workspace .env.local files
 *
 * Reads .env.local files from all workspaces and merges them into a single
 * object. Later workspaces override earlier ones if there are conflicts.
 *
 * @param workspaces - Array of workspace paths relative to cwd
 * @param cwd - Root directory of the project
 * @returns Merged environment variables
 *
 * @example
 * ```typescript
 * import { mergeWorkspaceEnvVars } from './env-sync.js';
 *
 * const vars = await mergeWorkspaceEnvVars(
 *   ['apps/web', 'apps/api', 'apps/mcp'],
 *   '/path/to/project'
 * );
 * ```
 */
export async function mergeWorkspaceEnvVars(
  workspaces: string[],
  cwd: string
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (const workspace of workspaces) {
    const workspacePath = join(cwd, workspace);
    const vars = await readEnvLocalFile(workspacePath);
    Object.assign(merged, vars);
  }

  return merged;
}

/**
 * Validate that required environment variables are present
 *
 * Checks that all required variables exist in at least one of the variable sets.
 *
 * @param vars - Environment variable sets to validate
 * @param required - List of required variable names
 * @returns Validation result with missing variables
 *
 * @example
 * ```typescript
 * import { validateEnvVars } from './env-sync.js';
 *
 * const result = validateEnvVars(
 *   { supabaseVars, vercelVars },
 *   ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY']
 * );
 *
 * if (!result.valid) {
 *   console.warn('Missing vars:', result.missing);
 * }
 * ```
 */
export function validateEnvVars(
  vars: Partial<EnvVarSet>,
  required: string[]
): ValidationResult {
  const allVars = {
    ...vars.supabaseVars,
    ...vars.vercelVars,
    ...vars.nextjsVars,
    ...vars.cloudflareVars,
  };

  const missing: string[] = [];
  for (const key of required) {
    if (!(key in allVars)) {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Distribute environment variables to a workspace
 *
 * Writes environment variables to .env.local (for Next.js) and dev.vars
 * (for Cloudflare Workers) in the specified workspace directory.
 *
 * @param workspacePath - Path to the workspace directory
 * @param vars - Environment variable sets to distribute
 * @param options - Distribution options
 * @returns Object indicating which files were written
 *
 * @example
 * ```typescript
 * import { distributeEnvVars } from './env-sync.js';
 *
 * const result = await distributeEnvVars(
 *   '/path/to/apps/web',
 *   { supabaseVars, vercelVars },
 *   { createIfMissing: true, preserveExisting: true }
 * );
 *
 * if (result.nextjs) console.log('Next.js .env.local updated');
 * if (result.vite) console.log('Vite .env.local updated');
 * if (result.cloudflare) console.log('dev.vars updated');
 * ```
 */
export async function distributeEnvVars(
  workspacePath: string,
  vars: Partial<EnvVarSet>,
  options: DistributeOptions
): Promise<{ nextjs: boolean; vite: boolean; cloudflare: boolean }> {
  let nextjsWritten = false;
  let viteWritten = false;
  let cloudflareWritten = false;

  // Detect workspace framework to use correct prefix
  const framework = detectWorkspaceFramework(workspacePath);
  const publicPrefix = getPublicEnvPrefix(framework);

  // Prepare combined vars for frontend frameworks (Next.js or Vite)
  const frontendVars: Record<string, string> = {};

  // Add Vercel vars FIRST - these may contain old values from existing env files
  // Supabase vars will be applied last to ensure correct values always win
  if (vars.vercelVars) {
    for (const [key, value] of Object.entries(vars.vercelVars)) {
      if (framework === 'vite' && key.startsWith('NEXT_PUBLIC_')) {
        // Convert NEXT_PUBLIC_ to VITE_ for Vite workspaces
        const unprefixed = key.replace('NEXT_PUBLIC_', '');
        frontendVars[`VITE_${unprefixed}`] = value;
      } else {
        frontendVars[key] = value;
      }
    }
  }

  // Add explicit Next.js vars (convert prefix for Vite)
  if (vars.nextjsVars) {
    for (const [key, value] of Object.entries(vars.nextjsVars)) {
      if (framework === 'vite' && key.startsWith('NEXT_PUBLIC_')) {
        const unprefixed = key.replace('NEXT_PUBLIC_', '');
        frontendVars[`VITE_${unprefixed}`] = value;
      } else {
        frontendVars[key] = value;
      }
    }
  }

  // Add Supabase vars LAST with framework-specific prefix
  // Applied last so fresh values from Supabase CLI always override stale env file values
  if (vars.supabaseVars) {
    for (const [key, value] of Object.entries(vars.supabaseVars)) {
      if (key === 'SUPABASE_URL') {
        frontendVars[`${publicPrefix}SUPABASE_URL`] = value;
      } else if (key === 'SUPABASE_PUBLISHABLE_KEY') {
        frontendVars[`${publicPrefix}SUPABASE_PUBLISHABLE_KEY`] = value;
      } else if (key === 'SUPABASE_SECRET_KEY') {
        frontendVars['SUPABASE_SECRET_KEY'] = value; // No prefix for secret
      }
    }
  }

  // Write to .env.local for frontend frameworks (Next.js or Vite)
  const envLocalPath = join(workspacePath, '.env.local');
  if ((framework === 'nextjs' || framework === 'vite') && Object.keys(frontendVars).length > 0) {
    if (existsSync(envLocalPath)) {
      // Merge with existing, respecting alwaysOverwriteKeys
      const existing = await readEnvLocalFile(workspacePath);

      // Split vars into protected (always overwrite) and regular
      const protectedKeys = new Set(options.alwaysOverwriteKeys || []);
      const protectedVars: Record<string, string> = {};
      const regularVars: Record<string, string> = {};

      for (const [key, value] of Object.entries(frontendVars)) {
        if (protectedKeys.has(key)) {
          protectedVars[key] = value;
        } else {
          regularVars[key] = value;
        }
      }

      // Merge: regular vars respect preserveExisting, protected vars always overwrite
      const mergedRegular = options.preserveExisting
        ? { ...regularVars, ...existing } // Existing takes precedence for regular vars
        : { ...existing, ...regularVars }; // New takes precedence for regular vars

      // Protected vars always overwrite, applied last
      const merged = { ...mergedRegular, ...protectedVars };

      const lines = Object.entries(merged).map(([key, value]) => `${key}=${value}`);
      writeFileSync(envLocalPath, lines.join('\n') + '\n');
      if (framework === 'nextjs') {
        nextjsWritten = true;
      } else {
        viteWritten = true;
      }
    } else if (options.createIfMissing) {
      const lines = Object.entries(frontendVars).map(([key, value]) => `${key}=${value}`);
      writeFileSync(envLocalPath, lines.join('\n') + '\n');
      if (framework === 'nextjs') {
        nextjsWritten = true;
      } else {
        viteWritten = true;
      }
    }
  }

  // Prepare vars for Cloudflare (unprefixed)
  const cloudflareVars: Record<string, string> = {};

  // Add Vercel vars FIRST (strip NEXT_PUBLIC_ prefix for Cloudflare)
  // These may contain old values from existing env files
  if (vars.vercelVars) {
    for (const [key, value] of Object.entries(vars.vercelVars)) {
      if (key.startsWith('NEXT_PUBLIC_')) {
        const unprefixed = key.replace('NEXT_PUBLIC_', '');
        cloudflareVars[unprefixed] = value;
      } else {
        cloudflareVars[key] = value;
      }
    }
  }

  // Add Cloudflare-specific vars
  if (vars.cloudflareVars) {
    Object.assign(cloudflareVars, vars.cloudflareVars);
  }

  // Add Supabase vars LAST without NEXT_PUBLIC_ prefix
  // Applied last so fresh values from Supabase CLI always override stale env file values
  if (vars.supabaseVars) {
    Object.assign(cloudflareVars, vars.supabaseVars);
  }

  // Write to dev.vars (only if wrangler.toml/wrangler.jsonc exists)
  const devVarsPath = join(workspacePath, 'dev.vars');
  const hasWrangler = existsSync(join(workspacePath, 'wrangler.toml')) ||
                      existsSync(join(workspacePath, 'wrangler.jsonc'));

  if (hasWrangler && Object.keys(cloudflareVars).length > 0) {
    if (existsSync(devVarsPath)) {
      // Merge with existing, respecting alwaysOverwriteKeys
      const existing = readFileSync(devVarsPath, 'utf-8');
      const existingVars: Record<string, string> = {};

      for (const line of existing.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        existingVars[key] = value;
      }

      // Split vars into protected (always overwrite) and regular
      // For Cloudflare, strip NEXT_PUBLIC_ prefix from protected keys
      const protectedKeys = new Set(
        (options.alwaysOverwriteKeys || []).map(key =>
          key.startsWith('NEXT_PUBLIC_') ? key.replace('NEXT_PUBLIC_', '') : key
        ).concat(
          (options.alwaysOverwriteKeys || []).filter(key => key.startsWith('VITE_'))
            .map(key => key.replace('VITE_', ''))
        )
      );
      const protectedVars: Record<string, string> = {};
      const regularVars: Record<string, string> = {};

      for (const [key, value] of Object.entries(cloudflareVars)) {
        if (protectedKeys.has(key)) {
          protectedVars[key] = value;
        } else {
          regularVars[key] = value;
        }
      }

      // Merge: regular vars respect preserveExisting, protected vars always overwrite
      const mergedRegular = options.preserveExisting
        ? { ...regularVars, ...existingVars }
        : { ...existingVars, ...regularVars };

      // Protected vars always overwrite, applied last
      const merged = { ...mergedRegular, ...protectedVars };

      const lines = Object.entries(merged).map(([key, value]) => `${key}=${value}`);
      writeFileSync(devVarsPath, lines.join('\n') + '\n');
      cloudflareWritten = true;
    } else if (options.createIfMissing) {
      const lines = Object.entries(cloudflareVars).map(([key, value]) => `${key}=${value}`);
      writeFileSync(devVarsPath, lines.join('\n') + '\n');
      cloudflareWritten = true;
    }
  }

  return { nextjs: nextjsWritten, vite: viteWritten, cloudflare: cloudflareWritten };
}

/**
 * Dev server port configuration for URL generation
 */
export interface DevServerPorts {
  nextjs: number;
  vite: number;
  cloudflare: number;
}

/**
 * Workspace info for URL generation
 */
export interface WorkspaceInfo {
  /** Workspace path relative to cwd (e.g., 'apps/web') */
  path: string;
  /** Workspace name (e.g., 'web') */
  name: string;
  /** Detected framework type */
  framework: WorkspaceFramework;
  /** Port configured in package.json dev script (--port flag), or null if not configured */
  configuredPort: number | null;
  /** Port after availability check - use this instead of configuredPort for URL generation */
  resolvedPort?: number;
}

/**
 * Resolve ports for workspaces, checking availability and finding alternatives
 *
 * For each workspace:
 * 1. Try configuredPort (from package.json) if set
 * 2. Fall back to base port from DevServerPorts
 * 3. If port is unavailable, find next available at +10 increments
 *
 * This ensures multiple Claude sessions can run in parallel without port conflicts.
 *
 * @param workspaces - Array of workspace info objects (mutated with resolvedPort)
 * @param basePorts - Base ports for each framework type
 * @returns Promise resolving to the same array with resolvedPort filled in
 *
 * @example
 * ```typescript
 * import { resolveWorkspacePorts } from './env-sync.js';
 *
 * const workspaces = [
 *   { path: 'apps/app', name: 'app', framework: 'nextjs', configuredPort: 3100 },
 *   { path: 'apps/mcp', name: 'mcp', framework: 'cloudflare', configuredPort: 3102 },
 * ];
 *
 * await resolveWorkspacePorts(workspaces, { nextjs: 3000, vite: 5173, cloudflare: 8787 });
 * // If 3100 is in use: workspaces[0].resolvedPort = 3110
 * // If 3102 is in use: workspaces[1].resolvedPort = 3112
 * ```
 */
export async function resolveWorkspacePorts(
  workspaces: WorkspaceInfo[],
  basePorts: DevServerPorts
): Promise<WorkspaceInfo[]> {
  // Track ports we've already claimed in this resolution to avoid duplicates
  const claimedPorts = new Set<number>();

  // Only process workspaces with dev servers
  const appWorkspaces = workspaces.filter(
    (ws) =>
      ws.framework === 'nextjs' || ws.framework === 'vite' || ws.framework === 'cloudflare'
  );

  for (const ws of appWorkspaces) {
    // Determine the preferred port (configured or framework default)
    const preferredPort = ws.configuredPort ?? basePorts[ws.framework as keyof DevServerPorts];

    // Check if preferred port is available and not already claimed
    const available = await isPortAvailable(preferredPort);
    if (available && !claimedPorts.has(preferredPort)) {
      ws.resolvedPort = preferredPort;
      claimedPorts.add(preferredPort);
      continue;
    }

    // Port not available, find next at +10 increments
    const resolvedPort = await findAvailablePortExcluding(preferredPort, claimedPorts, 25);

    if (resolvedPort !== null) {
      ws.resolvedPort = resolvedPort;
      claimedPorts.add(resolvedPort);
    } else {
      // Fallback: use preferred port anyway (will likely fail at runtime)
      ws.resolvedPort = preferredPort;
    }
  }

  return workspaces;
}

/**
 * Find available port at +10 increments, excluding already claimed ports
 */
async function findAvailablePortExcluding(
  basePort: number,
  excludePorts: Set<number>,
  maxSlots: number = 25
): Promise<number | null> {
  for (let slot = 0; slot < maxSlots; slot++) {
    const port = basePort + slot * 10;
    if (excludePorts.has(port)) {
      continue;
    }
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  return null;
}

/**
 * Generate per-app URL environment variables for all workspaces
 *
 * Creates self-reference URLs (NEXT_PUBLIC_APP_URL, APP_URL) and cross-app
 * reference URLs (NEXT_PUBLIC_WEB_URL, NEXT_PUBLIC_MCP_URL, etc.) so apps
 * can communicate with each other during local development.
 *
 * @param workspaces - Array of workspace info objects
 * @param ports - Dev server port configuration
 * @returns Map of workspace path to URL env vars for that workspace
 *
 * @example
 * ```typescript
 * import { generateAppUrls } from './env-sync.js';
 *
 * const urlVars = generateAppUrls(
 *   [
 *     { path: 'apps/app', name: 'app', framework: 'nextjs' },
 *     { path: 'apps/web', name: 'web', framework: 'nextjs' },
 *     { path: 'apps/mcp', name: 'mcp', framework: 'cloudflare' },
 *   ],
 *   { nextjs: 3100, vite: 5173, cloudflare: 3102 }
 * );
 *
 * // Result for apps/app:
 * // {
 * //   NEXT_PUBLIC_APP_URL: 'http://localhost:3100',
 * //   NEXT_PUBLIC_WEB_URL: 'http://localhost:3101',
 * //   NEXT_PUBLIC_MCP_URL: 'http://localhost:3102',
 * // }
 * ```
 */
export function generateAppUrls(
  workspaces: WorkspaceInfo[],
  ports: DevServerPorts
): Map<string, Record<string, string>> {
  const urlsByWorkspace = new Map<string, Record<string, string>>();

  // Filter to only include actual app workspaces with dev servers
  // Exclude npm packages (framework === 'unknown') which don't have dev servers
  // This prevents generating URLs like NEXT_PUBLIC_SUPABASE_URL for packages/supabase
  const appWorkspaces = workspaces.filter(ws =>
    ws.framework === 'nextjs' ||
    ws.framework === 'vite' ||
    ws.framework === 'cloudflare' ||
    ws.framework === 'elysia'
  );

  // First, calculate the actual port for each app workspace
  // Use configuredPort if available, otherwise fall back to base + offset
  const portsByType: Record<WorkspaceFramework, number> = {
    nextjs: ports.nextjs,
    vite: ports.vite,
    cloudflare: ports.cloudflare,
    elysia: ports.nextjs,  // Elysia uses port 3000 like Next.js
    unknown: ports.nextjs,
  };

  const workspacePortMap = new Map<string, number>();
  const usedPortsByType: Record<WorkspaceFramework, number[]> = {
    nextjs: [],
    vite: [],
    cloudflare: [],
    elysia: [],
    unknown: [],
  };

  // Assign ports to each app workspace
  // Priority: resolvedPort (after availability check) > configuredPort > base port + offset
  for (const ws of appWorkspaces) {
    let port: number;

    if (ws.resolvedPort !== undefined) {
      // Use pre-resolved port (already checked for availability)
      port = ws.resolvedPort;
    } else if (ws.configuredPort !== null) {
      // Fallback to configured port (legacy behavior, no availability check)
      port = ws.configuredPort;
    } else {
      // Fall back to base port + offset for workspaces without configured port
      const basePort = portsByType[ws.framework];
      const usedPorts = usedPortsByType[ws.framework];
      const offset = usedPorts.length;
      port = basePort + offset;
    }

    workspacePortMap.set(ws.path, port);
    usedPortsByType[ws.framework].push(port);
  }

  // Generate URL vars for each app workspace
  for (const ws of appWorkspaces) {
    const port = workspacePortMap.get(ws.path)!;
    const url = `http://localhost:${port}`;
    const vars: Record<string, string> = {};

    // Self-reference URL with app-specific naming
    const nameUpper = ws.name.toUpperCase().replace(/-/g, '_');

    if (ws.framework === 'nextjs') {
      // Add both app-specific name and generic APP_URL for compatibility
      vars[`NEXT_PUBLIC_${nameUpper}_URL`] = url;  // e.g., NEXT_PUBLIC_WEB_URL
      vars['NEXT_PUBLIC_APP_URL'] = url;            // Backwards compatibility
      vars[`${nameUpper}_URL`] = url;               // Server-side (WEB_URL)
    } else if (ws.framework === 'vite') {
      vars[`VITE_${nameUpper}_URL`] = url;
      vars['VITE_APP_URL'] = url;
      vars[`${nameUpper}_URL`] = url;
    } else if (ws.framework === 'elysia') {
      vars[`${nameUpper}_URL`] = url;
      vars['APP_URL'] = url;
    } else {
      // Cloudflare workers - unprefixed
      vars[`${nameUpper}_URL`] = url;
      vars['APP_URL'] = url;
    }

    // Cross-app references (URLs to all other apps)
    for (const otherWs of appWorkspaces) {
      if (otherWs.path === ws.path) continue;

      const otherPort = workspacePortMap.get(otherWs.path)!;
      const otherUrl = `http://localhost:${otherPort}`;
      const otherNameUpper = otherWs.name.toUpperCase().replace(/-/g, '_');

      if (ws.framework === 'nextjs') {
        vars[`NEXT_PUBLIC_${otherNameUpper}_URL`] = otherUrl;
        vars[`${otherNameUpper}_URL`] = otherUrl;  // Also add unprefixed for server
      } else if (ws.framework === 'vite') {
        vars[`VITE_${otherNameUpper}_URL`] = otherUrl;
        vars[`${otherNameUpper}_URL`] = otherUrl;
      } else {
        vars[`${otherNameUpper}_URL`] = otherUrl;
      }
    }

    urlsByWorkspace.set(ws.path, vars);
  }

  return urlsByWorkspace;
}

/**
 * Collect environment variables from all sources
 *
 * Gathers environment variables from Supabase CLI (if running) and
 * from all workspace .env.local files (from Vercel pulls).
 *
 * @param cwd - Root directory of the project
 * @param workspaces - Array of workspace paths relative to cwd
 * @param supabaseVars - Optional Supabase variables (from Supabase CLI)
 * @returns Complete environment variable sets
 *
 * @example
 * ```typescript
 * import { collectEnvVars } from './env-sync.js';
 *
 * const vars = await collectEnvVars(
 *   '/path/to/project',
 *   ['apps/web', 'apps/api'],
 *   { SUPABASE_URL: 'http://localhost:54321', ... }
 * );
 * ```
 */
export async function collectEnvVars(
  cwd: string,
  workspaces: string[],
  supabaseVars?: Record<string, string>
): Promise<EnvVarSet> {
  // Collect Supabase vars
  const supabase = supabaseVars || {};

  // Collect and merge Vercel vars from all workspaces
  const vercel = await mergeWorkspaceEnvVars(workspaces, cwd);

  // Separate Next.js prefixed vars
  const nextjs: Record<string, string> = {};
  const cloudflare: Record<string, string> = {};

  for (const [key, value] of Object.entries(vercel)) {
    if (key.startsWith('NEXT_PUBLIC_')) {
      nextjs[key] = value;
      // Also add unprefixed version for Cloudflare
      cloudflare[key.replace('NEXT_PUBLIC_', '')] = value;
    } else {
      cloudflare[key] = value;
    }
  }

  return {
    supabaseVars: supabase,
    vercelVars: vercel,
    nextjsVars: nextjs,
    cloudflareVars: cloudflare,
  };
}
