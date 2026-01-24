/**
 * Unified GitHub session state management
 *
 * Manages tracking of GitHub PRs and issues created during Claude sessions
 * in a single github.json file. This enables:
 * - Cross-session awareness of related PRs and issues
 * - Tracking linked issues from PR bodies
 * - Unified state for session stop output
 *
 * State is stored in .claude/logs/github.json
 *
 * @module github-state
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ============================================================================
// Constants
// ============================================================================

const LOGS_DIR = '.claude/logs';
const GITHUB_STATE_FILE = 'github.json';

// ============================================================================
// Types
// ============================================================================

/**
 * Reference to a GitHub PR created during a session
 */
export interface SessionPR {
  /**
   * PR number
   */
  number: number;
  /**
   * Full GitHub PR URL
   */
  url: string;
  /**
   * PR title
   */
  title: string;
  /**
   * ISO timestamp when PR was created
   */
  createdAt: string;
  /**
   * Issue numbers linked via PR body (Fixes #123, etc.)
   */
  linkedIssues: number[];
}

/**
 * Reference to a GitHub issue created during a session
 */
export interface SessionIssue {
  /**
   * Issue number
   */
  number: number;
  /**
   * Full GitHub issue URL
   */
  url: string;
  /**
   * Issue title
   */
  title: string;
  /**
   * ISO timestamp when issue was created
   */
  createdAt: string;
}

/**
 * Complete GitHub session state
 */
export interface GitHubSessionState {
  /**
   * Session identifier
   */
  sessionId: string;
  /**
   * PRs created during this session
   */
  prs: SessionPR[];
  /**
   * Issues created during this session
   */
  issues: SessionIssue[];
  /**
   * ISO timestamp of last update
   */
  lastUpdated: string;
}

/**
 * Map of session IDs to their GitHub state
 */
export interface GitHubStateFile {
  [sessionId: string]: GitHubSessionState;
}

// ============================================================================
// File Path Management
// ============================================================================

/**
 * Get the path to github.json
 * @param cwd - The working directory
 * @param customPath - Optional custom path (for testing)
 * @returns Full path to the github state file
 */
function getGitHubStateFilePath(cwd: string, customPath?: string): string {
  return customPath || path.join(cwd, LOGS_DIR, GITHUB_STATE_FILE);
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Load GitHub state from disk
 *
 * Loads all tracked sessions and their PRs/issues. If the file doesn't exist
 * or is invalid, returns an empty state.
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns The complete GitHub state
 */
export async function loadGitHubState(
  cwd: string,
  statePath?: string
): Promise<GitHubStateFile> {
  const filePath = getGitHubStateFilePath(cwd, statePath);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // File doesn't exist or parse error - return empty state
    return {};
  }
}

/**
 * Save GitHub state to disk
 *
 * Persists the complete state to disk. Automatically creates the logs directory
 * if it doesn't exist.
 * @param cwd - The working directory where logs are stored
 * @param state - The complete GitHub state to save
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns Promise that resolves when state is saved
 */
