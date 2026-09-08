/**
 * GitHub comment utilities for Stop hook
 *
 * Provides utilities for:
 * - Checking if a session comment exists on a GitHub issue
 * - Posting session progress comments with session ID markers
 * - Discovering the linked issue number for a branch
 *
 * Session comments include a hidden HTML marker that allows the Stop hook
 * to detect whether progress has been documented for a given session.
 * @module github-comments
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execAsync = promisify(exec);

// ============================================================================
// Constants
// ============================================================================

const COMMENT_MARKER_PREFIX = '<!-- claude-session: ';
const COMMENT_MARKER_SUFFIX = ' -->';
const EXPLORE_MARKER_PREFIX = '<!-- claude-explore: ';
const EXPLORE_MARKER_SUFFIX = ' -->';
const PLAN_UPDATE_MARKER_PREFIX = '<!-- plan-update-v';
const PLAN_UPDATE_MARKER_SUFFIX = ' -->';

// ============================================================================
// Types
// ============================================================================

/**
 * Plan issue state tracking
 */
interface PlanIssueState {
  /**
   * Map of session IDs to issue metadata
   */
  [sessionId: string]: {
    /**
     * Path to the plan file
     */
    planPath: string;
    /**
     * GitHub issue number
     */
    issueNumber: number;
    /**
     * Full GitHub issue URL
     */
    issueUrl: string;
    /**
     * Git branch name
     */
    branch: string;
    /**
     * ISO timestamp when issue was created
     */
    createdAt: string;
    /**
     * ISO timestamp of last update
     */
    lastUpdated: string;
  };
}

/**
 * GitHub issue with comments
 */
interface GitHubIssue {
  /**
   * Issue number
   */
  number: number;
  /**
   * Issue title
   */
  title: string;
  /**
   * Issue body content
   */
  body: string;
  /**
   * Issue comments
   */
  comments?: Array<{
    /**
     * Comment author
     */
    author: { login: string };
    /**
     * Comment body
     */
    body: string;
    /**
     * ISO timestamp when comment was created
     */
    createdAt: string;
  }>;
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Execute a shell command
 * @param command - Shell command to execute
 * @param cwd - Working directory
 * @returns Command result with success flag, stdout, and stderr
 * @example
 * ```typescript
 * const result = await execCommand('git rev-parse --abbrev-ref HEAD', '/path/to/project');
 * if (result.success) {
 *   console.log('Branch:', result.stdout);
 * }
 * ```
 */
async function execCommand(
  command: string,
  cwd: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30000 });
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
 * Execute gh command with stdin for large body content
 *
 * Uses spawn + stdin to avoid shell escaping issues when passing
 * markdown content with special characters.
 * @param args - Arguments to pass to gh command
 * @param stdin - Content to write to stdin
 * @param cwd - Working directory
 * @returns Command result with success flag, stdout, and stderr
 * @example
 * ```typescript
 * const result = await execGhWithStdin(
 *   ['issue', 'comment', '123', '--body-file', '-'],
 *   'This is my comment content',
 *   '/path/to/project'
 * );
 * ```
 */
async function execGhWithStdin(
  args: string[],
  stdin: string,
  cwd: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { cwd });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        stdout: '',
        stderr: error.message,
      });
    });

    // Write body to stdin and close
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

// ============================================================================
// Issue Discovery
// ============================================================================

/**
 * Load plan issue state from disk
 * @param cwd - Working directory
 * @returns Plan issue state map
 * @example
 * ```typescript
 * const state = await loadPlanIssueState('/path/to/project');
 * const sessionInfo = state['session-id'];
 * if (sessionInfo) {
 *   console.log('Issue number:', sessionInfo.issueNumber);
 * }
 * ```
 */
