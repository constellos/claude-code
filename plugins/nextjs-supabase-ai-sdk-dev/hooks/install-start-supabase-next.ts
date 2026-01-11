/**
 * Supabase + Next.js Development Environment Setup Hook
 * SessionStart hook that:
 * 1. Checks/installs Supabase CLI
 * 2. Starts Docker if needed
 * 3. Starts Supabase local server
 * 4. Exports env vars to the correct env file
 * 5. Installs dependencies (skips if node_modules is fresh)
 * 6. Starts Next.js dev server (or Turborepo apps)
 * @module install-start-supabase-next
 */

import type { SessionStartInput, SessionStartHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { detectPackageManager } from '../shared/hooks/utils/package-manager.js';
import { isPortAvailable, findAvailablePort, killProcessOnPort, findAvailablePortAt10Increments } from '../shared/hooks/utils/port.js';
import { getWranglerDevPort } from '../shared/hooks/utils/toml.js';
import { findViteConfigPort } from '../shared/hooks/utils/vite-config.js';
import { distributeEnvVars, mergeWorkspaceEnvVars, validateEnvVars, detectSupabaseUsage, hasSupabaseInMonorepo, generateAppUrls, detectWorkspaceFramework, type DevServerPorts, type WorkspaceInfo } from '../shared/hooks/utils/env-sync.js';
import { detectWorktree, type WorktreeInfo } from '../shared/hooks/utils/worktree.js';
import {
  PORT_INCREMENT,
  calculatePortSet,
  checkSupabasePortUsage,
  findAvailableSlot,
  getSupabaseConfigPath,
  getOriginalProjectId,
  generateWorktreeProjectId,
  buildExcludeFlags,
  type SupabasePortSet,
} from '../shared/hooks/utils/supabase-ports.js';
import {
  createTmpSupabaseDir,
  addToGitignore,
} from '../shared/hooks/utils/supabase-tmp-config.js';
import {
  loadWorktreeSupabaseSession,
  saveWorktreeSupabaseSession,
  updateWorktreeSupabaseSession,
  type WorktreeSupabaseSession,
  type DevServerPortSet,
} from '../shared/hooks/utils/session-state.js';
import { getProcessesOnPorts, formatProcessInfo } from '../shared/hooks/utils/process-info.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, openSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { platform } from 'os';

const execAsync = promisify(exec);

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

type ProjectType = 'turborepo' | 'nextjs' | 'vite' | 'cloudflare' | 'elysia' | 'unknown';

/**
 * Execute a shell command with error handling
 */
async function execCommand(
  command: string,
  options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeout || 300000,
      env: { ...process.env, ...options.env },
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || err.message || '',
    };
  }
}

/**
 * Check if a command is available in PATH
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await execCommand(`which ${command}`);
  return result.success && result.stdout.length > 0;
}

/**
 * Detect if running in remote (cloud) environment
 */
function isRemoteEnvironment(): boolean {
  return process.env.CLAUDE_CODE_ENTRYPOINT === 'remote';
}

/**
 * Get Supabase CLI version
 */
async function getSupabaseVersion(): Promise<string | null> {
  const result = await execCommand('supabase --version');
  if (result.success) {
    const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  }
  return null;
}

/**
 * Install Supabase CLI via official binary installer
 */
async function installSupabaseCLI(): Promise<ExecResult> {
  if (await isCommandAvailable('supabase')) {
    return { success: true, stdout: 'supabase already installed', stderr: '' };
  }

  const result = await execCommand(
    'curl -fsSL https://raw.githubusercontent.com/supabase/cli/main/install.sh | sh',
    { timeout: 120000 }
  );
  if (!result.success) {
    return { success: false, stdout: '', stderr: `Failed to install supabase: ${result.stderr}` };
  }
  return { success: true, stdout: 'supabase installed successfully', stderr: '' };
}

// ==================== Docker Management ====================

/**
 * Check if Docker daemon is running
 */
async function isDockerRunning(): Promise<boolean> {
  const result = await execCommand('docker info', { timeout: 10000 });
  return result.success;
}

/**
 * Attempt to start Docker daemon
 */
async function startDocker(): Promise<boolean> {
  const os = platform();

  if (os === 'darwin') {
    // macOS: Try Docker Desktop, then Rancher Desktop, then OrbStack
    const apps = ['Docker', 'Rancher Desktop', 'OrbStack'];
    for (const app of apps) {
      const result = await execCommand(`open -a "${app}"`, { timeout: 5000 });
      if (result.success) {
        return true;
      }
    }
  } else if (os === 'linux') {
    // Linux: Try systemctl
    const result = await execCommand('sudo systemctl start docker', { timeout: 30000 });
    return result.success;
  }

  return false;
}

/**
 * Wait for Docker to be ready
 */
async function waitForDocker(timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    if (await isDockerRunning()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return false;
}

// ==================== Supabase Management ====================

/**
 * Check if Supabase project is initialized
 */
function isSupabaseInitialized(cwd: string): boolean {
  return existsSync(join(cwd, 'supabase', 'config.toml'));
}

/**
 * Read project_id from supabase/config.toml
 * Uses regex for lightweight parsing (avoids importing TOML parser)
 */
function getSupabaseProjectId(cwd: string): string | null {
  const configPath = join(cwd, 'supabase', 'config.toml');
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * Check if Supabase is already running
 */
async function isSupabaseRunning(cwd: string): Promise<boolean> {
  const result = await execCommand('supabase status', { cwd, timeout: 10000 });
  // If status returns successfully and contains service info, it's running
  return result.success && result.stdout.includes('API URL');
}

/**
 * Export Supabase env vars to .env.local and dev.vars
 * Only saves 3 critical variables with correct prefixes
 * Maps deprecated variable names to modern ones
 *
 * @param supabaseRoot - Directory containing supabase/config.toml (where to run supabase CLI)
 * @param workdir - Optional workdir path (for tmp directory approach)
 * @returns Object with vars, success status, and deprecation warnings
 */
async function exportSupabaseEnvVars(
  supabaseRoot: string,
  workdir?: string
): Promise<{ vars: Record<string, string>; success: boolean; warnings: string[] }> {
  // Get raw env output from supabase root
  // Use --workdir if tmp directory is provided
  const workdirFlag = workdir ? ` --workdir ${workdir}` : '';
  const result = await execCommand(`supabase status -o env${workdirFlag}`, { cwd: supabaseRoot, timeout: 10000 });
  if (!result.success) {
    return { vars: {}, success: false, warnings: [] };
  }

  // Parse only the 3 variables we need from supabase status output
  // Supabase CLI outputs: API_URL, ANON_KEY, PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SECRET_KEY
  const envVars: Record<string, string> = {};
  const warnings: string[] = [];
  let usedLegacyAnon = false;
  let usedLegacyService = false;

  for (const line of result.stdout.split('\n')) {
    // API_URL -> SUPABASE_URL
    const urlMatch = line.match(/^API_URL="?([^"]+)"?$/);
    // PUBLISHABLE_KEY (new) or ANON_KEY (legacy) -> SUPABASE_PUBLISHABLE_KEY
    const publishableMatch = line.match(/^PUBLISHABLE_KEY="?([^"]+)"?$/);
    const anonMatch = line.match(/^ANON_KEY="?([^"]+)"?$/);
    // SECRET_KEY (new) or SERVICE_ROLE_KEY (legacy) -> SUPABASE_SECRET_KEY
    const secretMatch = line.match(/^SECRET_KEY="?([^"]+)"?$/);
    const serviceMatch = line.match(/^SERVICE_ROLE_KEY="?([^"]+)"?$/);

    if (urlMatch) {
      envVars.SUPABASE_URL = urlMatch[1];
    } else if (publishableMatch) {
      envVars.SUPABASE_PUBLISHABLE_KEY = publishableMatch[1];
    } else if (anonMatch && !envVars.SUPABASE_PUBLISHABLE_KEY) {
      // Only use ANON_KEY if PUBLISHABLE_KEY not found
      envVars.SUPABASE_PUBLISHABLE_KEY = anonMatch[1];
      usedLegacyAnon = true;
    } else if (secretMatch) {
      envVars.SUPABASE_SECRET_KEY = secretMatch[1];
    } else if (serviceMatch && !envVars.SUPABASE_SECRET_KEY) {
      // Only use SERVICE_ROLE_KEY if SECRET_KEY not found
      envVars.SUPABASE_SECRET_KEY = serviceMatch[1];
      usedLegacyService = true;
    }
  }

  // Add deprecation warnings for legacy key names
  if (usedLegacyAnon || usedLegacyService) {
    const legacyKeys = [];
    if (usedLegacyAnon) legacyKeys.push('ANON_KEY');
    if (usedLegacyService) legacyKeys.push('SERVICE_ROLE_KEY');
    warnings.push(`⚠️ Deprecated: Using legacy Supabase key names (${legacyKeys.join(', ')})`);
    warnings.push('  Update to: PUBLISHABLE_KEY, SECRET_KEY');
    warnings.push('  Run: supabase upgrade to get modern key names');
  }

  return { vars: envVars, success: true, warnings };
}

