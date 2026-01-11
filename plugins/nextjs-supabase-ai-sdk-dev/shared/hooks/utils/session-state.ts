/**
 * Session state management for Stop hook tracking and Worktree Supabase instances
 *
 * Manages session-level state for:
 *
 * **Stop Hook Tracking:**
 * - How many times the hook has blocked the session
 * - Whether a GitHub comment has been posted for the session
 * - When the last block occurred
 *
 * **Worktree Supabase Instances:**
 * - Port allocations for concurrent worktree sessions
 * - Config.toml backup tracking
 * - Instance startup state
 *
 * This enables progressive blocking behavior where the Stop hook can:
 * 1. Block on first commit without PR (with instructions)
 * 2. Block again if no PR or comment posted
 * 3. Show warning after 3 blocks
 * 4. Reset when PR created or comment posted
 * @module session-state
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// Constants
// ============================================================================

const LOGS_DIR = '.claude/logs';
const SESSION_STOPS_FILE = 'session-stops.json';
const WORKTREE_SUPABASE_SESSION_PREFIX = 'supabase-session-';

// ============================================================================
// Types
// ============================================================================

/**
 * Session Stop state tracking for progressive blocking
 *
 * Tracks how many times a session has been blocked at Stop hook,
 * whether progress has been documented, and related metadata.
 */
export interface SessionStopState {
  /**
   * The unique session identifier
   */
  sessionId: string;
  /**
   * Number of times Stop hook has blocked (0-3)
   */
  blockCount: number;
  /**
   * Whether a GitHub comment has been posted
   */
  commentPosted: boolean;
  /**
   * ISO timestamp of last block
   */
  lastBlockTimestamp: string;
  /**
   * GitHub issue number linked to this session
   */
  issueNumber?: number;
  /**
   * Whether a PR has been created
   */
  prCreated?: boolean;
}

/**
 * Map of session IDs to their Stop hook state
 */
interface SessionStopsMap {
  [sessionId: string]: SessionStopState;
}

// ============================================================================
// File Path Management
// ============================================================================

/**
 * Get the path to session-stops.json
 * @param cwd - The working directory
 * @param customPath - Optional custom path (for testing)
 * @returns Full path to the session stops state file
 * @example
 * ```typescript
 * const path = getSessionStopsFilePath('/path/to/project');
 * // Returns: '/path/to/project/.claude/logs/session-stops.json'
 * ```
 */
function getSessionStopsFilePath(cwd: string, customPath?: string): string {
  return customPath || path.join(cwd, LOGS_DIR, SESSION_STOPS_FILE);
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Get session stop state for a given session
 *
 * Loads the session's Stop hook state from disk. If no state exists,
 * returns a default state with blockCount: 0.
 * @param sessionId - The session ID to load state for
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-stops.json (for testing)
 * @returns The session state, or default state if not found
 * @example
 * ```typescript
 * import { getSessionStopState } from './session-state.js';
 *
 * // In Stop hook
 * const state = await getSessionStopState(input.session_id, input.cwd);
 * console.log('Block count:', state.blockCount);
 * console.log('Comment posted:', state.commentPosted);
 * ```
 */
export async function getSessionStopState(
  sessionId: string,
  cwd: string,
  statePath?: string
): Promise<SessionStopState> {
  const filePath = getSessionStopsFilePath(cwd, statePath);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const allStates: SessionStopsMap = JSON.parse(content);

    if (allStates[sessionId]) {
      return allStates[sessionId];
    }
  } catch {
    // File doesn't exist or parse error - return default
  }

  // Return default state
  return {
    sessionId,
    blockCount: 0,
    commentPosted: false,
    lastBlockTimestamp: new Date().toISOString(),
  };
}

/**
 * Update session stop state with partial updates
 *
 * Merges the provided updates into the existing state and saves to disk.
 * Automatically creates the logs directory if it doesn't exist.
 * @param sessionId - The session ID to update
 * @param updates - Partial state updates to apply
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-stops.json (for testing)
 * @returns The updated session state
 * @example
 * ```typescript
 * import { updateSessionStopState } from './session-state.js';
 *
 * // Increment block count
 * await updateSessionStopState(input.session_id, {
 *   blockCount: state.blockCount + 1,
 *   lastBlockTimestamp: new Date().toISOString()
 * }, input.cwd);
 *
 * // Mark comment posted
 * await updateSessionStopState(input.session_id, {
 *   commentPosted: true
 * }, input.cwd);
 * ```
 */
