/**
 * Session issues tracking for cross-session issue discovery
 *
 * Manages tracking of GitHub issues created during Claude sessions to enable:
 * - Cross-session awareness of related issues
 * - Automatic surfacing of issues from previous sessions
 * - Relevance-based issue discovery in SessionStart hook
 *
 * This enables continuity across sessions by tracking which issues were created
 * during each session and surfacing related issues when new sessions start.
 *
 * @module session-issues
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ============================================================================
// Constants
// ============================================================================

const LOGS_DIR = '.claude/logs';
const SESSION_ISSUES_FILE = 'session-issues.json';

// ============================================================================
// Types
// ============================================================================

/**
 * Reference to a GitHub issue created during a session
 */
export interface IssueReference {
  /**
   * Full repository name (e.g., "owner/repo")
   */
  repo: string;
  /**
   * GitHub issue number
   */
  number: number;
  /**
   * Issue title
   */
  title: string;
  /**
   * Full GitHub issue URL
   */
  url: string;
  /**
   * ISO timestamp when issue was created
   */
  createdAt: string;
}

/**
 * Session-level tracking of issues created
 */
export interface SessionIssuesEntry {
  /**
   * Unique session identifier
   */
  sessionId: string;
  /**
   * Git branch at time of session
   */
  branch: string;
  /**
   * Repository name (owner/repo)
   */
  repo: string;
  /**
   * Issues created during this session
   */
  issuesCreated: IssueReference[];
  /**
   * ISO timestamp when session started
   */
  startedAt: string;
  /**
   * ISO timestamp of last update
   */
  lastUpdated: string;
}

/**
 * Map of session IDs to their issue tracking data
 */
export interface SessionIssuesState {
  [sessionId: string]: SessionIssuesEntry;
}

/**
 * Related issue with relevance scoring
 */
export interface RelatedIssue extends IssueReference {
  /**
   * Relevance level based on discovery strategy
   */
  relevance: 'high' | 'medium';
  /**
   * Human-readable reason for the relevance
   */
  reason: string;
  /**
   * Human-readable age of the session that created this issue
   */
  sessionAge: string;
}

// ============================================================================
// File Path Management
// ============================================================================

/**
 * Get the path to session-issues.json
 * @param cwd - The working directory
 * @param customPath - Optional custom path (for testing)
 * @returns Full path to the session issues state file
 * @example
 * ```typescript
 * const path = getSessionIssuesFilePath('/path/to/project');
 * // Returns: '/path/to/project/.claude/logs/session-issues.json'
 * ```
 */
function getSessionIssuesFilePath(cwd: string, customPath?: string): string {
  return customPath || path.join(cwd, LOGS_DIR, SESSION_ISSUES_FILE);
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Load session issues state from disk
 *
 * Loads all tracked sessions and their created issues. If the file doesn't exist
 * or is invalid, returns an empty state.
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-issues.json (for testing)
 * @returns The complete session issues state
 * @example
 * ```typescript
 * import { loadSessionIssuesState } from './session-issues.js';
 *
 * const state = await loadSessionIssuesState('/path/to/project');
 * for (const [sessionId, session] of Object.entries(state)) {
 *   console.log(`Session ${sessionId} created ${session.issuesCreated.length} issues`);
 * }
 * ```
 */
export async function loadSessionIssuesState(
  cwd: string,
  statePath?: string
): Promise<SessionIssuesState> {
  const filePath = getSessionIssuesFilePath(cwd, statePath);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // File doesn't exist or parse error - return empty state
    return {};
  }
}

/**
 * Save session issues state to disk
 *
 * Persists the complete state to disk. Automatically creates the logs directory
 * if it doesn't exist.
 * @param cwd - The working directory where logs are stored
 * @param state - The complete session issues state to save
 * @param statePath - Optional custom path for session-issues.json (for testing)
 * @returns Promise that resolves when state is saved
 * @example
 * ```typescript
 * import { loadSessionIssuesState, saveSessionIssuesState } from './session-issues.js';
 *
 * const state = await loadSessionIssuesState(cwd);
 * state['new-session-id'] = {
 *   sessionId: 'new-session-id',
 *   branch: 'feature/test',
 *   repo: 'owner/repo',
 *   issuesCreated: [],
 *   startedAt: new Date().toISOString(),
 *   lastUpdated: new Date().toISOString()
 * };
 * await saveSessionIssuesState(cwd, state);
 * ```
 */