/**
 * Distribute environment variables to all workspaces in a turborepo
 * Collects Supabase vars and Vercel vars, then distributes to all workspaces
 * Also generates per-app URL env vars for cross-app communication
 *
 * @param cwd - Root directory of the project
 * @param workspaces - Array of workspace paths relative to cwd
 * @param supabaseVars - Optional Supabase variables (from Supabase CLI)
 * @param devServerPorts - Optional dev server ports for URL generation
 * @returns Array of status messages
 */
async function distributeAllEnvVars(
  cwd: string,
  workspaces: string[],
  supabaseVars?: Record<string, string>,
  devServerPorts?: DevServerPorts
): Promise<string[]> {
  const messages: string[] = [];

  // Collect and merge Vercel vars from all workspaces
  const vercelVars = await mergeWorkspaceEnvVars(workspaces, cwd);

  // Validate critical Supabase vars
  if (supabaseVars && Object.keys(supabaseVars).length > 0) {
    const critical = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'];
    const validation = validateEnvVars({ supabaseVars, vercelVars }, critical);

    if (!validation.valid) {
      messages.push(`⚠️ Missing critical env vars: ${validation.missing.join(', ')}`);
    }
  }

  // Check if any package in the monorepo uses Supabase (for internal package detection)
  const monorepoHasSupabase = hasSupabaseInMonorepo(cwd);

  // Generate per-app URL env vars if ports are provided
  let appUrlsByWorkspace: Map<string, Record<string, string>> | null = null;
  if (devServerPorts) {
    // Build workspace info for URL generation
    // Extract configured ports from package.json dev scripts
    const workspaceInfos: WorkspaceInfo[] = workspaces.map(ws => {
      const wsPath = join(cwd, ws);
      const name = ws.split('/').pop() || ws;
      const framework = detectWorkspaceFramework(wsPath);
      const configuredPort = extractPortFromDevScript(join(wsPath, 'package.json'));
      return { path: ws, name, framework, configuredPort };
    });

    appUrlsByWorkspace = generateAppUrls(workspaceInfos, devServerPorts);
  }

  // Distribute to ALL workspaces
  for (const workspace of workspaces) {
    const workspacePath = join(cwd, workspace);
    // Check if this workspace uses Supabase directly, OR if it's an app that might
    // depend on internal packages that wrap Supabase
    const usesSupabase = detectSupabaseUsage(workspacePath) ||
                         (workspace.startsWith('apps/') && monorepoHasSupabase);

    // Merge app URL vars into vercel vars for this workspace
    const appUrls = appUrlsByWorkspace?.get(workspace) || {};
    const mergedVercelVars = { ...vercelVars, ...appUrls };

    // Only include Supabase vars if workspace actually uses them
    const varsToDistribute = usesSupabase
      ? { supabaseVars: supabaseVars || {}, vercelVars: mergedVercelVars }
      : { supabaseVars: {}, vercelVars: mergedVercelVars };

    // Build alwaysOverwriteKeys list including URL vars
    const alwaysOverwriteKeys = [
      // URL vars should always be updated to reflect current ports
      ...Object.keys(appUrls),
    ];
    if (usesSupabase) {
      alwaysOverwriteKeys.push(
        'NEXT_PUBLIC_SUPABASE_URL',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
        'SUPABASE_SECRET_KEY',
        'VITE_SUPABASE_URL',
        'VITE_SUPABASE_PUBLISHABLE_KEY',
        // Cloudflare dev.vars uses unprefixed keys
        'SUPABASE_URL',
        'SUPABASE_PUBLISHABLE_KEY',
      );
    }

    const result = await distributeEnvVars(
      workspacePath,
      varsToDistribute,
      {
        createIfMissing: true,
        preserveExisting: true,
        alwaysOverwriteKeys,
      }
    );

    if (result.nextjs || result.vite) {
      const hasUrls = Object.keys(appUrls).length > 0;
      const varsWritten = usesSupabase
        ? (hasUrls ? 'Supabase + Vercel + URLs' : 'Supabase + Vercel')
        : (hasUrls ? 'Vercel + URLs' : 'Vercel');
      messages.push(`✓ Environment variables (${varsWritten}) written to ${workspace}/.env.local`);
    }
    if (result.cloudflare) {
      const hasUrls = Object.keys(appUrls).length > 0;
      const varsWritten = usesSupabase
        ? (hasUrls ? 'Supabase + Vercel + URLs' : 'Supabase + Vercel')
        : (hasUrls ? 'Vercel + URLs' : 'Vercel');
      messages.push(`✓ Environment variables (${varsWritten}) written to ${workspace}/dev.vars`);
    }
  }

  return messages;
}

// ==================== Project Type Detection ====================

/**
 * Detect Turborepo workspace directories
 * Reads package.json workspaces field to find app directories
 */
function detectTurborepoWorkspaces(cwd: string): string[] | null {
  const turboJsonPath = join(cwd, 'turbo.json');
  if (!existsSync(turboJsonPath)) {
    return null;
  }

  const rootPackageJson = join(cwd, 'package.json');
  if (!existsSync(rootPackageJson)) {
    return null;
  }

  try {
    const packageData = JSON.parse(readFileSync(rootPackageJson, 'utf-8'));

    // Get workspace patterns (supports npm/yarn/pnpm formats)
    let workspacePatterns: string[] = [];
    if (Array.isArray(packageData.workspaces)) {
      workspacePatterns = packageData.workspaces;
    } else if (packageData.workspaces?.packages) {
      workspacePatterns = packageData.workspaces.packages;
    }

    // Resolve workspace directories
    const workspaceDirs: string[] = [];

    for (const pattern of workspacePatterns) {
      if (pattern.includes('*')) {
        // Handle globs like "apps/*" or "packages/*"
        const baseDir = pattern.replace('/*', '');
        const basePath = join(cwd, baseDir);

        if (existsSync(basePath)) {
          const entries = readdirSync(basePath);
          for (const entry of entries) {
            const entryPath = join(basePath, entry);
            if (statSync(entryPath).isDirectory() && existsSync(join(entryPath, 'package.json'))) {
              workspaceDirs.push(join(baseDir, entry));
            }
          }
        }
      } else {
        // Direct path like "apps/web"
        if (existsSync(join(cwd, pattern, 'package.json'))) {
          workspaceDirs.push(pattern);
        }
      }
    }

    return workspaceDirs.length > 0 ? workspaceDirs : null;
  } catch {
    return null;
  }
}

/**
 * Port information for a workspace
 */
interface WorkspacePortInfo {
  workspace: string;
  projectType: ProjectType;
  configuredPort: number | null;
  defaultPort: number | null;
}

/**
 * Detect ports from all workspace package.json files
 * For Turborepo projects, reads each workspace's dev script to find configured ports
 * For Cloudflare workers, also reads wrangler.toml/jsonc for port configuration
 */
async function detectWorkspacePorts(cwd: string, workspaces: string[]): Promise<WorkspacePortInfo[]> {
  const portInfos: WorkspacePortInfo[] = [];

  for (const workspace of workspaces) {
    const workspacePath = join(cwd, workspace);
    const packageJsonPath = join(workspacePath, 'package.json');

    // Detect project type for this workspace
    const wsProjectType = detectWorkspaceProjectType(workspacePath);

    // Extract configured port from dev script
    let configuredPort = extractPortFromDevScript(packageJsonPath);

    // For Cloudflare workers, also check wrangler.toml if no port in dev script
    if (configuredPort === null && wsProjectType === 'cloudflare') {
      const wranglerTomlPath = join(workspacePath, 'wrangler.toml');
      const wranglerJsoncPath = join(workspacePath, 'wrangler.jsonc');
      configuredPort = await getWranglerDevPort(wranglerTomlPath) ||
                       await getWranglerDevPort(wranglerJsoncPath) ||
                       null;
    }

    // For Vite projects, check vite.config.ts for server.port
    if (configuredPort === null && wsProjectType === 'vite') {
      configuredPort = findViteConfigPort(workspacePath);
    }

    // Get default port for this project type
    const defaultPort = getDefaultPort(wsProjectType);

    portInfos.push({
      workspace,
      projectType: wsProjectType,
      configuredPort,
      defaultPort,
    });
  }

  return portInfos;
}