export async function updateSessionStopState(
  sessionId: string,
  updates: Partial<Omit<SessionStopState, 'sessionId'>>,
  cwd: string,
  statePath?: string
): Promise<SessionStopState> {
  const filePath = getSessionStopsFilePath(cwd, statePath);

  // Load existing states
  let allStates: SessionStopsMap = {};
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    allStates = JSON.parse(content);
  } catch {
    // File doesn't exist yet - start fresh
  }

  // Get current state or create default
  const currentState = allStates[sessionId] || {
    sessionId,
    blockCount: 0,
    commentPosted: false,
    lastBlockTimestamp: new Date().toISOString(),
  };

  // Merge updates
  const updatedState: SessionStopState = {
    ...currentState,
    ...updates,
    sessionId, // Ensure sessionId is never overwritten
  };

  allStates[sessionId] = updatedState;

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(allStates, null, 2), 'utf-8');

  return updatedState;
}

/**
 * Reset session stop state to defaults
 *
 * Clears the block count and resets all flags. This is called when:
 * - A PR is created for the session's branch
 * - A GitHub comment is posted documenting progress
 * @param sessionId - The session ID to reset
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-stops.json (for testing)
 * @returns Promise that resolves when state is reset
 * @example
 * ```typescript
 * import { resetSessionStopState } from './session-state.js';
 *
 * // After PR created
 * if (prExists) {
 *   await resetSessionStopState(input.session_id, input.cwd);
 * }
 *
 * // After comment posted
 * if (commentPosted) {
 *   await resetSessionStopState(input.session_id, input.cwd);
 * }
 * ```
 */
export async function resetSessionStopState(
  sessionId: string,
  cwd: string,
  statePath?: string
): Promise<void> {
  await updateSessionStopState(
    sessionId,
    {
      blockCount: 0,
      commentPosted: false,
      lastBlockTimestamp: new Date().toISOString(),
    },
    cwd,
    statePath
  );
}

/**
 * Remove session stop state entirely
 *
 * Deletes the session's state from the file. Use this when a session
 * is completely finished and you want to clean up.
 * @param sessionId - The session ID to remove
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-stops.json (for testing)
 * @returns Promise that resolves when state is removed (fails silently)
 * @example
 * ```typescript
 * import { removeSessionStopState } from './session-state.js';
 *
 * // Cleanup after session completes successfully
 * await removeSessionStopState(input.session_id, input.cwd);
 * ```
 */
export async function removeSessionStopState(
  sessionId: string,
  cwd: string,
  statePath?: string
): Promise<void> {
  const filePath = getSessionStopsFilePath(cwd, statePath);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const allStates: SessionStopsMap = JSON.parse(content);
    delete allStates[sessionId];
    await fs.writeFile(filePath, JSON.stringify(allStates, null, 2), 'utf-8');
  } catch {
    // Nothing to remove
  }
}

// ============================================================================
// Worktree Supabase Session Types
// ============================================================================

/**
 * Port set for a Supabase instance
 */
export interface SupabasePortSet {
  api: number;
  db: number;
  shadowDb: number;
  studio: number;
  inbucket: number;
  analytics: number;
  pooler: number;
  edgeRuntime: number;
}

/**
 * Port set for dev servers (Next.js, Vite, etc.)
 */
export interface DevServerPortSet {
  nextjs: number;
  vite: number;
  cloudflare: number;
}

/**
 * Worktree Supabase session state
 * Tracks isolated Supabase instances for concurrent worktree sessions
 */
export interface WorktreeSupabaseSession {
  /** Unique worktree identifier (8-char hash) */
  worktreeId: string;
  /** Full path to worktree root */
  worktreePath: string;
  /** Port slot number (0 = default, 1+ = worktree) */
  slot: number;
  /** Supabase service ports for this instance */
  supabasePorts: SupabasePortSet;
  /** Dev server ports for this worktree */
  devServerPorts: DevServerPortSet;
  /** ISO timestamp when instance was started */
  startedAt: string;
  /** Path to config.toml backup file (deprecated - use tmpConfigDir) */
  configBackupPath: string;
  /** Whether instance is currently running */
  running: boolean;
  /** Original project_id from config.toml (before modification) */
  originalProjectId: string;
  /** Worktree-specific project_id (original or original-{slot}) */
  worktreeProjectId: string;
  /** Claude session ID that owns this instance (for orphan detection) */
  sessionId?: string;
  /** Path to temporary Supabase config directory (e.g., /tmp/supabase-abc12345) */
  tmpConfigDir?: string;
  /** Path to original supabase/ directory in project */
  originalSupabaseDir?: string;
}

// ============================================================================
// Worktree Session File Path Management
// ============================================================================

