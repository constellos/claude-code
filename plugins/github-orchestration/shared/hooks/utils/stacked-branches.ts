/**
 * Stacked branches state management for subagent isolation workflow
 *
 * Manages branch isolation state for the stacked PR workflow where each subagent
 * works on an isolated branch that gets automatically pushed, PR'd, and merged.
 *
 * State file: .claude/logs/stacked-branches.json
 *
 * @module stacked-branches
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand, checkPRExists } from './ci-status.js';

// ============================================================================
// Constants
// ============================================================================

const LOGS_DIR = '.claude/logs';
const STACKED_BRANCHES_FILE = 'stacked-branches.json';
const SESSION_CONFIG_FILE = 'session-config.json';

/** Agent types that should not create branches (read-only agents) */
const SKIP_AGENT_TYPES = ['Explore', 'Plan'];

// ============================================================================
// Types
// ============================================================================

/**
 * Entry tracking a stacked branch for a subagent
 */
export interface StackedBranchEntry {
  /** Subagent ID that created this branch */
  agentId: string;
  /** Session ID of parent session */
  parentSessionId: string;
  /** Branch name created for subagent */
  branchName: string;
  /** Base branch (parent session's current branch) */
  baseBranch: string;
  /** Timestamp of branch creation */
  createdAt: string;
  /** PR number after creation (null until PR exists) */
  prNumber: number | null;
  /** PR URL */
  prUrl: string | null;
  /** Branch status */
  status: 'active' | 'pr-created' | 'ci-pending' | 'merged' | 'failed';
  /** Files modified by subagent */
  modifiedFiles: string[];
  /** Commit SHA on subagent branch */
  commitSha: string | null;
  /** Error message if status is 'failed' */
  error?: string;
}

/**
 * Complete stacked branches state
 */