/**
 * Detect project type for a specific workspace directory
 * Similar to detectProjectType but for individual workspaces
 */
function detectWorkspaceProjectType(workspacePath: string): ProjectType {
  if (
    existsSync(join(workspacePath, 'next.config.js')) ||
    existsSync(join(workspacePath, 'next.config.mjs')) ||
    existsSync(join(workspacePath, 'next.config.ts'))
  ) {
    return 'nextjs';
  }
  if (existsSync(join(workspacePath, 'wrangler.toml')) || existsSync(join(workspacePath, 'wrangler.jsonc'))) {
    return 'cloudflare';
  }
  if (
    existsSync(join(workspacePath, 'vite.config.ts')) ||
    existsSync(join(workspacePath, 'vite.config.js')) ||
    existsSync(join(workspacePath, 'vite.config.mjs'))
  ) {
    return 'vite';
  }

  // Check package.json for elysia dependency
  const packageJsonPath = join(workspacePath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (pkg.dependencies?.elysia || pkg.devDependencies?.elysia) {
        return 'elysia';
      }
    } catch {
      // Ignore parse errors
    }
  }

  return 'unknown';
}

/**
 * Detect project type
 */
function detectProjectType(cwd: string): ProjectType {
  if (existsSync(join(cwd, 'turbo.json'))) {
    return 'turborepo';
  }
  if (
    existsSync(join(cwd, 'next.config.js')) ||
    existsSync(join(cwd, 'next.config.mjs')) ||
    existsSync(join(cwd, 'next.config.ts'))
  ) {
    return 'nextjs';
  }
  if (existsSync(join(cwd, 'wrangler.toml')) || existsSync(join(cwd, 'wrangler.jsonc'))) {
    return 'cloudflare';
  }

  // Check for Vite
  if (
    existsSync(join(cwd, 'vite.config.ts')) ||
    existsSync(join(cwd, 'vite.config.js')) ||
    existsSync(join(cwd, 'vite.config.mjs'))
  ) {
    return 'vite';
  }

  // Check for Elysia (Bun framework)
  if (existsSync(join(cwd, 'bun.toml'))) {
    return 'elysia';
  }

  // Or check package.json for elysia dependency
  const packageJsonPath = join(cwd, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (pkg.dependencies?.elysia || pkg.devDependencies?.elysia) {
        return 'elysia';
      }
    } catch {
      // Ignore parse errors
    }
  }

  return 'unknown';
}

/**
 * Extract port from package.json dev script
 * Looks for patterns like "--port 3002" or "-p 3200"
 */
function extractPortFromDevScript(packageJsonPath: string): number | null {
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const devScript = pkg.scripts?.dev;
    if (!devScript) {
      return null;
    }

    // Match --port XXXX or -p XXXX patterns
    const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/);
    if (portMatch) {
      return parseInt(portMatch[1], 10);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a workspace has a dev script that Turborepo will run
 * Used to avoid double-starting services (port conflicts)
 */
function workspaceHasDevScript(workspacePath: string): boolean {
  const packageJsonPath = join(workspacePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return typeof pkg.scripts?.dev === 'string';
  } catch {
    return false;
  }
}

/**
 * Get the default port for a project type
 * Returns null for unknown project types - never assume port 3000
 */
function getDefaultPort(projectType: ProjectType): number | null {
  switch (projectType) {
    case 'cloudflare':
      return 8787;
    case 'vite':
      return 5173;
    case 'elysia':
      return 3000;
    case 'nextjs':
      return 3000;
    case 'turborepo':
      // Turborepo doesn't have a single port - detect from workspaces
      return null;
    default:
      // Never assume port 3000 for unknown project types
      return null;
  }
}

/**
 * Check if turbo.json has required env vars in globalPassThroughEnv
 * Returns list of missing env vars
 */
function checkTurboEnvPassthrough(cwd: string): string[] {
  const turboJsonPath = join(cwd, 'turbo.json');
  if (!existsSync(turboJsonPath)) {
    return [];
  }

  const requiredVars = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
  ];

  try {
    const turboConfig = JSON.parse(readFileSync(turboJsonPath, 'utf-8'));
    const passThrough = turboConfig.globalPassThroughEnv || [];

    return requiredVars.filter((v) => !passThrough.includes(v));
  } catch {
    return requiredVars; // If can't parse, assume all missing
  }
}

/**
 * Get the dev command for the project type
 */
function getDevCommand(cwd: string, projectType: ProjectType): string | null {
  switch (projectType) {
    case 'turborepo': {
      // Check if turbo.json has a dev task defined
      const turboJsonPath = join(cwd, 'turbo.json');
      if (existsSync(turboJsonPath)) {
        try {
          const turboConfig = JSON.parse(readFileSync(turboJsonPath, 'utf-8'));

          // Check both old (pipeline) and new (tasks) format
          const hasDev = turboConfig.pipeline?.dev || turboConfig.tasks?.dev;

          if (hasDev) {
            return 'npx turbo dev';
          }
        } catch {
          // If parsing fails, fall through to default
        }
      }

      // Fallback: try `npx turbo run dev` (works if workspaces define dev script)
      return 'npx turbo run dev';
    }

    case 'nextjs': {
      const pm = detectPackageManager(cwd);
      const runCmd = pm === 'npm' ? 'npm run' : pm;
      return `${runCmd} dev`;
    }

    case 'cloudflare':
      // Use npx to run wrangler since it may be a local dependency
      return 'npx wrangler dev';

    case 'elysia':
      // Elysia uses Bun
      return 'bun run dev';

    case 'vite': {
      const pm = detectPackageManager(cwd);
      const runCmd = pm === 'npm' ? 'npm run' : pm;
      return `${runCmd} dev`;
    }

    default:
      return null;
  }
}

/**
 * Start dev server in background with comprehensive logging
 * Uses shell execution to properly handle commands like "npx turbo dev"
 */
function startDevServerBackground(
  cwd: string,
  command: string,
  logger: ReturnType<typeof createDebugLogger>,
  options?: {
    expectedPort?: number;
    envVars?: Record<string, string>;
  }
): { pid: number; logs: { stdout: string; stderr: string }; actualPort?: number } | null {
  try {
    // Ensure .claude/logs directory exists
    const logDir = join(cwd, '.claude', 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Create log files for stdout/stderr
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stdoutPath = join(logDir, `dev-server-stdout-${timestamp}.log`);
    const stderrPath = join(logDir, `dev-server-stderr-${timestamp}.log`);

    const stdoutFd = openSync(stdoutPath, 'a');
    const stderrFd = openSync(stderrPath, 'a');

    // Use sh -c to properly execute the full command string
    // This fixes issues with commands like "npx turbo dev" where simple splitting fails
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: { ...process.env, ...options?.envVars },
    });

    // Log spawn errors
    child.on('error', (err) => {
      logger.logError(new Error(`Dev server spawn failed: ${err.message}`));
    });

    // Log early exits (within 10 seconds = crash)
    const spawnTime = Date.now();
    child.on('exit', (code, signal) => {
      const runtime = Date.now() - spawnTime;
      if (runtime < 10000 && code !== 0) {
        logger.logError(
          new Error(`Dev server exited early (${runtime}ms) with code ${code}, signal ${signal}`)
        );
      }
    });

    child.unref();

    return {
      pid: child.pid || 0,
      logs: {
        stdout: stdoutPath,
        stderr: stderrPath,
      },
      actualPort: options?.expectedPort,
    };
  } catch (error) {
    logger.logError(error as Error);
    return null;
  }
}

/**
 * Check if dev server is responding to HTTP requests
 */
