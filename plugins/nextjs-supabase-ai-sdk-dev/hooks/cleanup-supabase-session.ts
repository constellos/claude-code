/**
 * Supabase Session Cleanup Hook (SessionEnd)
 * SessionEnd hook that:
 * 1. Stops Supabase containers for the current session
 * 2. Restores config.toml from backup (for worktree sessions)
 * 3. Marks session state as stopped
 *
 * This is the primary cleanup hook that runs when the user exits the session
 * (Ctrl+C, /clear, logout, etc.)
 *
 * @module cleanup-supabase-session
 */

import type { SessionEndInput, SessionEndHookOutput } from '../shared/types/types.js';
import { runHook } from '../shared/hooks/utils/io.js';
import { createDebugLogger } from '../shared/hooks/utils/debug.js';
import { detectWorktree } from '../shared/hooks/utils/worktree.js';
import {
  loadWorktreeSupabaseSession,
  updateWorktreeSupabaseSession,
} from '../shared/hooks/utils/session-state.js';
import {
  restoreSupabaseConfig,
  getSupabaseConfigPath,
} from '../shared/hooks/utils/supabase-ports.js';
import { killProcessesOnPorts } from '../shared/hooks/utils/port.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

/**
 * Execute a command and return result
 */
async function execCommand(
  command: string,
  options: { cwd: string; timeout?: number }
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      timeout: options.timeout ?? 30000,
    });
    return { success: true, stdout, stderr };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || 'Unknown error',
    };
  }
}

/**
 * SessionEnd hook handler - cleanup Supabase containers on session end
 */
async function handler(input: SessionEndInput): Promise<SessionEndHookOutput> {
  const logger = createDebugLogger(input.cwd, 'cleanup-supabase-session', true);
  await logger.logInput({
    session_id: input.session_id,
    reason: input.reason,
  });

  const worktreeInfo = detectWorktree(input.cwd);

  // Load session state
  const session = await loadWorktreeSupabaseSession(input.cwd, worktreeInfo.worktreeId);

  // Best-effort cleanup - try to clean up resources regardless of session ownership
  // This ensures we don't leave orphaned containers/processes when sessions end unexpectedly

  // Track what we cleaned
  let cleanedContainers = false;
  let cleanedPorts = false;
  let cleanedConfig = false;

  // 1. Stop and delete Supabase containers (if session has project ID)
  if (session?.worktreeProjectId) {
    try {
      // Stop containers
      await execCommand(
        `docker ps -q --filter "name=supabase_.*_${session.worktreeProjectId}" | xargs -r docker stop`,
        { cwd: input.cwd, timeout: 30000 }
      );
      // Delete stopped containers (docker rm)
      await execCommand(
        `docker ps -aq --filter "name=supabase_.*_${session.worktreeProjectId}" | xargs -r docker rm`,
        { cwd: input.cwd, timeout: 30000 }
      );
      cleanedContainers = true;
    } catch {
      // Best effort - don't fail if cleanup fails
    }
  }

  // 2. Kill dev server processes by port (if session has port info)
  if (session?.devServerPorts) {
    try {
      const ports = [
        session.devServerPorts.nextjs,
        session.devServerPorts.vite,
        session.devServerPorts.cloudflare,
      ].filter((p): p is number => typeof p === 'number' && p > 0);

      if (ports.length > 0) {
        await killProcessesOnPorts(ports);
        cleanedPorts = true;
      }
    } catch {
      // Best effort - don't fail if cleanup fails
    }
  }

  // 3. Also try to kill common dev server ports (3100-3102, 8787) as fallback
  try {
    await killProcessesOnPorts([3100, 3101, 3102, 8787]);
  } catch {
    // Best effort
  }

  // 4. Restore config.toml from backup (for worktree sessions)
  if (session?.configBackupPath && existsSync(session.configBackupPath)) {
    try {
      const configPath = getSupabaseConfigPath(input.cwd);
      restoreSupabaseConfig(configPath, `.backup-${worktreeInfo.worktreeId}`);
      cleanedConfig = true;
    } catch {
      // Best effort
    }
  }

  // 5. Mark session as stopped (if session exists)
  if (session) {
    try {
      await updateWorktreeSupabaseSession(input.cwd, worktreeInfo.worktreeId, {
        running: false,
      });
    } catch {
      // Best effort
    }
  }

  await logger.logOutput({
    success: true,
    cleaned: session?.worktreeProjectId,
    cleanedContainers,
    cleanedPorts,
    cleanedConfig,
    reason: input.reason,
  });

  // SessionEnd hooks return empty object (cannot block session termination)
  return {};
}

export { handler };
runHook(handler);
