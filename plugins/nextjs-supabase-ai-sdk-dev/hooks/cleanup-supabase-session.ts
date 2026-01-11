/**
 * Supabase Session Cleanup Hook (SessionEnd)
 * SessionEnd hook that:
 * 1. Stops Supabase containers for the current session (using --workdir for tmp configs)
 * 2. Cleans up /tmp/supabase-{worktreeId} directory
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
import { cleanupTmpSupabaseDir } from '../shared/hooks/utils/supabase-tmp-config.js';
import { killProcessesOnPorts } from '../shared/hooks/utils/port.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Docker container config saved by SessionStart hook
 */
interface DockerContainerConfig {
  projectId: string;
  containerIds: string[];
  volumeNames: string[];
  savedAt: string;
}

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
  let cleanedVolumes = false;

  // 0. Try supabase stop --workdir first (cleanest approach for tmp directory sessions)
  if (session?.tmpConfigDir && existsSync(session.tmpConfigDir)) {
    try {
      const stopResult = await execCommand(
        `supabase stop --workdir ${session.tmpConfigDir}`,
        { cwd: input.cwd, timeout: 60000 }
      );
      if (stopResult.success) {
        cleanedContainers = true;
        cleanedVolumes = true;
      }
    } catch {
      // Fall through to docker-based cleanup
    }
  }

  // 1. Stop and delete Supabase containers using exact IDs from docker-containers.json
  // This prevents accidentally deleting containers from other sessions
  // Skip if supabase stop already succeeded
  const dockerConfigPath = join(input.cwd, '.claude', 'logs', 'docker-containers.json');

  // Try to use exact container IDs first (more precise, prevents cross-session deletion)
  let usedExactIds = false;
  if (!cleanedContainers && existsSync(dockerConfigPath)) {
    try {
      const configContent = readFileSync(dockerConfigPath, 'utf-8');
      const dockerConfig: DockerContainerConfig = JSON.parse(configContent);

      // Stop and remove containers by exact ID
      if (dockerConfig.containerIds && dockerConfig.containerIds.length > 0) {
        for (const containerId of dockerConfig.containerIds) {
          await execCommand(`docker stop ${containerId}`, { cwd: input.cwd, timeout: 30000 });
          await execCommand(`docker rm ${containerId}`, { cwd: input.cwd, timeout: 30000 });
        }
        cleanedContainers = true;
        usedExactIds = true;
      }

      // Remove volumes by exact name
      if (dockerConfig.volumeNames && dockerConfig.volumeNames.length > 0) {
        for (const volumeName of dockerConfig.volumeNames) {
          await execCommand(`docker volume rm ${volumeName}`, { cwd: input.cwd, timeout: 30000 });
        }
        cleanedVolumes = true;
      }
    } catch {
      // Config file invalid or containers already removed - fall through to filter-based cleanup
    }
  }

  // Fallback: use filter-based cleanup if exact IDs not available
  // This is less precise but ensures cleanup still happens
  // Skip if supabase stop or exact IDs already succeeded
  if (!cleanedContainers && !usedExactIds && session?.worktreeProjectId) {
    try {
      // Use exact name matching by listing containers and filtering in shell
      // The filter pattern matches containers ending with the exact project ID
      await execCommand(
        `docker ps -a --format "{{.Names}}" | grep "_${session.worktreeProjectId}$" | xargs -r docker stop`,
        { cwd: input.cwd, timeout: 30000 }
      );
      await execCommand(
        `docker ps -a --format "{{.Names}}" | grep "_${session.worktreeProjectId}$" | xargs -r docker rm`,
        { cwd: input.cwd, timeout: 30000 }
      );
      cleanedContainers = true;
    } catch {
      // Best effort - don't fail if cleanup fails
    }

    // 1b. Delete associated Docker volumes to free disk space (exact name match)
    if (!cleanedVolumes) {
      try {
        await execCommand(
          `docker volume rm "supabase_db_${session.worktreeProjectId}"`,
          { cwd: input.cwd, timeout: 30000 }
        );
        await execCommand(
          `docker volume rm "supabase_storage_${session.worktreeProjectId}"`,
          { cwd: input.cwd, timeout: 30000 }
        );
        cleanedVolumes = true;
      } catch {
        // Best effort - don't fail if cleanup fails
      }
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

  // 4. Clean up tmp Supabase config directory (for worktree sessions)
  if (session?.tmpConfigDir) {
    try {
      cleanupTmpSupabaseDir(session.tmpConfigDir);
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
    cleanedVolumes,
    cleanedPorts,
    cleanedConfig,
    reason: input.reason,
  });

  // SessionEnd hooks return empty object (cannot block session termination)
  return {};
}

export { handler };
runHook(handler);