async function checkServerHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 1000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await execCommand(
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}`,
        { timeout: 2000 }
      );

      // Accept 2xx, 3xx, 404, or 405 (Next.js returns 404 on root before app is ready)
      if (result.success) {
        const statusCode = parseInt(result.stdout);
        if (statusCode >= 200 && statusCode < 600) {
          return true;
        }
      }
    } catch {
      // Ignore errors, server might not be ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

/**
 * Health check result for a workspace
 */
interface HealthCheckResult {
  port: number;
  workspace: string;
  healthy: boolean;
}

/**
 * Check health of multiple workspace servers in parallel
 * Uses Promise.allSettled for concurrent health checks
 */
async function checkMultipleServerHealth(
  ports: WorkspacePortInfo[]
): Promise<HealthCheckResult[]> {
  const healthPromises = ports.map(async (portInfo): Promise<HealthCheckResult> => {
    const port = portInfo.configuredPort || portInfo.defaultPort;
    if (!port) {
      return {
        port: 0,
        workspace: portInfo.workspace,
        healthy: false,
      };
    }

    const healthy = await checkServerHealth(port);
    return {
      port,
      workspace: portInfo.workspace,
      healthy,
    };
  });

  const results = await Promise.allSettled(healthPromises);
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // On rejection, mark as unhealthy
    const portInfo = ports[index];
    return {
      port: portInfo.configuredPort || portInfo.defaultPort || 0,
      workspace: portInfo.workspace,
      healthy: false,
    };
  });
}

/**
 * Information about a shared Supabase instance
 */
interface SupabaseInstanceInfo {
  running: boolean;
  sharedSession: boolean;
  projectId: string | null;
}

/**
 * Detect if Supabase is already running (possibly from another session)
 * Parses supabase status output to extract instance information
 */
async function detectSharedSupabase(cwd: string): Promise<SupabaseInstanceInfo> {
  const result = await execCommand('supabase status', { cwd, timeout: 10000 });

  if (!result.success || !result.stdout.includes('API URL')) {
    return {
      running: false,
      sharedSession: false,
      projectId: null,
    };
  }

  // Extract project ID from config
  const projectId = getSupabaseProjectId(cwd);

  // Check if this session started Supabase by looking for our marker
  // If no marker exists but Supabase is running, it's a shared instance
  const markerPath = join(cwd, '.claude', 'logs', 'supabase-session.json');
  const sharedSession = !existsSync(markerPath);

  return {
    running: true,
    sharedSession,
    projectId,
  };
}

// ==================== Worktree Instance Management ====================

/**
 * Calculate dev server ports for a given slot
 */
function calculateDevServerPorts(slot: number): DevServerPortSet {
  const offset = slot * PORT_INCREMENT;
  return {
    nextjs: 3000 + offset,
    vite: 5173 + offset,
    cloudflare: 8787 + offset,
  };
}

/**
 * Find available dev server ports by scanning at +10 increments
 * Checks actual port availability instead of using slot-based offsets
 */
async function findAvailableDevServerPorts(): Promise<DevServerPortSet> {
  const [nextjsPort, vitePort, cloudflarePort] = await Promise.all([
    findAvailablePortAt10Increments(3000, 25),
    findAvailablePortAt10Increments(5173, 25),
    findAvailablePortAt10Increments(8787, 25),
  ]);

  return {
    nextjs: nextjsPort ?? 3000,
    vite: vitePort ?? 5173,
    cloudflare: cloudflarePort ?? 8787,
  };
}

/**
 * Determine the Supabase instance configuration for this session
 * Handles worktree detection, port allocation, and instance reuse
 */
async function determineSupabaseInstance(
  cwd: string,
  messages: string[]
): Promise<{
  slot: number;
  supabasePorts: SupabasePortSet;
  devServerPorts: DevServerPortSet;
  worktreeInfo: WorktreeInfo;
  needsNewInstance: boolean;
  existingSession: WorktreeSupabaseSession | null;
}> {
  // Detect if we're in a worktree
  const worktreeInfo = detectWorktree(cwd);

  if (worktreeInfo.isWorktree) {
    messages.push(`ℹ️  Worktree detected: ${worktreeInfo.worktreeName}`);
  }

  // Check for existing worktree session
  const existingSession = await loadWorktreeSupabaseSession(cwd, worktreeInfo.worktreeId);

  // Only reuse session if it's from the SAME Claude session (same session_id)
  // This prevents port conflicts when multiple sessions run in the same worktree
  if (existingSession && existingSession.running && existingSession.sessionId) {
    // Check if the containers are actually running before reusing
    try {
      const result = await execAsync(
        `docker ps -q --filter "name=supabase_.*_${existingSession.worktreeProjectId}"`,
        { timeout: 5000 }
      );
      if (result.stdout?.trim()) {
        // Containers exist - reuse this session
        messages.push(`✓ Found existing session (slot ${existingSession.slot})`);
        return {
          slot: existingSession.slot,
          supabasePorts: existingSession.supabasePorts,
          devServerPorts: existingSession.devServerPorts,
          worktreeInfo,
          needsNewInstance: false,
          existingSession,
        };
      }
      // Session file exists but containers are gone - proceed to allocate new
      messages.push(`ℹ️  Previous session containers not running, allocating new instance`);
    } catch {
      // Docker check failed, try to reuse session anyway
      messages.push(`✓ Found existing session (slot ${existingSession.slot})`);
      return {
        slot: existingSession.slot,
        supabasePorts: existingSession.supabasePorts,
        devServerPorts: existingSession.devServerPorts,
        worktreeInfo,
        needsNewInstance: false,
        existingSession,
      };
    }
  }

  // Check port usage on default ports
  const defaultUsage = await checkSupabasePortUsage();

  if (defaultUsage.allRunning) {
    // All default ports in use - need new instance
    // Use availability-based allocation: find next available container name AND ports
    messages.push('ℹ️  Default Supabase ports in use, allocating new instance...');

    // Show what's using the ports (best effort)
    const processInfos = await getProcessesOnPorts(defaultUsage.runningPorts.slice(0, 3));
    for (const info of processInfos) {
      if (info.found) {
        messages.push(`  Port ${info.port}: ${formatProcessInfo(info)}`);
      }
    }

    // Get base project ID for container name check
    const configPath = getSupabaseConfigPath(cwd);
    const baseProjectId = getOriginalProjectId(configPath, worktreeInfo.worktreeId) || 'supabase';

    // Find next available container name based on what's actually running
    const { slot: containerSlot } = await findAvailableContainerName(baseProjectId);

    // Also verify ports are available for this slot
    let slot = containerSlot;
    if (slot > 0) {
      const slotUsage = await checkSupabasePortUsage(calculatePortSet(slot));
      if (slotUsage.allRunning || slotUsage.someRunning) {
        // Container name available but ports aren't - find next slot with both
        const nextSlot = await findAvailableSlot();
        if (nextSlot !== null) {
          slot = nextSlot;
        }
      }
    }

    if (slot === 0 && defaultUsage.allRunning) {
      // Slot 0 is taken and no container name found - find by port availability
      const nextSlot = await findAvailableSlot();
      if (nextSlot !== null) {
        slot = nextSlot;
      } else {
        messages.push('⚠️ No available slots (all in use)');
        return {
          slot: 0,
          supabasePorts: calculatePortSet(0),
          devServerPorts: calculateDevServerPorts(0),
          worktreeInfo,
          needsNewInstance: false,
          existingSession: null,
        };
      }
    }

    messages.push(`  Allocated slot ${slot}`);
    return {
      slot,
      supabasePorts: calculatePortSet(slot),
      devServerPorts: calculateDevServerPorts(slot),
      worktreeInfo,
      needsNewInstance: true,
      existingSession: null,
    };
  } else if (defaultUsage.someRunning) {
    // Partial - stale processes, clean up
    messages.push('⚠️ Stale Supabase processes detected, cleaning up...');
    for (const port of defaultUsage.runningPorts) {
      const killed = await killProcessOnPort(port);
      if (killed) {
        messages.push(`  ✓ Freed port ${port}`);
      }
    }
    // Start fresh on default ports
    return {
      slot: 0,
      supabasePorts: calculatePortSet(0),
      devServerPorts: calculateDevServerPorts(0),
      worktreeInfo,
      needsNewInstance: true,
      existingSession: null,
    };
  }

  // Nothing running - start on default ports (slot 0)
  return {
    slot: 0,
    supabasePorts: calculatePortSet(0),
    devServerPorts: calculateDevServerPorts(0),
    worktreeInfo,
    needsNewInstance: true,
    existingSession: null,
  };
}

/**
 * Clean up orphaned Supabase sessions
 * Finds sessions marked as running but whose worktree no longer exists,
 * stops their containers, and marks them as stopped.
 *
 * IMPORTANT: This function scans ALL worktrees (not just current) to avoid
 * killing containers from other active sessions. A different session ID is
 * NOT a reason to kill - multi-session support requires multiple sessions
 * to coexist.
 *
 * Only truly orphaned containers are cleaned up:
 * - Session file exists but worktree path no longer exists
 * - Running containers with no matching session file anywhere
 */
async function cleanupOrphanedSessions(
  cwd: string,
  messages: string[],
  _currentSessionId: string
): Promise<void> {
  let orphansFound = 0;

  // Build a set of valid running project IDs from ALL worktree session files
  // This is critical for multi-session support - we must not kill containers
  // from other active sessions running in sibling worktrees
  const validRunningProjectIds = new Set<string>();
  const sessionProjectIds = new Map<string, string>(); // projectId -> sessionPath

  // Find all worktrees to scan for session files
  // Structure: /home/ben/.claude-worktrees/<repo-name>/<worktree-name>/.claude/logs/
  const worktreesToScan: string[] = [];

  // Always include current worktree
  worktreesToScan.push(cwd);

  // Try to find sibling worktrees (same repo, different worktree names)
  try {
    // If we're in a worktree, go up to find siblings
    // e.g., /home/ben/.claude-worktrees/nodes-md/claude-foo/ -> /home/ben/.claude-worktrees/nodes-md/
    const parentDir = dirname(cwd);
    if (parentDir.includes('.claude-worktrees')) {
      const siblings = readdirSync(parentDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== basename(cwd))
        .map((d) => join(parentDir, d.name));
      worktreesToScan.push(...siblings);
    }
  } catch {
    // Couldn't enumerate siblings, just use current worktree
  }

  // Phase 1: Scan all worktrees for session files
  for (const worktreePath of worktreesToScan) {
    const logsDir = join(worktreePath, '.claude', 'logs');
    if (!existsSync(logsDir)) {
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(logsDir).filter((f) => f.startsWith('supabase-session-'));
    } catch {
      files = [];
    }

    for (const file of files) {
      try {
        const sessionPath = join(logsDir, file);
        const content = readFileSync(sessionPath, 'utf-8');
        const session = JSON.parse(content) as WorktreeSupabaseSession;

        if (session.worktreeProjectId) {
          sessionProjectIds.set(session.worktreeProjectId, sessionPath);
        }

        // Only clean up if worktree path no longer exists (truly orphaned)
        // DO NOT clean up just because it's a different session ID!
        const isOrphanedPath = session.worktreePath && !existsSync(session.worktreePath);

        if (session.running && isOrphanedPath) {
          orphansFound++;
          messages.push(`🧹 Cleaning orphaned path: ${session.worktreeProjectId || session.worktreeId}`);

          // Try to stop containers with this project ID
          if (session.worktreeProjectId) {
            try {
              await execAsync(
                `docker ps -q --filter "name=supabase_.*_${session.worktreeProjectId}" | xargs -r docker stop`,
                { timeout: 30000 }
              );
              await execAsync(
                `docker ps -aq --filter "name=supabase_.*_${session.worktreeProjectId}" | xargs -r docker rm`,
                { timeout: 30000 }
              );
            } catch {
              // Containers may already be stopped or removed
            }
          }

          // Mark session as stopped
          session.running = false;
          const { writeFileSync } = await import('fs');
          writeFileSync(sessionPath, JSON.stringify(session, null, 2));
          messages.push(`  ✓ Marked session as stopped`);
        } else if (session.running) {
          // This is a valid running session (from any Claude session)
          // Add to valid set so we don't kill it in phase 2
          if (session.worktreeProjectId) {
            validRunningProjectIds.add(session.worktreeProjectId);
          }
        }
      } catch {
        // Skip malformed session files
      }
    }
  }

  // Phase 2: Detect running containers without matching session files ANYWHERE
  // This catches containers orphaned due to session file corruption/deletion
  try {
    const result = await execAsync('docker ps --format "{{.Names}}" --filter "name=supabase_"', {
      timeout: 10000,
    });

    if (result.stdout) {
      // Extract unique project IDs from container names
      // Container naming: supabase_{service}_{projectId}
      const containerNames = result.stdout.split('\n').filter(Boolean);
      const runningProjectIds = new Set<string>();

      for (const name of containerNames) {
        // Extract project ID from container name (last segment after underscore)
        const parts = name.split('_');
        if (parts.length >= 3) {
          const projectId = parts.slice(2).join('_');
          runningProjectIds.add(projectId);
        }
      }

      // Find containers without matching valid session files
      for (const projectId of runningProjectIds) {
        // Skip if it's a valid running session (from ANY worktree)
        if (validRunningProjectIds.has(projectId)) {
          continue;
        }

        // Skip if there's a session file marked as running
        const sessionPath = sessionProjectIds.get(projectId);
        if (sessionPath) {
          try {
            const content = readFileSync(sessionPath, 'utf-8');
            const session = JSON.parse(content) as WorktreeSupabaseSession;
            if (session.running) {
              continue; // Session exists and is marked running, don't kill
            }
          } catch {
            // Session file is corrupted, treat as orphan
          }
        }

        // This is an orphaned container without a valid session file
        orphansFound++;
        messages.push(`🧹 Cleaning orphaned container: ${projectId}`);

        try {
          await execAsync(`docker ps -q --filter "name=supabase_.*_${projectId}" | xargs -r docker stop`, {
            timeout: 30000,
          });
          await execAsync(`docker ps -aq --filter "name=supabase_.*_${projectId}" | xargs -r docker rm`, {
            timeout: 30000,
          });
          messages.push(`  ✓ Stopped orphaned containers`);
        } catch {
          messages.push(`  ⚠️ Failed to stop some containers`);
        }
      }
    }
  } catch {
    // Docker not available or failed - skip container scanning
  }

  if (orphansFound > 0) {
    messages.push(`✓ Cleaned up ${orphansFound} orphaned session(s)/container(s)`);
  }
}

/**
 * Find the next available Supabase container name based on what's actually running in Docker
 * Returns base name if available, otherwise base-1, base-2, etc.
 */
async function findAvailableContainerName(baseProjectId: string): Promise<{ name: string; slot: number }> {
  try {
    const result = await execAsync('docker ps --format "{{.Names}}" --filter "name=supabase_"', {
      timeout: 10000,
    });

    const runningContainers = result.stdout?.split('\n').filter(Boolean) || [];

    // Extract all running project IDs
    const runningProjectIds = new Set<string>();
    for (const name of runningContainers) {
      const parts = name.split('_');
      if (parts.length >= 3) {
        const projectId = parts.slice(2).join('_');
        runningProjectIds.add(projectId);
      }
    }

    // Try base name first (e.g., "constellos")
    if (!runningProjectIds.has(baseProjectId)) {
      return { name: baseProjectId, slot: 0 };
    }

    // Find next available suffix: constellos-1, constellos-2, etc.
    for (let i = 1; i < 10; i++) {
      const candidate = `${baseProjectId}-${i}`;
      if (!runningProjectIds.has(candidate)) {
        return { name: candidate, slot: i };
      }
    }

    // All slots taken, fall back to slot 0 (will likely fail but let user know)
    return { name: baseProjectId, slot: 0 };
  } catch {
    // Docker not available - assume base is available
    return { name: baseProjectId, slot: 0 };
  }
}

/**
 * Start Supabase with custom ports using /tmp/ directory
 * Creates a temporary config directory with symlinks, starts Supabase, and saves session state.
 * Does NOT modify the original config.toml.
 */
async function startWorktreeSupabase(
  cwd: string,
  slot: number,
  supabasePorts: SupabasePortSet,
  devServerPorts: DevServerPortSet,
  worktreeInfo: WorktreeInfo,
  messages: string[],
  sessionId: string
): Promise<{ success: boolean; tmpConfigDir?: string; projectId?: string }> {
  const configPath = getSupabaseConfigPath(cwd);
  const originalSupabaseDir = join(cwd, 'supabase');

  // Read original project_id from config.toml
  const originalProjectId = getOriginalProjectId(configPath, worktreeInfo.worktreeId);
  if (!originalProjectId) {
    messages.push('⚠️ Could not read project_id from config.toml');
    return { success: false };
  }

  // Generate worktree-specific project_id
  const worktreeProjectId = generateWorktreeProjectId(originalProjectId, slot);

  // Create temporary Supabase directory with symlinks
  let tmpConfig;
  try {
    tmpConfig = createTmpSupabaseDir(
      worktreeInfo.worktreeId,
      originalSupabaseDir,
      worktreeProjectId,
      supabasePorts
    );
    messages.push(`✓ Created temporary Supabase config at ${tmpConfig.tmpDir}`);
    messages.push(`  Project ID: ${originalProjectId} → ${worktreeProjectId}`);
    messages.push(`  Symlinks: seed.sql, migrations/, functions/, templates/`);
  } catch (error) {
    messages.push(`⚠️ Failed to create tmp config directory: ${error}`);
    return { success: false };
  }

  // Add to .gitignore if needed
  const addedToGitignore = addToGitignore(cwd);
  if (addedToGitignore) {
    messages.push('✓ Added /tmp/supabase-* to .gitignore');
  }

  // Build exclude flags for disabled services (using tmp config)
  const excludeFlags = buildExcludeFlags(tmpConfig.configPath);
  const startCommand = `supabase start --workdir ${tmpConfig.tmpDir}${excludeFlags}`;

  if (excludeFlags) {
    const excluded = excludeFlags.replace(' --exclude ', '').split(',');
    messages.push(`⚡ Optimized: Skipping services: ${excluded.join(', ')}`);
  }

  // Start Supabase using the tmp directory
  messages.push(`Starting Supabase: ${startCommand}`);
  const startResult = await execCommand(startCommand, { cwd, timeout: 300000 });

  if (!startResult.success) {
    messages.push(`⚠️ Failed to start Supabase: ${startResult.stderr}`);
    return { success: false, tmpConfigDir: tmpConfig.tmpDir };
  }

  messages.push('✓ Supabase started with isolated containers');
  messages.push(`  Project ID: ${worktreeProjectId}`);
  messages.push(`  Containers: supabase_*_${worktreeProjectId}`);
  messages.push(`  API: http://localhost:${supabasePorts.api}`);
  messages.push(`  Studio: http://localhost:${supabasePorts.studio}`);
  messages.push(`  Inbucket (email): http://localhost:${supabasePorts.inbucket}`);

  // Save exact container IDs for scoped cleanup in SessionEnd hook
  // This prevents accidentally deleting containers from other sessions
  try {
    const containersResult = await execAsync(
      `docker ps -q --filter "label=com.supabase.cli.project=${worktreeProjectId}"`,
      { timeout: 10000 }
    );
    const containerIds = containersResult.stdout?.split('\n').filter(Boolean) || [];

    if (containerIds.length > 0) {
      const dockerConfigPath = join(cwd, '.claude', 'logs', 'docker-containers.json');
      const dockerConfig = {
        projectId: worktreeProjectId,
        containerIds,
        volumeNames: [
          `supabase_db_${worktreeProjectId}`,
          `supabase_storage_${worktreeProjectId}`,
        ],
        tmpConfigDir: tmpConfig.tmpDir,
        savedAt: new Date().toISOString(),
      };
      writeFileSync(dockerConfigPath, JSON.stringify(dockerConfig, null, 2));
      messages.push(`  ✓ Saved ${containerIds.length} container IDs for cleanup`);
    }
  } catch {
    // Best effort - don't fail if we can't save container IDs
    messages.push('  ⚠️ Could not save container IDs (cleanup may be less precise)');
  }

  // Save session state with project IDs and tmp directory
  const session: WorktreeSupabaseSession = {
    worktreeId: worktreeInfo.worktreeId,
    worktreePath: worktreeInfo.worktreePath,
    slot,
    supabasePorts,
    devServerPorts,
    startedAt: new Date().toISOString(),
    configBackupPath: '', // No longer using backups - using tmp dir instead
    running: true,
    originalProjectId,
    worktreeProjectId,
    sessionId,
    tmpConfigDir: tmpConfig.tmpDir,
    originalSupabaseDir,
  };

  await saveWorktreeSupabaseSession(cwd, session);

  return { success: true, tmpConfigDir: tmpConfig.tmpDir, projectId: worktreeProjectId };
}