/**
 * Get the path to a worktree's Supabase session file
 * @param cwd - The working directory
 * @param worktreeId - Unique worktree identifier
 * @returns Full path to the session file
 */
function getWorktreeSessionFilePath(cwd: string, worktreeId: string): string {
  return path.join(cwd, LOGS_DIR, `${WORKTREE_SUPABASE_SESSION_PREFIX}${worktreeId}.json`);
}

// ============================================================================
// Worktree Supabase Session Management
// ============================================================================

/**
 * Load worktree Supabase session from disk
 *
 * @param cwd - The working directory where logs are stored
 * @param worktreeId - Unique worktree identifier
 * @returns Session state, or null if not found
 *
 * @example
 * ```typescript
 * const session = await loadWorktreeSupabaseSession(cwd, worktreeId);
 * if (session && session.running) {
 *   console.log(`Using existing Supabase on port ${session.supabasePorts.api}`);
 * }
 * ```
 */
export async function loadWorktreeSupabaseSession(
  cwd: string,
  worktreeId: string
): Promise<WorktreeSupabaseSession | null> {
  const filePath = getWorktreeSessionFilePath(cwd, worktreeId);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as WorktreeSupabaseSession;
  } catch {
    return null;
  }
}

/**
 * Save worktree Supabase session to disk
 *
 * @param cwd - The working directory where logs are stored
 * @param session - Session state to save
 *
 * @example
 * ```typescript
 * await saveWorktreeSupabaseSession(cwd, {
 *   worktreeId: 'abc12345',
 *   worktreePath: '/path/to/worktree',
 *   slot: 1,
 *   supabasePorts: { api: 54331, db: 54332, ... },
 *   devServerPorts: { nextjs: 3010, vite: 5183, cloudflare: 8797 },
 *   startedAt: new Date().toISOString(),
 *   configBackupPath: '/path/to/config.toml.backup-abc12345',
 *   running: true,
 * });
 * ```
 */
export async function saveWorktreeSupabaseSession(
  cwd: string,
  session: WorktreeSupabaseSession
): Promise<void> {
  const filePath = getWorktreeSessionFilePath(cwd, session.worktreeId);

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

/**
 * Update worktree Supabase session with partial updates
 *
 * @param cwd - The working directory where logs are stored
 * @param worktreeId - Unique worktree identifier
 * @param updates - Partial updates to apply
 * @returns Updated session, or null if session doesn't exist
 */
export async function updateWorktreeSupabaseSession(
  cwd: string,
  worktreeId: string,
  updates: Partial<Omit<WorktreeSupabaseSession, 'worktreeId'>>
): Promise<WorktreeSupabaseSession | null> {
  const existing = await loadWorktreeSupabaseSession(cwd, worktreeId);
  if (!existing) {
    return null;
  }

  const updated: WorktreeSupabaseSession = {
    ...existing,
    ...updates,
    worktreeId, // Ensure worktreeId is never overwritten
  };

  await saveWorktreeSupabaseSession(cwd, updated);
  return updated;
}

/**
 * Clear worktree Supabase session from disk
 *
 * @param cwd - The working directory where logs are stored
 * @param worktreeId - Unique worktree identifier
 * @returns true if session was deleted, false if not found
 */
export async function clearWorktreeSupabaseSession(
  cwd: string,
  worktreeId: string
): Promise<boolean> {
  const filePath = getWorktreeSessionFilePath(cwd, worktreeId);

  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all worktree Supabase sessions
 * Useful for debugging and cleanup
 *
 * @param cwd - The working directory where logs are stored
 * @returns Array of all session states
 */
export async function listWorktreeSupabaseSessions(
  cwd: string
): Promise<WorktreeSupabaseSession[]> {
  const logsDir = path.join(cwd, LOGS_DIR);
  const sessions: WorktreeSupabaseSession[] = [];

  try {
    const files = await fs.readdir(logsDir);
    const sessionFiles = files.filter(
      (f) => f.startsWith(WORKTREE_SUPABASE_SESSION_PREFIX) && f.endsWith('.json')
    );

    for (const file of sessionFiles) {
      try {
        const content = await fs.readFile(path.join(logsDir, file), 'utf-8');
        sessions.push(JSON.parse(content) as WorktreeSupabaseSession);
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return sessions;
}

/**
 * Check if a worktree session exists and is marked as running
 *
 * @param cwd - The working directory where logs are stored
 * @param worktreeId - Unique worktree identifier
 * @returns true if session exists and is running
 */
export async function isWorktreeSupabaseRunning(
  cwd: string,
  worktreeId: string
): Promise<boolean> {
  const session = await loadWorktreeSupabaseSession(cwd, worktreeId);
  return session?.running === true;
}