async function loadPlanIssueState(cwd: string): Promise<PlanIssueState> {
  const stateFile = path.join(cwd, '.claude', 'logs', 'plan-issues.json');

  try {
    const data = await fs.readFile(stateFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    // File doesn't exist yet or is invalid
    return {};
  }
}

/**
 * Parse issue number from branch name
 *
 * Extracts issue number from branch names like:
 * - issue-123-description
 * - feature/issue-456
 * - 789-fix-bug
 * @param branch - Git branch name
 * @returns Issue number or null if not found
 * @example
 * ```typescript
 * const issueNum = parseIssueFromBranch('issue-123-add-feature');
 * // Returns: 123
 *
 * const noIssue = parseIssueFromBranch('main');
 * // Returns: null
 * ```
 */
function parseIssueFromBranch(branch: string): number | null {
  // Try pattern: issue-123-...
  const issueMatch = branch.match(/issue[_-](\d+)/i);
  if (issueMatch) {
    return parseInt(issueMatch[1], 10);
  }

  // Try pattern: 123-...
  const numMatch = branch.match(/^(\d+)[_-]/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }

  return null;
}

/**
 * Get linked issue number for current branch
 *
 * Discovers issue number using cascading fallback strategy:
 * 1. Check plan-issues.json state file (by session ID and branch name)
 * 2. Parse from branch name pattern (issue-123-...)
 * 3. Search GitHub for issues mentioning the branch
 * @param branch - Git branch name
 * @param cwd - Working directory
 * @returns Issue number or null if not found
 * @example
 * ```typescript
 * const issueNumber = await getLinkedIssueNumber('issue-57-stop-hook', '/path/to/project');
 * if (issueNumber) {
 *   console.log('Linked to issue #' + issueNumber);
 * }
 * ```
 */
export async function getLinkedIssueNumber(
  branch: string,
  cwd: string
): Promise<number | null> {
  // STRATEGY 1: Check plan-issues.json state file
  const state = await loadPlanIssueState(cwd);

  // Find by branch name across all sessions
  for (const sessionState of Object.values(state)) {
    if (sessionState.branch === branch) {
      return sessionState.issueNumber;
    }
  }

  // STRATEGY 2: Parse from branch name
  const parsedIssue = parseIssueFromBranch(branch);
  if (parsedIssue !== null) {
    // Verify issue exists
    const verifyResult = await execCommand(`gh issue view ${parsedIssue} --json number`, cwd);
    if (verifyResult.success) {
      return parsedIssue;
    }
  }

  // STRATEGY 3: Search GitHub for issues mentioning the branch
  const searchResult = await execCommand(
    `gh issue list --search "in:body ${branch}" --json number --limit 1`,
    cwd
  );

  if (searchResult.success && searchResult.stdout) {
    try {
      const issues = JSON.parse(searchResult.stdout);
      if (issues.length > 0) {
        return issues[0].number;
      }
    } catch {
      // Parse error
    }
  }

  return null;
}

// ============================================================================
// Comment Management
// ============================================================================

/**
 * Create session comment marker
 * @param sessionId - Session ID to embed in marker
 * @returns HTML comment marker
 * @example
 * ```typescript
 * const marker = createSessionMarker('abc-123');
 * // Returns: '<!-- claude-session: abc-123 -->'
 * ```
 */
function createSessionMarker(sessionId: string): string {
  return `${COMMENT_MARKER_PREFIX}${sessionId}${COMMENT_MARKER_SUFFIX}`;
}

/**
 * Check if a comment contains a session marker
 *
 * Uses two validation strategies for robustness:
 * 1. Exact HTML marker match: `<!-- claude-session: SESSION_ID -->` (preferred)
 * 2. Plain session ID substring match (lenient fallback)
 *
 * The lenient fallback prevents infinite blocking loops when agents post
 * comments without the exact HTML marker format. Session IDs are unique
 * enough (UUID-like strings) that false positives are extremely unlikely.
 *
 * @param commentBody - Comment body text
 * @param sessionId - Session ID to search for
 * @returns True if comment contains the session marker or plain session ID
 * @example
 * ```typescript
 * // Exact marker (preferred, backward compatible)
 * commentHasSessionMarker(
 *   '<!-- claude-session: abc-123 -->\n\nMy comment',
 *   'abc-123'
 * );
 * // Returns: true
 *
 * // Plain session ID (lenient fallback)
 * commentHasSessionMarker(
 *   'Session abc-123 completed work',
 *   'abc-123'
 * );
 * // Returns: true
 * ```
 */
function commentHasSessionMarker(commentBody: string, sessionId: string): boolean {
  // Strategy 1: Check for exact HTML marker (backward compatible, preferred)
  const marker = createSessionMarker(sessionId);
  if (commentBody.includes(marker)) {
    return true;
  }

  // Strategy 2: Check for plain session ID (lenient fallback)
  // Session IDs are unique/long enough that false positives are unlikely
  // This prevents infinite blocking loops when agents don't include exact marker
  if (commentBody.includes(sessionId)) {
    return true;
  }

  return false;
}

/**
 * Check if a session comment exists on a GitHub issue
 *
 * Fetches all comments for the issue and searches for the session ID marker.
 * @param issueNumber - GitHub issue number
 * @param sessionId - Session ID to search for
 * @param cwd - Working directory
 * @returns True if a comment with the session marker exists
 * @example
 * ```typescript
 * import { hasCommentForSession } from './github-comments.js';
 *
 * const hasComment = await hasCommentForSession(57, 'session-abc-123', '/path/to/project');
 * if (hasComment) {
 *   console.log('Progress already documented for this session');
 * }
 * ```
 */
export async function hasCommentForSession(
  issueNumber: number,
  sessionId: string,
  cwd: string
): Promise<boolean> {
  // Fetch issue with comments
  const result = await execCommand(
    `gh issue view ${issueNumber} --json comments`,
    cwd
  );

  if (!result.success) {
    return false;
  }

  try {
    const issue: GitHubIssue = JSON.parse(result.stdout);

    if (!issue.comments || issue.comments.length === 0) {
      return false;
    }

    // Search for session marker in comments
    return issue.comments.some((comment) =>
      commentHasSessionMarker(comment.body, sessionId)
    );
  } catch {
    // Parse error
    return false;
  }
}

/**
 * Post a session progress comment to a GitHub issue
 *
 * Creates a formatted comment with:
 * - Hidden session ID marker for detection
 * - Session metadata (ID, branch, timestamp)
 * - User-provided content
 * @param issueNumber - GitHub issue number
 * @param sessionId - Session ID
 * @param content - Comment content (markdown)
 * @param branch - Current git branch
 * @param cwd - Working directory
 * @returns True if comment was posted successfully
 * @example
 * ```typescript
 * import { postSessionComment } from './github-comments.js';
 *
 * const posted = await postSessionComment(
 *   57,
 *   'session-abc-123',
 *   'Completed hook implementation and tests',
 *   'issue-57-stop-hook',
 *   '/path/to/project'
 * );
 * if (posted) {
 *   console.log('Comment posted successfully');
 * }
 * ```
 */
export async function postSessionComment(
  issueNumber: number,
  sessionId: string,
  content: string,
  branch: string,
  cwd: string
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const marker = createSessionMarker(sessionId);

  const commentBody = `${marker}

## 🤖 Claude Session Progress

**Session ID:** \`${sessionId}\`
**Branch:** \`${branch}\`
**Timestamp:** ${timestamp}

${content}

---
*Posted automatically via Stop hook*`;

  const result = await execGhWithStdin(
    ['issue', 'comment', issueNumber.toString(), '--body-file', '-'],
    commentBody,
    cwd
  );

  return result.success;
}

/**
 * Create explore comment marker
 * @param taskId - Unique task identifier (e.g., tool_use_id)
 * @returns HTML comment marker
 */
function createExploreMarker(taskId: string): string {
  return `${EXPLORE_MARKER_PREFIX}${taskId}${EXPLORE_MARKER_SUFFIX}`;
}

/**
 * Check if an explore comment already exists for a task
 *
 * @param issueNumber - GitHub issue number
 * @param taskId - Unique task identifier
 * @param cwd - Working directory
 * @returns True if a comment with the explore marker exists
 */
export async function hasExploreComment(
  issueNumber: number,
  taskId: string,
  cwd: string
): Promise<boolean> {
  const result = await execCommand(
    `gh issue view ${issueNumber} --json comments`,
    cwd
  );

  if (!result.success) {
    return false;
  }

  try {
    const issue: GitHubIssue = JSON.parse(result.stdout);
    if (!issue.comments || issue.comments.length === 0) {
      return false;
    }

    const marker = createExploreMarker(taskId);
    return issue.comments.some((comment) => comment.body.includes(marker));
  } catch {
    return false;
  }
}

/**
 * Post an Explore agent findings comment to a GitHub issue
 *
 * Creates a formatted comment with:
 * - Hidden task ID marker for duplicate detection
 * - Query/prompt that was explored
 * - Collapsible details with full findings
 *
 * @param issueNumber - GitHub issue number
 * @param taskId - Unique task identifier (tool_use_id)
 * @param query - The original explore query/prompt
 * @param findings - The agent's findings/output text
 * @param branch - Current git branch
 * @param cwd - Working directory
 * @returns True if comment was posted successfully
 *
 * @example
 * ```typescript
 * const posted = await postExploreComment(
 *   212,
 *   'toolu_abc123',
 *   'Find all API endpoints in the codebase',
 *   'Found 15 API endpoints across 8 files...',
 *   'issue-212-explore',
 *   '/path/to/project'
 * );
 * ```
 */
export async function postExploreComment(
  issueNumber: number,
  taskId: string,
  query: string,
  findings: string,
  branch: string,
  cwd: string
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const marker = createExploreMarker(taskId);

  // Truncate query if too long
  const displayQuery = query.length > 200 ? query.slice(0, 197) + '...' : query;

  const commentBody = `${marker}

## 🔍 Explore Agent Findings

**Query**: ${displayQuery}
**Branch**: \`${branch}\`
**Timestamp**: ${timestamp}

<details>
<summary>View findings</summary>

${findings}

</details>

---
*Posted automatically via SubagentStop hook*`;

  const result = await execGhWithStdin(
    ['issue', 'comment', issueNumber.toString(), '--body-file', '-'],
    commentBody,
    cwd
  );

  return result.success;
}

/**
 * Post a plan update comment to a GitHub issue
 *
 * Creates a versioned comment that documents when the plan was updated.
 * Each plan edit posts a new comment with an incrementing version number.
 *
 * @param issueNumber - GitHub issue number
 * @param version - Plan version number (1, 2, 3, etc.)
 * @param action - Whether this was 'created' or 'updated'
 * @param planPath - Path to the plan file
 * @param branch - Current git branch
 * @param cwd - Working directory
 * @returns True if comment was posted successfully
 *
 * @example
 * ```typescript
 * const posted = await postPlanUpdateComment(
 *   212,
 *   2,
 *   'updated',
 *   '/home/user/.claude/plans/my-plan.md',
 *   'issue-212-feature',
 *   '/path/to/project'
 * );
 * ```
 */
export async function postPlanUpdateComment(
  issueNumber: number,
  version: number,
  action: 'created' | 'updated',
  planPath: string,
  branch: string,
  cwd: string
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const marker = `${PLAN_UPDATE_MARKER_PREFIX}${version}${PLAN_UPDATE_MARKER_SUFFIX}`;

  const actionEmoji = action === 'created' ? '✨' : '📝';
  const actionText = action === 'created' ? 'Plan created' : 'Plan updated';

  const commentBody = `${marker}

## ${actionEmoji} ${actionText} (v${version})

**Timestamp**: ${timestamp}
**Plan file**: \`${planPath}\`
**Branch**: \`${branch}\`

---
*Plan synced automatically via PostToolUse hook*`;

  const result = await execGhWithStdin(
    ['issue', 'comment', issueNumber.toString(), '--body-file', '-'],
    commentBody,
    cwd
  );

  return result.success;
}