// ==================== Dependency Installation ====================

type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn';

/**
 * Get install command for package manager
 */
function getInstallCommand(pm: PackageManager): string {
  const commands: Record<PackageManager, string> = {
    bun: 'bun install',
    npm: 'npm install',
    pnpm: 'pnpm install',
    yarn: 'yarn install',
  };
  return commands[pm];
}

/**
 * Check if we should skip install (node_modules exists and is recent)
 */
function shouldSkipInstall(cwd: string): boolean {
  // Skip if SKIP_INSTALL env var is set
  if (process.env.SKIP_INSTALL === '1') {
    return true;
  }

  // Check if package.json exists (if not, not a Node.js project)
  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return true;
  }

  // Check if node_modules exists
  const nodeModulesPath = join(cwd, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    return false;
  }

  // Check if node_modules is recent (within 1 hour)
  try {
    const stats = statSync(nodeModulesPath);
    const ageMs = Date.now() - stats.mtimeMs;
    const oneHourMs = 60 * 60 * 1000;
    return ageMs < oneHourMs;
  } catch {
    return false;
  }
}

/**
 * Install dependencies with package manager
 * @returns Success status and install time in seconds (or null if skipped)
 */
async function installDependencies(
  cwd: string,
  _logger: ReturnType<typeof createDebugLogger>
): Promise<{ success: boolean; skipped: boolean; timeSeconds?: number; error?: string }> {
  // Skip if conditions met
  if (shouldSkipInstall(cwd)) {
    return { success: true, skipped: true };
  }

  const packageManager = detectPackageManager(cwd) as PackageManager;
  const installCmd = getInstallCommand(packageManager);

  const startTime = Date.now();
  try {
    await execAsync(installCmd, {
      cwd,
      timeout: 120000, // 2 minutes
    });
    const timeSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    return { success: true, skipped: false, timeSeconds: parseFloat(timeSeconds) };
  } catch (error: unknown) {
    const err = error as { message?: string };
    const errorMsg = err.message || 'Unknown error';
    return { success: false, skipped: false, error: errorMsg };
  }
}

