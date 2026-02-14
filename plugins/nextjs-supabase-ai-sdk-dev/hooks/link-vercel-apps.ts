/**
 * Vercel Auto-Link Hook
 * SessionStart hook that automatically links monorepo apps to their Vercel projects
 * and pulls environment variables.
 *
 * Features:
 * - Detects turborepo structure via turbo.json
 * - Finds apps in apps/ directory
 * - Links unlinked apps to Vercel projects
 * - Pulls environment variables for each app
 * @module link-vercel-apps
 */

import type { SessionStartInput, SessionStartHookOutput } from '../shared/types/types.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

const execAsync = promisify(exec);

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

interface VercelProjectJson {
  orgId: string;
  projectId: string;
}

/**
 * Execute a shell command with error handling
 */
async function execCommand(
  command: string,
  options: { cwd?: string; timeout?: number } = {}
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeout || 30000,
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
 * Check if Vercel CLI is available
 */
async function isVercelAvailable(): Promise<boolean> {
  const result = await execCommand('which vercel');
  return result.success && result.stdout.length > 0;
}

/**
 * Check if a directory is linked to Vercel
 */
function isVercelLinked(appPath: string): VercelProjectJson | null {
  const projectJsonPath = join(appPath, '.vercel', 'project.json');
  if (!existsSync(projectJsonPath)) {
    return null;
  }

  try {
    const content = readFileSync(projectJsonPath, 'utf-8');
    return JSON.parse(content) as VercelProjectJson;
  } catch {
    return null;
  }
}

/**
 * Get Vercel team/scope from root .vercel/project.json or env var
 */
function getVercelScope(cwd: string): string | null {
  // First try env var
  if (process.env.VERCEL_TEAM_ID) {
    return process.env.VERCEL_TEAM_ID;
  }

  // Try root .vercel/project.json
  const rootProjectJson = join(cwd, '.vercel', 'project.json');
  if (existsSync(rootProjectJson)) {
    try {
      const content = readFileSync(rootProjectJson, 'utf-8');
      const data = JSON.parse(content) as VercelProjectJson;
      return data.orgId || null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Detect turborepo workspaces
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

    // Get workspace patterns
    let workspacePatterns: string[] = [];
    if (Array.isArray(packageData.workspaces)) {
      workspacePatterns = packageData.workspaces;
    } else if (packageData.workspaces?.packages) {
      workspacePatterns = packageData.workspaces.packages;
    }

    // Resolve workspace directories - only apps/* (not packages/*)
    const workspaceDirs: string[] = [];

    for (const pattern of workspacePatterns) {
      if (!pattern.startsWith('apps/') && !pattern.startsWith('apps/*')) {
        continue; // Skip non-apps workspaces
      }

      if (pattern.includes('*')) {
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
 * Check if an app directory is a Cloudflare Workers project
 * (has wrangler.toml, wrangler.json, or wrangler.jsonc)
 */
function isCloudflareProject(appPath: string): boolean {
  return (
    existsSync(join(appPath, 'wrangler.toml')) ||
    existsSync(join(appPath, 'wrangler.json')) ||
    existsSync(join(appPath, 'wrangler.jsonc'))
  );
}

/**
 * Try to find a matching Vercel project for an app
 * Uses the app directory name as the project name guess
 */
function guessProjectName(appPath: string, repoName: string): string {
  const appName = basename(appPath);
  // Common patterns: repo-app, repo-web, repo-api, etc.
  return `${repoName}-${appName}`;
}

/**
 * Get the repository name from git remote or package.json
 */
async function getRepoName(cwd: string): Promise<string | null> {
  // Try git remote
  const result = await execCommand('git remote get-url origin', { cwd });
  if (result.success) {
    // Extract repo name from URL
    // git@github.com:org/repo.git or https://github.com/org/repo.git
    const match = result.stdout.match(/[/:]([^/]+)\.git$/);
    if (match) {
      return match[1];
    }
    // Handle URLs without .git
    const match2 = result.stdout.match(/[/:]([^/]+)$/);
    if (match2) {
      return match2[1];
    }
  }

  // Fallback to package.json name
  const packageJsonPath = join(cwd, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return pkg.name?.replace(/^@[^/]+\//, '') || null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Link an app to Vercel
 */
async function linkAppToVercel(
  appPath: string,
  projectName: string,
  scope: string | null
): Promise<ExecResult> {
  let command = `vercel link --yes --project ${projectName}`;
  if (scope) {
    command += ` --scope ${scope}`;
  }

  return await execCommand(command, { cwd: appPath, timeout: 60000 });
}

/**
 * Pull environment variables for an app
 */
async function pullVercelEnv(appPath: string): Promise<ExecResult> {
  return await execCommand('vercel env pull --yes', { cwd: appPath, timeout: 30000 });
}

/**
 * SessionStart hook handler
 */
async function handler(input: SessionStartInput): Promise<SessionStartHookOutput> {
  const logger = createDebugLogger(input.cwd, 'link-vercel-apps', true);
  const messages: string[] = [];

  try {
    await logger.logInput({ source: input.source, session_id: input.session_id });

    // Check if Vercel CLI is available
    if (!(await isVercelAvailable())) {
      // Vercel CLI not installed - skip silently (install-vercel hook handles this)
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '',
        },
      };
    }

    // Detect turborepo workspaces
    const workspaces = detectTurborepoWorkspaces(input.cwd);
    if (!workspaces || workspaces.length === 0) {
      // Not a turborepo or no apps - skip
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '',
        },
      };
    }

    // Get scope for Vercel commands
    const scope = getVercelScope(input.cwd);
    const repoName = await getRepoName(input.cwd);

    messages.push('');
    messages.push('Vercel App Linking:');

    let linkedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const workspace of workspaces) {
      const appPath = join(input.cwd, workspace);
      const appName = basename(workspace);

      // Skip Cloudflare Workers projects (they have wrangler config files)
      if (isCloudflareProject(appPath)) {
        messages.push(`  ⏭ ${appName} is a Cloudflare project, skipping`);
        skippedCount++;
        continue;
      }

      // Check if already linked
      const existingLink = isVercelLinked(appPath);
      if (existingLink) {
        messages.push(`  ✓ ${appName} already linked`);
        skippedCount++;

        // Still pull env vars if linked
        const envResult = await pullVercelEnv(appPath);
        if (envResult.success) {
          messages.push(`    ✓ Env vars pulled`);
        }
        continue;
      }

      // Try to link the app
      const projectName = repoName ? guessProjectName(workspace, repoName) : appName;
      messages.push(`  Linking ${appName} to ${projectName}...`);

      const linkResult = await linkAppToVercel(appPath, projectName, scope);
      if (linkResult.success) {
        messages.push(`  ✓ ${appName} linked to ${projectName}`);
        linkedCount++;

        // Pull env vars after successful link
        const envResult = await pullVercelEnv(appPath);
        if (envResult.success) {
          messages.push(`    ✓ Env vars pulled`);
        } else {
          messages.push(`    ⚠️ Could not pull env vars`);
        }
      } else {
        messages.push(`  ⚠️ Could not link ${appName}: ${linkResult.stderr.slice(0, 100)}`);
        failedCount++;
      }
    }

    // Summary
    messages.push('');
    messages.push(`Summary: ${linkedCount} linked, ${skippedCount} already linked, ${failedCount} failed`);

    const finalMessage = messages.join('\n');

    await logger.logOutput({
      success: true,
      linked: linkedCount,
      skipped: skippedCount,
      failed: failedCount,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: finalMessage,
      },
    };
  } catch (error) {
    await logger.logError(error as Error);

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Vercel linking error: ${error}`,
      },
    };
  }
}

export { handler };
runHook(handler);
