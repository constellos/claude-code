/**
 * Session state management for Stop hook tracking
 *
 * Manages session-level state for the Stop hook to track:
 * - How many times the hook has blocked the session
 * - Whether a GitHub comment has been posted for the session
 * - When the last block occurred
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
   * @deprecated Use lastSeenCommitSha for tracking instead
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
  /**
   * Last seen HEAD commit SHA - used to detect new commits
   * When current HEAD matches this, we've already seen these commits
   */
  lastSeenCommitSha?: string;
  /**
   * Commit SHA when comment was posted - used to detect new commits after comment
   * If current HEAD differs from this, new commits need documentation
   */
  commentPostedAtSha?: string;
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