export interface StackedBranchesState {
  /** Map of agent IDs to their branch entries */
  entries: { [agentId: string]: StackedBranchEntry };
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Session configuration for stacked PR mode
 */
export interface SessionConfig {
  /** Whether stacked PR mode is enabled */
  stackedPrMode?: boolean;
  /** Stacked PR configuration options */
  stackedPrConfig?: {
    /** Wait for CI before resuming (default: true) */
    waitForCI?: boolean;
    /** Wait for auto-merge before resuming (default: true) */
    waitForMerge?: boolean;
    /** Agent types to skip (default: ['Explore', 'Plan']) */
    skipAgentTypes?: string[];
  };
}

// ============================================================================
// File Path Management
// ============================================================================

/**
 * Get the path to stacked-branches.json
 */
function getStackedBranchesPath(cwd: string): string {
  return path.join(cwd, LOGS_DIR, STACKED_BRANCHES_FILE);
}

/**
 * Get the path to session-config.json
 */
function getSessionConfigPath(cwd: string): string {
  return path.join(cwd, LOGS_DIR, SESSION_CONFIG_FILE);
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Load stacked branches state from disk
 *
 * @param cwd - Working directory
 * @returns Current stacked branches state
 */
export async function loadStackedBranchesState(cwd: string): Promise<StackedBranchesState> {
  const filePath = getStackedBranchesPath(cwd);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      entries: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Save stacked branches state to disk
 *
 * @param cwd - Working directory
 * @param state - State to save
 */
export async function saveStackedBranchesState(
  cwd: string,
  state: StackedBranchesState
): Promise<void> {
  const filePath = getStackedBranchesPath(cwd);
  const stateDir = path.dirname(filePath);

  await fs.mkdir(stateDir, { recursive: true });

  state.updatedAt = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Create a new stacked branch entry
 *
 * @param cwd - Working directory
 * @param entry - Entry to create
 */
export async function createStackedBranchEntry(
  cwd: string,
  entry: StackedBranchEntry
): Promise<void> {
  const state = await loadStackedBranchesState(cwd);
  state.entries[entry.agentId] = entry;
  await saveStackedBranchesState(cwd, state);
}

/**
 * Update an existing stacked branch entry
 *
 * @param cwd - Working directory
 * @param agentId - Agent ID to update
 * @param updates - Partial updates to apply
 */
export async function updateStackedBranchEntry(
  cwd: string,
  agentId: string,
  updates: Partial<Omit<StackedBranchEntry, 'agentId'>>
): Promise<void> {
  const state = await loadStackedBranchesState(cwd);

  if (state.entries[agentId]) {
    state.entries[agentId] = {
      ...state.entries[agentId],
      ...updates,
    };
    await saveStackedBranchesState(cwd, state);
  }
}

/**
 * Get a stacked branch entry by agent ID
 *
 * @param cwd - Working directory
 * @param agentId - Agent ID to look up
 * @returns Entry if found, null otherwise
 */
export async function getStackedBranchEntry(
  cwd: string,
  agentId: string
): Promise<StackedBranchEntry | null> {
  const state = await loadStackedBranchesState(cwd);
  return state.entries[agentId] || null;
}

/**
 * Remove a stacked branch entry
 *
 * @param cwd - Working directory
 * @param agentId - Agent ID to remove
 */
export async function removeStackedBranchEntry(
  cwd: string,
  agentId: string
): Promise<void> {
  const state = await loadStackedBranchesState(cwd);
  delete state.entries[agentId];
  await saveStackedBranchesState(cwd, state);
}

/**
 * Get all active stacked branch entries
 *
 * @param cwd - Working directory
 * @returns Array of active entries
 */
export async function getActiveStackedBranches(
  cwd: string
): Promise<StackedBranchEntry[]> {
  const state = await loadStackedBranchesState(cwd);
  return Object.values(state.entries).filter((e) => e.status === 'active');
}

// ============================================================================
// Session Configuration
// ============================================================================

/**
 * Load session configuration
 *
 * @param cwd - Working directory
 * @returns Session config or null if not found
 */
export async function loadSessionConfig(cwd: string): Promise<SessionConfig | null> {
  const filePath = getSessionConfigPath(cwd);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save session configuration
 *
 * @param cwd - Working directory
 * @param config - Config to save
 */
export async function saveSessionConfig(
  cwd: string,
  config: SessionConfig
): Promise<void> {
  const filePath = getSessionConfigPath(cwd);
  const stateDir = path.dirname(filePath);

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
}

// ============================================================================
// Stacked PR Mode Detection
// ============================================================================

/**
 * Check if stacked PR mode is enabled for a subagent
 *
 * Detection order (Phase 1 + Phase 2):
 * 1. Environment variable: CLAUDE_STACKED_PR=true
 * 2. Session config: .claude/logs/session-config.json
 * 3. Auto-detect: current branch has an open PR (Phase 2)
 *
 * @param input - SubagentStart input
 * @returns Whether stacked PR mode is enabled
 */
export async function isStackedPRModeEnabled(input: {
  agent_type: string;
  cwd: string;
}): Promise<boolean> {
  // Check if agent type should be skipped
  const skipTypes = SKIP_AGENT_TYPES;
  if (skipTypes.includes(input.agent_type)) {
    return false;
  }

  // Phase 1: Check environment variable
  if (process.env.CLAUDE_STACKED_PR === 'true') {
    return true;
  }

  // Phase 1: Check session config
  const config = await loadSessionConfig(input.cwd);
  if (config?.stackedPrMode) {
    return true;
  }

  // Phase 2: Auto-detect - check if current branch has an open PR
  const currentBranch = await getCurrentBranch(input.cwd);
  if (currentBranch) {
    const prCheck = await checkPRExists(currentBranch, input.cwd);
    if (prCheck.exists) {
      return true; // Current branch has open PR → auto-enable stacked mode
    }
  }

  return false;
}

/**
 * Get agent types that should be skipped for stacked PR mode
 *
 * @param cwd - Working directory
 * @returns Array of agent type names to skip
 */
export async function getSkipAgentTypes(cwd: string): Promise<string[]> {
  const config = await loadSessionConfig(cwd);
  return config?.stackedPrConfig?.skipAgentTypes || SKIP_AGENT_TYPES;
}

// ============================================================================
// Git Operations
// ============================================================================

/**
 * Get the current git branch name
 *
 * @param cwd - Working directory
 * @returns Branch name or null if not in a git repo
 */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  return result.success ? result.stdout : null;
}

/**
 * Generate a branch name for a subagent
 *
 * Format: {baseBranch}-subagent-{shortAgentId}
 *
 * @param baseBranch - Base branch name
 * @param agentId - Agent ID
 * @returns Generated branch name
 */
export function generateSubagentBranchName(baseBranch: string, agentId: string): string {
  // Use first 8 chars of agent ID for brevity
  const shortId = agentId.slice(0, 8);
  return `${baseBranch}-subagent-${shortId}`;
}

/**
 * Create and checkout a new branch
 *
 * @param cwd - Working directory
 * @param branchName - Branch name to create
 * @param baseBranch - Base branch to create from
 * @returns Success result with error message if failed
 */
export async function createAndCheckoutBranch(
  cwd: string,
  branchName: string,
  baseBranch: string
): Promise<{ success: boolean; error?: string }> {
  // Create branch from base
  const createResult = await execCommand(
    `git checkout -b "${branchName}" "${baseBranch}"`,
    cwd
  );

  if (!createResult.success) {
    return {
      success: false,
      error: `Failed to create branch: ${createResult.stderr}`,
    };
  }

  return { success: true };
}

/**
 * Checkout an existing branch
 *
 * @param cwd - Working directory
 * @param branchName - Branch to checkout
 * @returns Success result
 */
export async function checkoutBranch(
  cwd: string,
  branchName: string
): Promise<{ success: boolean; error?: string }> {
  const result = await execCommand(`git checkout "${branchName}"`, cwd);

  if (!result.success) {
    return {
      success: false,
      error: `Failed to checkout branch: ${result.stderr}`,
    };
  }

  return { success: true };
}

/**
 * Push branch to remote
 *
 * @param cwd - Working directory
 * @param branchName - Branch to push
 * @returns Success result with error message if failed
 */
export async function pushBranch(
  cwd: string,
  branchName: string
): Promise<{ success: boolean; error?: string }> {
  const result = await execCommand(
    `git push -u origin "${branchName}"`,
    cwd,
    60000 // 60s timeout for push
  );

  if (!result.success) {
    return {
      success: false,
      error: `Failed to push branch: ${result.stderr}`,
    };
  }

  return { success: true };
}

/**
 * Delete a local branch
 *
 * @param cwd - Working directory
 * @param branchName - Branch to delete
 * @returns Success result
 */
export async function deleteLocalBranch(
  cwd: string,
  branchName: string
): Promise<{ success: boolean; error?: string }> {
  const result = await execCommand(`git branch -D "${branchName}"`, cwd);

  if (!result.success) {
    return {
      success: false,
      error: `Failed to delete branch: ${result.stderr}`,
    };
  }

  return { success: true };
}

/**
 * Pull latest changes from remote
 *
 * @param cwd - Working directory
 * @param branchName - Branch to pull
 * @returns Success result
 */
export async function pullLatest(
  cwd: string,
  branchName: string
): Promise<{ success: boolean; error?: string }> {
  const result = await execCommand(`git pull origin "${branchName}"`, cwd, 60000);

  if (!result.success) {
    return {
      success: false,
      error: `Failed to pull: ${result.stderr}`,
    };
  }

  return { success: true };
}

/**
 * Stage and commit files
 *
 * @param cwd - Working directory
 * @param files - Files to stage
 * @param message - Commit message
 * @returns Commit SHA or error
 */
export async function stageAndCommit(
  cwd: string,
  files: string[],
  message: string
): Promise<{ success: boolean; commitSha?: string; error?: string }> {
  // Stage files
  for (const file of files) {
    const addResult = await execCommand(`git add "${file}"`, cwd);
    if (!addResult.success) {
      // Try git rm for deleted files
      await execCommand(`git rm "${file}"`, cwd);
    }
  }

  // Check if anything staged
  const statusResult = await execCommand('git diff --cached --name-only', cwd);
  if (!statusResult.stdout) {
    return { success: false, error: 'No changes staged for commit' };
  }

  // Commit with properly escaped message
  const escapedMessage = message.replace(/'/g, "'\\''");
  const commitResult = await execCommand(`git commit -m '${escapedMessage}'`, cwd);

  if (!commitResult.success) {
    return {
      success: false,
      error: `Failed to commit: ${commitResult.stderr}`,
    };
  }

  // Get commit SHA
  const shaResult = await execCommand('git rev-parse --short HEAD', cwd);
  const commitSha = shaResult.success ? shaResult.stdout : undefined;

  return { success: true, commitSha };
}

// ============================================================================
// PR Operations
// ============================================================================

/**
 * Create a PR with auto-merge enabled
 *
 * @param cwd - Working directory
 * @param options - PR options
 * @returns PR number and URL
 */
export async function createPRWithAutoMerge(
  cwd: string,
  options: {
    head: string;
    base: string;
    title: string;
    body: string;
  }
): Promise<{ success: boolean; prNumber?: number; prUrl?: string; error?: string }> {
  // Create PR using heredoc for proper body handling
  // gh pr create outputs the PR URL on success
  const createResult = await execCommand(
    `gh pr create --head "${options.head}" --base "${options.base}" --title "${options.title.replace(/"/g, '\\"')}" --body "$(cat <<'PRBODYEOF'
${options.body}
PRBODYEOF
)"`,
    cwd,
    60000
  );

  if (!createResult.success) {
    return {
      success: false,
      error: `Failed to create PR: ${createResult.stderr}`,
    };
  }

  // Parse PR URL from stdout (gh pr create prints the URL)
  const prUrl = createResult.stdout.trim();

  // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
  if (!prNumberMatch) {
    return {
      success: false,
      error: `Failed to parse PR number from URL: ${prUrl}`,
    };
  }

  const prNumber = parseInt(prNumberMatch[1], 10);

  // Enable auto-merge
  const mergeResult = await execCommand(
    `gh pr merge ${prNumber} --auto --squash`,
    cwd,
    30000
  );

  if (!mergeResult.success) {
    // Auto-merge might fail if not enabled for repo - that's OK, log warning
    console.error(`Warning: Could not enable auto-merge: ${mergeResult.stderr}`);
  }

  return { success: true, prNumber, prUrl };
}

/**
 * Wait for a PR to be merged
 *
 * @param cwd - Working directory
 * @param prNumber - PR number
 * @param timeout - Timeout in milliseconds (default: 10 minutes)
 * @returns Success result
 */
export async function waitForPRMerge(
  cwd: string,
  prNumber: number,
  timeout = 600000
): Promise<{ success: boolean; error?: string }> {
  const startTime = Date.now();
  const pollInterval = 10000; // 10 seconds

  while (Date.now() - startTime < timeout) {
    const result = await execCommand(
      `gh pr view ${prNumber} --json state,merged`,
      cwd
    );

    if (result.success) {
      try {
        const data = JSON.parse(result.stdout);

        if (data.merged) {
          return { success: true };
        }

        if (data.state === 'CLOSED' && !data.merged) {
          return {
            success: false,
            error: `PR #${prNumber} was closed without merging`,
          };
        }
      } catch {
        // Parse error, continue polling
      }
    }

    // Sleep before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return {
    success: false,
    error: `Timeout waiting for PR #${prNumber} to merge (${Math.round(timeout / 60000)} minutes)`,
  };
}

// ============================================================================
// Cleanup Operations
// ============================================================================

/**
 * Clean up a subagent branch after workflow completion or failure
 *
 * @param cwd - Working directory
 * @param entry - Stacked branch entry to clean up
 */
export async function cleanupSubagentBranch(
  cwd: string,
  entry: StackedBranchEntry
): Promise<void> {
  // Ensure we're on base branch
  await checkoutBranch(cwd, entry.baseBranch);

  // Delete local subagent branch if it exists
  await deleteLocalBranch(cwd, entry.branchName);

  // Remove from state
  await removeStackedBranchEntry(cwd, entry.agentId);
}