// ==================== Main Handler ====================

/**
 * SessionStart hook handler
 */
async function handler(input: SessionStartInput): Promise<SessionStartHookOutput> {
  const logger = createDebugLogger(input.cwd, 'install-start-supabase-next', true);
  const isRemote = isRemoteEnvironment();
  const messages: string[] = [];

  try {
    await logger.logInput({
      source: input.source,
      session_id: input.session_id,
      is_remote: isRemote,
    });

    // ========== Step 1: Check/Install Supabase CLI ==========
    const supabaseAvailable = await isCommandAvailable('supabase');

    if (!supabaseAvailable) {
      if (isRemote) {
        messages.push('Installing Supabase CLI...');
        const installResult = await installSupabaseCLI();
        messages.push(installResult.success ? '✓ Supabase CLI installed' : `⚠️ ${installResult.stderr}`);
      } else {
        messages.push('⚠️ Supabase CLI not installed');
        messages.push('  Install: npm install -g supabase');

        // Log output before early return
        await logger.logOutput({
          success: false,
          is_remote: isRemote,
          message: messages.join('\n'),
          reason: 'cli_not_installed',
        });

        // Return early - can't proceed without CLI
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: messages.join('\n'),
          },
        };
      }
    } else {
      const version = await getSupabaseVersion();
      messages.push(`✓ Supabase CLI v${version || 'unknown'}`);
    }

    // ========== Step 2: Check if Supabase is initialized ==========
    if (!isSupabaseInitialized(input.cwd)) {
      messages.push('');
      messages.push('ℹ️ Supabase not initialized in this project');
      messages.push('  Run: supabase init');

      // Log output before early return
      await logger.logOutput({
        success: false,
        is_remote: isRemote,
        message: messages.join('\n'),
        reason: 'not_initialized',
      });

      // Return early - can't proceed without initialization
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: messages.join('\n'),
        },
      };
    }

    // Read project_id from config.toml
    const projectId = getSupabaseProjectId(input.cwd);
    if (projectId) {
      messages.push(`✓ Supabase project: ${projectId}`);
    }

    // Show multi-instance warning if Supabase is running
    if (projectId && await isSupabaseRunning(input.cwd)) {
      messages.push(`ℹ️  Using Supabase instance: ${projectId}`);
    }

    // ========== Step 3: Check/Start Docker ==========
    let dockerRunning = await isDockerRunning();

    if (!dockerRunning) {
      messages.push('');
      messages.push('Docker not running, attempting to start...');
      const started = await startDocker();

      if (started) {
        messages.push('Waiting for Docker to be ready...');
        dockerRunning = await waitForDocker(30000);
      }

      if (!dockerRunning) {
        messages.push('⚠️ Could not start Docker');
        messages.push('  Please start Docker Desktop manually');
        // Continue but note that Supabase won't start
      } else {
        messages.push('✓ Docker started');
      }
    } else {
      messages.push('✓ Docker running');
    }

    // ========== Step 3.5: Clean up orphaned sessions ==========
    // Find sessions marked as running but whose worktree no longer exists
    // or sessions from a different Claude session
    await cleanupOrphanedSessions(input.cwd, messages, input.session_id);

    // ========== Step 4: Check/Start Supabase (Worktree-Aware) ==========
    // Determine instance configuration based on worktree status and port usage
    const instanceConfig = await determineSupabaseInstance(input.cwd, messages);
    let supabaseRunning = false;
    // Track worktree slot for dev server port allocation (slot 0 = default, slot N = +N*10 offset)
    const worktreeSlot = instanceConfig.slot;
    // Track tmp config directory for supabase status commands
    let supabaseTmpDir: string | undefined;

    if (dockerRunning) {
      if (instanceConfig.needsNewInstance) {
        // Start new Supabase instance (possibly with custom ports for worktree)
        messages.push('');
        const startResult = await startWorktreeSupabase(
          input.cwd,
          instanceConfig.slot,
          instanceConfig.supabasePorts,
          instanceConfig.devServerPorts,
          instanceConfig.worktreeInfo,
          messages,
          input.session_id
        );
        supabaseRunning = startResult.success;
        supabaseTmpDir = startResult.tmpConfigDir;
      } else if (instanceConfig.existingSession) {
        // Use existing worktree session
        messages.push('✓ Supabase already running (worktree session)');
        messages.push(`  API: http://localhost:${instanceConfig.supabasePorts.api}`);
        messages.push(`  Studio: http://localhost:${instanceConfig.supabasePorts.studio}`);
        supabaseRunning = true;
        supabaseTmpDir = instanceConfig.existingSession.tmpConfigDir;
      } else {
        // Check if default Supabase is running
        const supabaseInfo = await detectSharedSupabase(input.cwd);
        supabaseRunning = supabaseInfo.running;
        if (supabaseRunning) {
          if (supabaseInfo.sharedSession) {
            messages.push('ℹ️ Using shared Supabase instance from another session');
          } else {
            messages.push('✓ Supabase already running');
          }
        }
      }
    }

    // ========== Step 5: Export Environment Variables ==========
    const projectType = detectProjectType(input.cwd);

    // Pre-calculate dev server ports for URL generation
    // This ensures env vars include correct URLs before servers start
    const preCalculatedPorts = await findAvailableDevServerPorts();

    if (projectType === 'turborepo') {
      const workspaces = detectTurborepoWorkspaces(input.cwd);
      if (workspaces && workspaces.length > 0) {
        // Collect Supabase vars if running
        let supabaseVars: Record<string, string> | undefined;
        if (supabaseRunning) {
          const result = await exportSupabaseEnvVars(input.cwd, supabaseTmpDir);
          if (result.success) {
            supabaseVars = result.vars;
            // Show deprecation warnings if any
            if (result.warnings.length > 0) {
              messages.push(...result.warnings);
            }
          }
        }

        // Distribute all env vars (Supabase + Vercel + App URLs) to all workspaces
        const envMessages = await distributeAllEnvVars(input.cwd, workspaces, supabaseVars, preCalculatedPorts);
        messages.push(...envMessages);
      }
    } else if (supabaseRunning) {
      // For single projects: export Supabase vars to root
      const result = await exportSupabaseEnvVars(input.cwd, supabaseTmpDir);
      if (result.success && Object.keys(result.vars).length > 0) {
        // Show deprecation warnings if any
        if (result.warnings.length > 0) {
          messages.push(...result.warnings);
        }

        // Use distributeEnvVars for consistent handling
        const distResult = await distributeEnvVars(
          input.cwd,
          { supabaseVars: result.vars, vercelVars: {} },
          {
            createIfMissing: true,
            preserveExisting: true,
            alwaysOverwriteKeys: [
              'NEXT_PUBLIC_SUPABASE_URL',
              'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
              'SUPABASE_SECRET_KEY',
              'VITE_SUPABASE_URL',
              'VITE_SUPABASE_PUBLISHABLE_KEY',
            ]
          }
        );

        if (distResult.nextjs) {
          messages.push('✓ Environment variables written to .env.local');
        }
        if (distResult.vite) {
          messages.push('✓ Environment variables written to .env.local (Vite)');
        }
        if (distResult.cloudflare) {
          messages.push('✓ Environment variables written to dev.vars');
        }
      }
    }

    // ========== Step 5.5: Install Dependencies ==========
    messages.push('');
    const installResult = await installDependencies(input.cwd, logger);

    if (installResult.skipped) {
      messages.push('✓ Dependencies already installed (skipped)');
    } else if (installResult.success && installResult.timeSeconds !== undefined) {
      const packageManager = detectPackageManager(input.cwd);
      messages.push(`✓ Dependencies installed (${packageManager} install - ${installResult.timeSeconds}s)`);
    } else if (!installResult.success) {
      messages.push(`⚠️ Dependency installation failed: ${installResult.error}`);
      messages.push('  Continuing anyway - you may need to run install manually');
    }

    // ========== Step 6: Detect Project Type and Start Dev Server ==========
    const devCommand = getDevCommand(input.cwd, projectType);

    if (devCommand) {
      messages.push('');
      messages.push(`Detected project type: ${projectType}`);

      // Show workspace info for Turborepo
      if (projectType === 'turborepo') {
        const workspaces = detectTurborepoWorkspaces(input.cwd);
        if (workspaces && workspaces.length > 0) {
          // Detect ports for all workspaces
          const workspacePorts = await detectWorkspacePorts(input.cwd, workspaces);

          // Apply worktree port offsets if in a non-default slot
          if (worktreeSlot > 0) {
            messages.push(`  Using worktree slot ${worktreeSlot} (ports offset by ${worktreeSlot * PORT_INCREMENT})`);
            for (const wp of workspacePorts) {
              if (wp.configuredPort) {
                wp.configuredPort += worktreeSlot * PORT_INCREMENT;
              }
              if (wp.defaultPort) {
                wp.defaultPort += worktreeSlot * PORT_INCREMENT;
              }
            }
          }

          const portSummary = workspacePorts
            .map(p => `${p.workspace}:${p.configuredPort || p.defaultPort || '?'}`)
            .join(', ');
          messages.push(`  Workspaces: ${portSummary}`);

          // Check if pre-calculated ports are available (these are the ports we'll actually use)
          // Only kill stale processes on the ACTUAL ports we're going to use, not configured ports
          // This prevents killing dev servers from other sessions that are using different ports
          const actualPortsToUse = [
            preCalculatedPorts.nextjs,
            preCalculatedPorts.vite,
            preCalculatedPorts.cloudflare,
          ].filter((p): p is number => typeof p === 'number' && p > 0);

          for (const port of actualPortsToUse) {
            const available = await isPortAvailable(port);
            if (!available) {
              messages.push(`  ⚠️ Port ${port} in use, killing stale process...`);
              const killed = await killProcessOnPort(port);
              if (killed) {
                messages.push(`  ✓ Freed port ${port}`);
              } else {
                messages.push(`  ⚠️ Could not free port ${port} - server may fail to start`);
              }
            }
          }

          // Show which ports will be used vs configured
          if (preCalculatedPorts.nextjs !== 3000 || preCalculatedPorts.vite !== 5173 || preCalculatedPorts.cloudflare !== 8787) {
            messages.push(`  Using ports: Next.js=${preCalculatedPorts.nextjs}, Vite=${preCalculatedPorts.vite}, Cloudflare=${preCalculatedPorts.cloudflare}`);
          }

          // Check for missing env passthrough vars
          const missingEnvVars = checkTurboEnvPassthrough(input.cwd);
          if (missingEnvVars.length > 0) {
            messages.push('');
            messages.push('⚠️ turbo.json missing globalPassThroughEnv for:');
            messages.push(`   ${missingEnvVars.join(', ')}`);
            messages.push('  Add to turbo.json: "globalPassThroughEnv": [...]');
          }

          // Check for MCP worker and start it separately (only if Turborepo won't handle it)
          const mcpWorkspace = workspaces.find((w) => w.includes('mcp'));
          if (mcpWorkspace) {
            const mcpPath = join(input.cwd, mcpWorkspace);
            const wranglerTomlPath = join(mcpPath, 'wrangler.toml');
            const wranglerJsoncPath = join(mcpPath, 'wrangler.jsonc');

            // Skip if workspace has a dev script - Turborepo will start it via `turbo dev`
            const turboWillStart = workspaceHasDevScript(mcpPath);
            if (turboWillStart) {
              messages.push('');
              messages.push(`ℹ️ MCP worker (${mcpWorkspace}) will be started by Turborepo`);
            } else if (existsSync(wranglerTomlPath) || existsSync(wranglerJsoncPath)) {
              messages.push('');
              messages.push('Starting MCP Cloudflare Worker...');

              // Parse configured port (default 8787 if not found)
              const configuredPort = await getWranglerDevPort(wranglerTomlPath) ||
                                    await getWranglerDevPort(wranglerJsoncPath) ||
                                    8787;

              // Check if port available
              const portAvailable = await isPortAvailable(configuredPort);

              // If not available, find fallback port
              let actualPort = configuredPort;
              if (!portAvailable) {
                const fallback = await findAvailablePort(configuredPort + 1, 10);
                if (fallback) {
                  actualPort = fallback;
                  messages.push(`  ⚠️ Port ${configuredPort} in use, using ${actualPort}`);
                } else {
                  messages.push(`  ⚠️ Could not find available port for MCP worker (${configuredPort}-${configuredPort + 9} all in use)`);
                  messages.push('  Skipping MCP worker startup');
                  // Continue without MCP worker - non-blocking
                  actualPort = 0;
                }
              }

              if (actualPort > 0) {
                // Start with explicit port if needed
                const command = actualPort !== configuredPort
                  ? `npx wrangler dev --port ${actualPort}`
                  : 'npx wrangler dev';

                const mcpResult = startDevServerBackground(mcpPath, command, logger, {
                  expectedPort: actualPort,
                  envVars: { PORT: String(actualPort) }
                });
                if (mcpResult) {
                  messages.push(`✓ MCP worker started (PID: ${mcpResult.pid})`);
                  messages.push(`  Logs: ${mcpResult.logs.stdout}`);
                  messages.push(`  URL: http://localhost:${actualPort}`);

                  // Update NEXT_PUBLIC_MCP_SERVER_URL if port changed
                  if (actualPort !== configuredPort) {
                    const mcpUrl = `http://localhost:${actualPort}`;
                    // Distribute updated MCP URL to all workspaces
                    for (const ws of workspaces) {
                      const wsPath = join(input.cwd, ws);
                      await distributeEnvVars(
                        wsPath,
                        { supabaseVars: {}, vercelVars: { NEXT_PUBLIC_MCP_SERVER_URL: mcpUrl } },
                        { createIfMissing: false, preserveExisting: true }
                      );
                    }
                    messages.push(`  ✓ Updated NEXT_PUBLIC_MCP_SERVER_URL to ${mcpUrl}`);
                  }
                } else {
                  messages.push('⚠️ Could not start MCP worker');
                }
              }
            }
          }
        }
      }

      messages.push(`Starting dev server: ${devCommand}`);

      // Use pre-calculated ports (same as used for env var URLs)
      // This ensures consistency between env vars and actual server ports
      const availablePorts = preCalculatedPorts;
      const devServerEnvVars: Record<string, string> = {};

      if (projectType === 'turborepo') {
        const workspaces = detectTurborepoWorkspaces(input.cwd);
        if (workspaces && workspaces.length > 0) {
          // For Turborepo: set PORT env vars for each workspace type
          for (const ws of workspaces) {
            const wsPath = join(input.cwd, ws);
            const wsType = detectProjectType(wsPath);
            if (wsType === 'nextjs') {
              devServerEnvVars.PORT = String(availablePorts.nextjs);
            } else if (wsType === 'vite') {
              devServerEnvVars.VITE_PORT = String(availablePorts.vite);
            } else if (wsType === 'cloudflare') {
              devServerEnvVars.WRANGLER_DEV_PORT = String(availablePorts.cloudflare);
            }
          }
        }
      } else {
        // For single-project: apply port based on project type
        if (projectType === 'nextjs' && availablePorts.nextjs !== 3000) {
          devServerEnvVars.PORT = String(availablePorts.nextjs);
        } else if (projectType === 'vite' && availablePorts.vite !== 5173) {
          devServerEnvVars.VITE_PORT = String(availablePorts.vite);
        } else if (projectType === 'cloudflare' && availablePorts.cloudflare !== 8787) {
          devServerEnvVars.WRANGLER_DEV_PORT = String(availablePorts.cloudflare);
        }
      }

      // Update session state with actual allocated ports for cleanup
      await updateWorktreeSupabaseSession(input.cwd, instanceConfig.worktreeInfo.worktreeId, {
        devServerPorts: availablePorts,
      });

      const result = startDevServerBackground(input.cwd, devCommand, logger, {
        envVars: devServerEnvVars
      });
      if (result) {
        messages.push(`✓ Dev server started (PID: ${result.pid})`);
        messages.push(`  Logs: ${result.logs.stdout}`);

        // For Turborepo: use multi-port health checks
        if (projectType === 'turborepo') {
          const workspaces = detectTurborepoWorkspaces(input.cwd);
          if (workspaces && workspaces.length > 0) {
            const workspacePorts = await detectWorkspacePorts(input.cwd, workspaces);

            // Apply worktree port offsets for health checks
            if (worktreeSlot > 0) {
              for (const wp of workspacePorts) {
                if (wp.configuredPort) {
                  wp.configuredPort += worktreeSlot * PORT_INCREMENT;
                }
                if (wp.defaultPort) {
                  wp.defaultPort += worktreeSlot * PORT_INCREMENT;
                }
              }
            }

            // Check health of all workspace servers
            // Note: Port conflicts were resolved before starting the dev server
            messages.push('  Waiting for workspace servers to be ready...');
            const healthResults = await checkMultipleServerHealth(workspacePorts);

            for (const hr of healthResults) {
              if (hr.port === 0) {
                messages.push(`  ⚠️ ${hr.workspace}: No port configured`);
              } else if (hr.healthy) {
                messages.push(`  ✓ ${hr.workspace} responding at http://localhost:${hr.port}`);
              } else {
                messages.push(`  ⚠️ ${hr.workspace} not responding on port ${hr.port}`);
              }
            }
          }
        } else {
          // For non-Turborepo: use single-port health check
          const packageJsonPath = join(input.cwd, 'package.json');
          const scriptPort = extractPortFromDevScript(packageJsonPath);
          let port = scriptPort || getDefaultPort(projectType);

          // Apply worktree port offset for non-Turborepo projects
          if (port && worktreeSlot > 0) {
            port += worktreeSlot * PORT_INCREMENT;
          }

          if (port) {
            messages.push(`  Waiting for server to be ready (port ${port})...`);
            const isHealthy = await checkServerHealth(port);

            if (isHealthy) {
              messages.push(`✓ Server is responding at http://localhost:${port}`);
            } else {
              messages.push(`⚠️ Server did not respond within 30 seconds`);
              messages.push(`  Check logs: ${result.logs.stderr}`);
              messages.push(`  Try manually: ${devCommand}`);
            }
          } else {
            messages.push('  ⚠️ Could not determine server port - skipping health check');
          }
        }
      } else {
        messages.push('⚠️ Could not start dev server');
        messages.push(`  Run manually: ${devCommand}`);
      }
    }

    // ========== Final Status ==========
    const finalMessage = messages.join('\n');

    await logger.logOutput({
      success: true,
      is_remote: isRemote,
      message: finalMessage,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: finalMessage,
      },
    };
  } catch (error) {
    await logger.logError(error as Error);

    // Log output for consistency with other exit paths
    await logger.logOutput({
      success: false,
      is_remote: isRemote,
      message: `Supabase setup error: ${error}`,
      reason: 'exception',
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Supabase setup error: ${error}`,
      },
    };
  }
}

export { handler };
runHook(handler);