async function saveSessionIssuesState(
  cwd: string,
  state: SessionIssuesState,
  statePath?: string
): Promise<void> {
  const filePath = getSessionIssuesFilePath(cwd, statePath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Add an issue to a session's tracking data
 *
 * Records that an issue was created during a session. If the session doesn't exist,
 * it will be created. Automatically enforces a 100-session limit and removes oldest
 * sessions when the limit is exceeded.
 * @param sessionId - The session ID
 * @param issue - The issue reference to add
 * @param branch - Current git branch
 * @param repo - Repository name (owner/repo)
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-issues.json (for testing)
 * @returns Promise that resolves when the issue is added
 * @example
 * ```typescript
 * import { addIssueToSession } from './session-issues.js';
 *
 * await addIssueToSession(
 *   'session-abc-123',
 *   {
 *     repo: 'owner/repo',
 *     number: 42,
 *     title: 'Fix authentication bug',
 *     url: 'https://github.com/owner/repo/issues/42',
 *     createdAt: new Date().toISOString()
 *   },
 *   '123-feature/auth',
 *   'owner/repo',
 *   '/path/to/project'
 * );
 * ```
 */
export async function addIssueToSession(
  sessionId: string,
  issue: IssueReference,
  branch: string,
  repo: string,
  cwd: string,
  statePath?: string
): Promise<void> {
  let state = await loadSessionIssuesState(cwd, statePath);

  // Get or create session entry
  if (!state[sessionId]) {
    state[sessionId] = {
      sessionId,
      branch,
      repo,
      issuesCreated: [],
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
  }

  // Add issue to session
  state[sessionId].issuesCreated.push(issue);
  state[sessionId].lastUpdated = new Date().toISOString();

  // Limit to last 100 sessions
  const sessionIds = Object.keys(state);
  if (sessionIds.length > 100) {
    // Sort by startedAt, keep newest 100
    const sorted = sessionIds
      .map((id) => ({ id, startedAt: state[id].startedAt }))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 100);

    const newState: SessionIssuesState = {};
    for (const { id } of sorted) {
      newState[id] = state[id];
    }
    state = newState;
  }

  await saveSessionIssuesState(cwd, state, statePath);
}

/**
 * Get all issues created during a specific session
 *
 * Retrieves the list of issues created during a session. Returns an empty array
 * if the session doesn't exist or has no issues.
 * @param sessionId - The session ID to query
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-issues.json (for testing)
 * @returns Array of issue references
 * @example
 * ```typescript
 * import { getSessionIssues } from './session-issues.js';
 *
 * const issues = await getSessionIssues('session-abc-123', '/path/to/project');
 * console.log(`Session created ${issues.length} issues`);
 * for (const issue of issues) {
 *   console.log(`#${issue.number}: ${issue.title}`);
 * }
 * ```
 */
export async function getSessionIssues(
  sessionId: string,
  cwd: string,
  statePath?: string
): Promise<IssueReference[]> {
  const state = await loadSessionIssuesState(cwd, statePath);
  return state[sessionId]?.issuesCreated || [];
}

/**
 * Clean up old sessions from state file
 *
 * Removes sessions older than the specified retention period. This helps keep
 * the state file size manageable.
 * @param cwd - The working directory where logs are stored
 * @param retentionDays - Number of days to retain sessions (default: 30)
 * @param statePath - Optional custom path for session-issues.json (for testing)
 * @returns Promise that resolves when cleanup is complete
 * @example
 * ```typescript
 * import { cleanupOldSessions } from './session-issues.js';
 *
 * // Remove sessions older than 30 days
 * await cleanupOldSessions('/path/to/project', 30);
 * ```
 */
export async function cleanupOldSessions(
  cwd: string,
  retentionDays: number = 30,
  statePath?: string
): Promise<void> {
  const state = await loadSessionIssuesState(cwd, statePath);
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let modified = false;
  const newState: SessionIssuesState = {};

  for (const [sessionId, session] of Object.entries(state)) {
    const sessionTime = new Date(session.startedAt).getTime();
    if (sessionTime >= cutoffTime) {
      newState[sessionId] = session;
    } else {
      modified = true;
    }
  }

  if (modified) {
    await saveSessionIssuesState(cwd, newState, statePath);
  }
}

// ============================================================================
// Issue Discovery
// ============================================================================

/**
 * Format a timestamp as a human-readable age
 * @param timestamp - ISO timestamp
 * @returns Human-readable age string
 * @example
 * ```typescript
 * formatAge('2024-01-09T10:00:00Z');  // "2h ago"
 * formatAge('2024-01-08T10:00:00Z');  // "Yesterday"
 * formatAge('2024-01-02T10:00:00Z');  // "7 days ago"
 * ```
 */
function formatAge(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const hours = Math.floor(diff / (60 * 60 * 1000));

  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;

  return new Date(timestamp).toLocaleDateString();
}

/**
 * Find related issues from previous sessions
 *
 * Discovers issues from previous sessions that are relevant to the current session
 * using multiple strategies:
 *
 * 1. **High Priority (Same Branch Family)**: Issues from branches with the same
 *    numeric prefix (e.g., `123-feature/auth` and `123-fix/bug` are related)
 *
 * 2. **Medium Priority (Same Repository)**: Issues from the same repository
 *    within the last 7 days
 *
 * Results are deduplicated by issue number and sorted by relevance then recency.
 * @param currentBranch - Current git branch name
 * @param currentRepo - Current repository name (owner/repo)
 * @param currentSessionId - Current session ID (to exclude from results)
 * @param cwd - The working directory where logs are stored
 * @param statePath - Optional custom path for session-issues.json (for testing)
 * @returns Array of related issues with relevance scoring
 * @example
 * ```typescript
 * import { findRelatedIssues } from './session-issues.js';
 *
 * const relatedIssues = await findRelatedIssues(
 *   '123-fix/auth-bug',
 *   'owner/repo',
 *   'current-session-id',
 *   '/path/to/project'
 * );
 *
 * for (const issue of relatedIssues) {
 *   console.log(`[${issue.relevance}] #${issue.number}: ${issue.title}`);
 *   console.log(`  ${issue.reason} • ${issue.sessionAge}`);
 * }
 * ```
 */
export async function findRelatedIssues(
  currentBranch: string,
  currentRepo: string,
  currentSessionId: string,
  cwd: string,
  statePath?: string
): Promise<RelatedIssue[]> {
  const state = await loadSessionIssuesState(cwd, statePath);
  const relatedIssues: RelatedIssue[] = [];
  const seenIssues = new Set<number>();

  // STRATEGY 1: Same branch family (high relevance)
  // Extract prefix: "123-feature/auth" → "123"
  const branchPrefixMatch = currentBranch.match(/^(\d+)-/);
  const branchPrefix = branchPrefixMatch ? branchPrefixMatch[1] : null;

  if (branchPrefix) {
    for (const [sid, session] of Object.entries(state)) {
      if (sid === currentSessionId) continue;

      const sessionPrefix = session.branch.match(/^(\d+)-/)?.[1];
      if (sessionPrefix === branchPrefix) {
        for (const issue of session.issuesCreated) {
          if (seenIssues.has(issue.number)) continue;
          seenIssues.add(issue.number);

          relatedIssues.push({
            ...issue,
            relevance: 'high',
            reason: `Same branch family: ${session.branch}`,
            sessionAge: formatAge(session.startedAt),
          });
        }
      }
    }
  }

  // STRATEGY 2: Same repository (medium relevance)
  // Only last 7 days
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const [sid, session] of Object.entries(state)) {
    if (sid === currentSessionId) continue;
    if (session.repo !== currentRepo) continue;
    if (new Date(session.startedAt).getTime() < weekAgo) continue;

    for (const issue of session.issuesCreated) {
      if (seenIssues.has(issue.number)) continue;
      seenIssues.add(issue.number);

      relatedIssues.push({
        ...issue,
        relevance: 'medium',
        reason: `Same repository: ${currentRepo}`,
        sessionAge: formatAge(session.startedAt),
      });
    }
  }

  // Sort by relevance then recency
  return relatedIssues.sort((a, b) => {
    if (a.relevance !== b.relevance) {
      return a.relevance === 'high' ? -1 : 1;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