async function saveGitHubState(
  cwd: string,
  state: GitHubStateFile,
  statePath?: string
): Promise<void> {
  const filePath = getGitHubStateFilePath(cwd, statePath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Get or create session state
 * @param sessionId - Session identifier
 * @param state - Current state file
 * @returns Session state (existing or new)
 */
function getOrCreateSessionState(
  sessionId: string,
  state: GitHubStateFile
): GitHubSessionState {
  if (!state[sessionId]) {
    state[sessionId] = {
      sessionId,
      prs: [],
      issues: [],
      lastUpdated: new Date().toISOString(),
    };
  }
  return state[sessionId];
}

/**
 * Add a PR to session state
 *
 * Records that a PR was created during a session. If the session doesn't exist,
 * it will be created. Automatically enforces a 100-session limit.
 * @param sessionId - The session ID
 * @param pr - The PR reference to add
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns Promise that resolves when the PR is added
 */
export async function addPRToState(
  sessionId: string,
  pr: SessionPR,
  cwd: string,
  statePath?: string
): Promise<void> {
  let state = await loadGitHubState(cwd, statePath);
  const sessionState = getOrCreateSessionState(sessionId, state);

  // Check if PR already exists (avoid duplicates)
  const existingIndex = sessionState.prs.findIndex((p) => p.number === pr.number);
  if (existingIndex >= 0) {
    // Update existing PR (e.g., with new linked issues)
    sessionState.prs[existingIndex] = pr;
  } else {
    sessionState.prs.push(pr);
  }

  sessionState.lastUpdated = new Date().toISOString();

  // Limit to last 100 sessions
  state = enforceSessionLimit(state, 100);

  await saveGitHubState(cwd, state, statePath);
}

/**
 * Add an issue to session state
 *
 * Records that an issue was created during a session. If the session doesn't exist,
 * it will be created. Automatically enforces a 100-session limit.
 * @param sessionId - The session ID
 * @param issue - The issue reference to add
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns Promise that resolves when the issue is added
 */
export async function addIssueToState(
  sessionId: string,
  issue: SessionIssue,
  cwd: string,
  statePath?: string
): Promise<void> {
  let state = await loadGitHubState(cwd, statePath);
  const sessionState = getOrCreateSessionState(sessionId, state);

  // Check if issue already exists (avoid duplicates)
  const existingIndex = sessionState.issues.findIndex((i) => i.number === issue.number);
  if (existingIndex >= 0) {
    // Update existing issue
    sessionState.issues[existingIndex] = issue;
  } else {
    sessionState.issues.push(issue);
  }

  sessionState.lastUpdated = new Date().toISOString();

  // Limit to last 100 sessions
  state = enforceSessionLimit(state, 100);

  await saveGitHubState(cwd, state, statePath);
}

/**
 * Get PRs created during a specific session
 * @param sessionId - The session ID to query
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns Array of PR references
 */
export async function getSessionPRs(
  sessionId: string,
  cwd: string,
  statePath?: string
): Promise<SessionPR[]> {
  const state = await loadGitHubState(cwd, statePath);
  return state[sessionId]?.prs || [];
}

/**
 * Get issues created during a specific session
 * @param sessionId - The session ID to query
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns Array of issue references
 */
export async function getSessionIssuesFromState(
  sessionId: string,
  cwd: string,
  statePath?: string
): Promise<SessionIssue[]> {
  const state = await loadGitHubState(cwd, statePath);
  return state[sessionId]?.issues || [];
}

/**
 * Get the full session state
 * @param sessionId - The session ID to query
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns Session state or null if not found
 */
export async function getSessionGitHubState(
  sessionId: string,
  cwd: string,
  statePath?: string
): Promise<GitHubSessionState | null> {
  const state = await loadGitHubState(cwd, statePath);
  return state[sessionId] || null;
}

/**
 * Enforce session limit by removing oldest sessions
 * @param state - Current state
 * @param limit - Maximum number of sessions to keep
 * @returns Updated state
 */
function enforceSessionLimit(state: GitHubStateFile, limit: number): GitHubStateFile {
  const sessionIds = Object.keys(state);
  if (sessionIds.length <= limit) {
    return state;
  }

  // Sort by lastUpdated, keep newest
  const sorted = sessionIds
    .map((id) => ({ id, lastUpdated: state[id].lastUpdated }))
    .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
    .slice(0, limit);

  const newState: GitHubStateFile = {};
  for (const { id } of sorted) {
    newState[id] = state[id];
  }
  return newState;
}

/**
 * Clean up old sessions from state file
 * @param cwd - The working directory where logs are stored
 * @param retentionDays - Number of days to retain sessions (default: 30)
 * @param statePath - Optional custom path for github.json (for testing)
 * @returns Promise that resolves when cleanup is complete
 */
export async function cleanupOldGitHubSessions(
  cwd: string,
  retentionDays: number = 30,
  statePath?: string
): Promise<void> {
  const state = await loadGitHubState(cwd, statePath);
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let modified = false;
  const newState: GitHubStateFile = {};

  for (const [sessionId, session] of Object.entries(state)) {
    const sessionTime = new Date(session.lastUpdated).getTime();
    if (sessionTime >= cutoffTime) {
      newState[sessionId] = session;
    } else {
      modified = true;
    }
  }

  if (modified) {
    await saveGitHubState(cwd, newState, statePath);
  }
}
