/**
 * Shared CI status utilities for GitHub CI integration
 *
 * Provides common functions for checking CI status, waiting for checks,
 * extracting preview URLs, and formatting results. Used by:
 * - commit-task-await-ci-status.ts (SubagentStop)
 * - await-pr-status.ts (PostToolUse[Bash])
 * - commit-session-await-ci-status.ts (Stop)
 *
 * @module ci-status
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Maximum output characters for CI status (prevents context bloat) */
const MAX_OUTPUT_CHARS = 500;

/** Default CI check timeout in milliseconds (10 minutes) */
const DEFAULT_TIMEOUT_MS = 600000;


/**
 * Branch sync status result
 */
export interface BranchSyncResult {
  /** Whether branch is in sync with main */
  inSync: boolean;
  /** Number of commits behind main */
  behindCount: number;
  /** Number of commits ahead of main */
  aheadCount: number;
  /** Error message if check failed */
  error?: string;
}

/**
 * Merge conflict check result
 */
export interface MergeConflictResult {
  /** Whether PR has merge conflicts */
  hasConflicts: boolean;
  /** Mergeable state from GitHub */
  mergeableState?: string;
  /** Error message if check failed */
  error?: string;
}

/**
 * Fail-fast CI check result
 */
export interface FailFastResult {
  /** Whether all checks passed */
  success: boolean;
  /** Blocking reason if failed */
  blockReason?: string;
  /** Failed check name if applicable */
  failedCheck?: string;
  /** All check statuses */
  checks: CheckStatus[];
  /** PR number if found */
  prNumber?: number;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Result from a CI check operation
 */
export interface CICheckResult {
  /** Whether all CI checks passed */
  success: boolean;
  /** Combined output from CI checks */
  output: string;
  /** Error message if operation failed */
  error?: string;
}

/**
 * CI run details from GitHub
 */
export interface CIRunDetails {
  /** CI workflow URL */
  url?: string;
  /** CI status (queued, in_progress, completed) */
  status?: string;
  /** CI conclusion (success, failure, cancelled) */
  conclusion?: string;
  /** Workflow name */
  name?: string;
}

/**
 * Individual check status
 */
export interface CheckStatus {
  /** Check name */
  name: string;
  /** Check status emoji */
  emoji: string;
  /** Check status (success, failure, pending) */
  status: string;
  /** Details URL */
  url?: string;
}

/**
 * PR existence check result
 */
export interface PRCheckResult {
  /** Whether PR exists */
  exists: boolean;
  /** PR number if exists */
  prNumber?: number;
  /** PR URL if exists */
  prUrl?: string;
  /** Error message if check failed */
  error?: string;
}

/**
 * Preview URLs extracted from PR
 */
export interface PreviewUrls {
  /** Web app preview URL */
  webUrl?: string;
  /** Marketing app preview URL */
  marketingUrl?: string;
  /** All preview URLs found */
  allUrls: string[];
}

/**
 * Information about an issue linked to a PR
 */
export interface LinkedIssueInfo {
  /** Issue number */
  number: number;
  /** Issue title (if fetched) */
  title?: string;
  /** Full issue URL */
  url: string;
  /** Repository owner/name (extracted from URL) */
  repo: string;
}

/**
 * Supabase preview branch info with dashboard link
 */
export interface SupabasePreview {
  /** Supabase project reference ID */
  ref: string;
  /** API URL: https://{ref}.supabase.co */
  apiUrl: string;
  /** Dashboard URL: https://supabase.com/dashboard/project/{ref} */
  dashboardUrl: string;
  /** Database URL: db.{ref}.supabase.co (if found) */
  dbUrl?: string;
}

/**
 * Grouped preview URLs by provider
 */
export interface GroupedPreviewUrls {
  /** Vercel preview URLs */
  vercel: string[];
  /** Cloudflare Worker/Pages deployment URLs */
  cloudflare: string[];
  /** Supabase preview branches with dashboard links */
  supabase: SupabasePreview[];
}

/**
 * Execute a shell command with timeout
 *
 * @param command - Command to execute
 * @param cwd - Working directory
 * @param timeout - Timeout in milliseconds (default: 30s)
 * @returns Command result with success flag and output
 *
 * @example
 * ```typescript
 * const result = await execCommand('gh pr list', '/path/to/repo');
 * if (result.success) {
 *   console.log(result.stdout);
 * }
 * ```
 */
export async function execCommand(
  command: string,
  cwd: string,
  timeout = 30000
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout });
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
 * Check if a PR exists for the given branch
 *
 * @param branch - Branch name to check
 * @param cwd - Working directory
 * @returns PR check result with number and URL if exists
 *
 * @example
 * ```typescript
 * const prCheck = await checkPRExists('feature-branch', '/path/to/repo');
 * if (prCheck.exists) {
 *   console.log(`PR #${prCheck.prNumber}: ${prCheck.prUrl}`);
 * }
 * ```
 */
export async function checkPRExists(
  branch: string,
  cwd: string
): Promise<PRCheckResult> {
  // Check if gh CLI is available
  const ghCheck = await execCommand('gh --version', cwd);
  if (!ghCheck.success) {
    return { exists: false, error: 'GitHub CLI not installed' };
  }

  // Check if gh is authenticated
  const authCheck = await execCommand('gh auth status', cwd);
  if (!authCheck.success) {
    return { exists: false, error: 'GitHub CLI not authenticated' };
  }

  // List PRs for current branch
  const prListResult = await execCommand(
    `gh pr list --head ${branch} --json number,url --limit 1`,
    cwd
  );

  if (!prListResult.success) {
    return { exists: false, error: `gh pr list failed: ${prListResult.stderr}` };
  }

  try {
    const prs = JSON.parse(prListResult.stdout);
    if (Array.isArray(prs) && prs.length > 0) {
      return {
        exists: true,
        prNumber: prs[0].number,
        prUrl: prs[0].url,
      };
    }
    return { exists: false };
  } catch {
    return { exists: false, error: 'Failed to parse gh output' };
  }
}

/**
 * Get PR number for the current branch
 *
 * @param cwd - Working directory
 * @returns PR number or null if no PR exists
 *
 * @example
 * ```typescript
 * const prNumber = await getPRForCurrentBranch('/path/to/repo');
 * if (prNumber) {
 *   const ciResult = await waitForCIChecks({ prNumber, cwd });
 * }
 * ```
 */
export async function getPRForCurrentBranch(cwd: string): Promise<number | null> {
  const branchResult = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  if (!branchResult.success) {
    return null;
  }

  const prCheck = await checkPRExists(branchResult.stdout, cwd);
  return prCheck.exists ? (prCheck.prNumber ?? null) : null;
}

/**
 * Wait for CI checks to complete on a PR
 *
 * Uses `gh pr checks --watch` to wait for all CI checks to finish.
 * Blocks until all checks complete or timeout is reached.
 *
 * @param options - Wait options
 * @param options.prNumber - PR number to check (required if no commitSha)
 * @param options.commitSha - Commit SHA to check (alternative to prNumber)
 * @param options.timeout - Timeout in milliseconds (default: 10 minutes)
 * @param cwd - Working directory
 * @returns CI check result with success status and output
 *
 * @example
 * ```typescript
 * const result = await waitForCIChecks({ prNumber: 123 }, '/path/to/repo');
 * if (result.success) {
 *   console.log('All CI checks passed!');
 * } else {
 *   console.log('CI failed:', result.output);
 * }
 * ```
 */
export async function waitForCIChecks(
  options: {
    prNumber?: number;
    commitSha?: string;
    timeout?: number;
  },
  cwd: string
): Promise<CICheckResult> {
  const { prNumber, commitSha, timeout = DEFAULT_TIMEOUT_MS } = options;

  if (!prNumber && !commitSha) {
    return { success: false, output: '', error: 'Either prNumber or commitSha required' };
  }

  try {
    // Build command based on what we have
    const target = prNumber ? prNumber.toString() : commitSha!;
    const command = `gh pr checks ${target} --watch`;

    const { stdout, stderr } = await execAsync(command, { cwd, timeout });
    const combinedOutput = `${stdout}\n${stderr}`.trim();

    // Check if all checks passed
    const hasFailures =
      combinedOutput.includes('fail') ||
      combinedOutput.includes('X ') ||
      combinedOutput.includes('cancelled');

    return {
      success: !hasFailures,
      output: combinedOutput,
    };
  } catch (error: unknown) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
    };
    const errorOutput = err.stdout || err.stderr || err.message || 'Unknown error';

    if (err.killed) {
      return {
        success: false,
        output: errorOutput,
        error: `CI check timeout (${Math.round(timeout / 60000)} minutes)`,
      };
    }

    return {
      success: false,
      output: errorOutput,
      error: 'Failed to watch CI checks',
    };
  }
}

/**
 * Get latest CI workflow run details
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @returns CI run details or null if not found
 *
 * @example
 * ```typescript
 * const ciRun = await getLatestCIRun(123, '/path/to/repo');
 * if (ciRun?.conclusion === 'success') {
 *   console.log('CI passed:', ciRun.url);
 * }
 * ```
 */
export async function getLatestCIRun(
  prNumber: number,
  cwd: string
): Promise<CIRunDetails | null> {
  // First, get the PR's HEAD commit SHA to filter CI runs correctly
  const headShaResult = await execCommand(
    `gh pr view ${prNumber} --json headRefOid --jq '.headRefOid'`,
    cwd
  );

  if (!headShaResult.success || !headShaResult.stdout.trim()) {
    // Fallback: if we can't get PR info, return null rather than wrong data
    return null;
  }

  const headSha = headShaResult.stdout.trim();

  // Get CI runs for THIS specific commit, not the most recent run globally
  const result = await execCommand(
    `gh run list --commit ${headSha} --limit 1 --json databaseId,displayTitle,status,conclusion,url`,
    cwd
  );

  if (!result.success) {
    return null;
  }

  try {
    const runs = JSON.parse(result.stdout);
    if (Array.isArray(runs) && runs.length > 0) {
      const run = runs[0];
      return {
        url: run.url,
        status: run.status,
        conclusion: run.conclusion,
        name: run.displayTitle,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch PR comment bodies as an array of strings
 *
 * Consolidates the `gh pr view --json comments` call so multiple
 * extractors can share the same data without redundant API calls.
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @returns Array of comment body strings
 */
export async function fetchPRCommentBodies(
  prNumber: number,
  cwd: string
): Promise<string[]> {
  const result = await execCommand(`gh pr view ${prNumber} --json comments`, cwd);

  if (!result.success) {
    return [];
  }

  try {
    const data = JSON.parse(result.stdout);
    const comments = data.comments || [];
    return comments.map((c: { body?: string }) => c.body || '');
  } catch {
    return [];
  }
}

/**
 * Extract Vercel preview URLs from PR comments
 *
 * Searches PR comments for Vercel bot URLs and categorizes them
 * by app type (web, marketing, etc).
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @param commentBodies - Pre-fetched comment bodies (optional, fetches if not provided)
 * @returns Preview URLs object with categorized URLs
 *
 * @example
 * ```typescript
 * const urls = await extractPreviewUrls(123, '/path/to/repo');
 * if (urls.webUrl) {
 *   console.log('Web preview:', urls.webUrl);
 * }
 * ```
 */
export async function extractPreviewUrls(
  prNumber: number,
  cwd: string,
  commentBodies?: string[]
): Promise<PreviewUrls> {
  const bodies = commentBodies ?? await fetchPRCommentBodies(prNumber, cwd);

  const vercelUrlPattern = /https:\/\/[a-z0-9-]+\.vercel\.app/g;
  const allUrls: string[] = [];

  for (const body of bodies) {
    const matches = body.match(vercelUrlPattern) || [];
    allUrls.push(...matches);
  }

  // Deduplicate URLs
  const uniqueUrls = [...new Set(allUrls)];

  // Identify web and marketing apps by URL pattern
  const webUrl = uniqueUrls.find(
    (url) =>
      url.includes('-web-') || url.includes('web-') || url.match(/web\.vercel\.app/)
  );
  const marketingUrl = uniqueUrls.find(
    (url) =>
      url.includes('-marketing-') ||
      url.includes('marketing-') ||
      url.match(/marketing\.vercel\.app/)
  );

  return {
    webUrl,
    marketingUrl,
    allUrls: uniqueUrls,
  };
}

/**
 * Extract linked issue numbers from PR body (simple version)
 *
 * Parses PR body for GitHub issue-closing keywords like:
 * - Fixes #123, Closes #456, Resolves #789
 * - Full URLs: github.com/owner/repo/issues/123
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @returns Array of linked issue numbers (deduplicated and sorted)
 *
 * @example
 * ```typescript
 * const linkedIssues = await extractLinkedIssuesFromPR(42, '/path/to/repo');
 * // Returns: [123, 456] if PR body contains "Fixes #123" and "Closes #456"
 * ```
 */
export async function extractLinkedIssuesFromPR(
  prNumber: number,
  cwd: string
): Promise<number[]> {
  const linkedIssues = await extractLinkedIssuesWithInfo(prNumber, cwd);
  return linkedIssues.map((issue) => issue.number).sort((a, b) => a - b);
}

/**
 * Extract linked issues with full info from PR body
 *
 * Parses PR body for GitHub issue-closing keywords and returns rich info:
 * - Fixes #123, Closes #456, Resolves #789
 * - Full URLs: github.com/owner/repo/issues/123
 *
 * For #123 references, constructs URL using the PR's repository.
 * For full URLs, extracts the repo from the URL (supports cross-repo links).
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @returns Array of LinkedIssueInfo with number, url, and repo
 *
 * @example
 * ```typescript
 * const linkedIssues = await extractLinkedIssuesWithInfo(42, '/path/to/repo');
 * // Returns: [{ number: 123, url: 'https://github.com/owner/repo/issues/123', repo: 'owner/repo' }]
 * ```
 */
export async function extractLinkedIssuesWithInfo(
  prNumber: number,
  cwd: string
): Promise<LinkedIssueInfo[]> {
  // Get PR body and URL to extract repo info
  const result = await execCommand(
    `gh pr view ${prNumber} --json body,url`,
    cwd
  );

  if (!result.success || !result.stdout) {
    return [];
  }

  let body: string;
  let prUrl: string;
  try {
    const data = JSON.parse(result.stdout);
    body = data.body || '';
    prUrl = data.url || '';
  } catch {
    return [];
  }

  // Extract repo from PR URL: https://github.com/owner/repo/pull/123
  const prRepoMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
  const prRepo = prRepoMatch ? prRepoMatch[1] : '';

  const linkedIssues: Map<string, LinkedIssueInfo> = new Map();

  // Pattern 1: Issue-closing keywords with # reference (same repo)
  // Matches: fix, fixes, fixed, close, closes, closed, resolve, resolves, resolved
  const keywordPattern = /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+#(\d+)/gi;
  let match;
  while ((match = keywordPattern.exec(body)) !== null) {
    const num = parseInt(match[1], 10);
    const url = prRepo ? `https://github.com/${prRepo}/issues/${num}` : '';
    const key = `${prRepo}#${num}`;
    if (!linkedIssues.has(key)) {
      linkedIssues.set(key, {
        number: num,
        url,
        repo: prRepo,
      });
    }
  }

  // Pattern 2: Full GitHub issue URLs (may be cross-repo)
  // Matches: https://github.com/owner/repo/issues/123
  const urlPattern = /https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/g;
  while ((match = urlPattern.exec(body)) !== null) {
    const repo = match[1];
    const num = parseInt(match[2], 10);
    const url = `https://github.com/${repo}/issues/${num}`;
    const key = `${repo}#${num}`;
    if (!linkedIssues.has(key)) {
      linkedIssues.set(key, {
        number: num,
        url,
        repo,
      });
    }
  }

  // Return sorted by repo then number
  return Array.from(linkedIssues.values()).sort((a, b) => {
    if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
    return a.number - b.number;
  });
}

/**
 * Extract Cloudflare Worker/Pages deployment URLs from PR comments
 *
 * Searches PR comments for Cloudflare deployment URLs:
 * - Workers: https://my-worker.workers.dev
 * - Pages: https://my-project.pages.dev
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @param commentBodies - Pre-fetched comment bodies (optional, fetches if not provided)
 * @returns Array of Cloudflare deployment URLs
 *
 * @example
 * ```typescript
 * const urls = await extractCloudflarePreviewUrls(42, '/path/to/repo');
 * // Returns: ['https://my-api.workers.dev', 'https://my-site.pages.dev']
 * ```
 */
export async function extractCloudflarePreviewUrls(
  prNumber: number,
  cwd: string,
  commentBodies?: string[]
): Promise<string[]> {
  const bodies = commentBodies ?? await fetchPRCommentBodies(prNumber, cwd);

  const allUrls: string[] = [];

  // Cloudflare Workers pattern: https://something.workers.dev
  const workersPattern = /https:\/\/[a-z0-9-]+\.workers\.dev/gi;
  // Cloudflare Pages pattern: https://something.pages.dev
  const pagesPattern = /https:\/\/[a-z0-9-]+\.pages\.dev/gi;

  for (const body of bodies) {
    const workersMatches = body.match(workersPattern) || [];
    const pagesMatches = body.match(pagesPattern) || [];
    allUrls.push(...workersMatches, ...pagesMatches);
  }

  // Deduplicate
  return [...new Set(allUrls)];
}

/**
 * Extract Supabase preview branches from PR comments
 *
 * Searches PR comments for Supabase URLs and extracts project refs to
 * construct dashboard links:
 * - API URLs: https://{ref}.supabase.co
 * - DB URLs: db.{ref}.supabase.co
 * - Dashboard URLs: supabase.com/dashboard/project/{ref}
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @param commentBodies - Pre-fetched comment bodies (optional, fetches if not provided)
 * @returns Array of SupabasePreview objects with dashboard links
 *
 * @example
 * ```typescript
 * const previews = await extractSupabasePreviewBranches(42, '/path/to/repo');
 * // Returns: [{ ref: 'abcxyz', apiUrl: 'https://abcxyz.supabase.co',
 * //            dashboardUrl: 'https://supabase.com/dashboard/project/abcxyz' }]
 * ```
 */
export async function extractSupabasePreviewBranches(
  prNumber: number,
  cwd: string,
  commentBodies?: string[]
): Promise<SupabasePreview[]> {
  const bodies = commentBodies ?? await fetchPRCommentBodies(prNumber, cwd);

  // Map of ref -> { apiUrl, dbUrl } for deduplication
  const refMap = new Map<string, { apiUrl: string; dbUrl?: string }>();

  // Supabase API URL pattern: https://{ref}.supabase.co
  const apiPattern = /https:\/\/([a-z0-9-]+)\.supabase\.co/gi;
  // Supabase DB URL pattern: db.{ref}.supabase.co
  const dbPattern = /(?:https?:\/\/)?db\.([a-z0-9-]+)\.supabase\.co/gi;
  // Dashboard URL pattern: supabase.com/dashboard/project/{ref}
  const dashboardPattern = /supabase\.com\/dashboard\/project\/([a-z0-9-]+)/gi;

  for (const body of bodies) {
    // Extract refs from API URLs
    let match;
    while ((match = apiPattern.exec(body)) !== null) {
      const ref = match[1];
      if (!refMap.has(ref)) {
        refMap.set(ref, { apiUrl: `https://${ref}.supabase.co` });
      }
    }

    // Extract refs from DB URLs
    while ((match = dbPattern.exec(body)) !== null) {
      const ref = match[1];
      const existing = refMap.get(ref);
      if (existing) {
        existing.dbUrl = `https://db.${ref}.supabase.co`;
      } else {
        refMap.set(ref, { apiUrl: `https://${ref}.supabase.co`, dbUrl: `https://db.${ref}.supabase.co` });
      }
    }

    // Extract refs from dashboard URLs
    while ((match = dashboardPattern.exec(body)) !== null) {
      const ref = match[1];
      if (!refMap.has(ref)) {
        refMap.set(ref, { apiUrl: `https://${ref}.supabase.co` });
      }
    }
  }

  // Convert to SupabasePreview array
  return Array.from(refMap.entries()).map(([ref, info]) => ({
    ref,
    apiUrl: info.apiUrl,
    dashboardUrl: `https://supabase.com/dashboard/project/${ref}`,
    dbUrl: info.dbUrl,
  }));
}

/**
 * Extract Cloudflare deployment URLs from GitHub Deployments API
 *
 * Queries the GitHub Deployments API for the PR's head commit to find
 * Cloudflare deployment URLs (both Workers and Pages). This supplements
 * comment-based extraction for repos that use GitHub Deployments.
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @returns Array of Cloudflare deployment URLs (empty on error)
 */
export async function extractDeploymentUrls(
  prNumber: number,
  cwd: string
): Promise<string[]> {
  try {
    // Get PR head SHA and repo info
    const prResult = await execCommand(
      `gh pr view ${prNumber} --json headRefOid,url`,
      cwd
    );
    if (!prResult.success) return [];

    const prData = JSON.parse(prResult.stdout);
    const headSha = prData.headRefOid;
    const repoMatch = (prData.url as string).match(/github\.com\/([^/]+\/[^/]+)\/pull/);
    if (!headSha || !repoMatch) return [];

    const repo = repoMatch[1];

    // Query GitHub Deployments API for this commit
    const deploymentsResult = await execCommand(
      `gh api repos/${repo}/deployments?sha=${headSha}&per_page=10`,
      cwd
    );
    if (!deploymentsResult.success) return [];

    const deployments = JSON.parse(deploymentsResult.stdout);
    if (!Array.isArray(deployments) || deployments.length === 0) return [];

    const urls: string[] = [];

    // For each deployment, get the latest status to find environment_url
    for (const deployment of deployments) {
      const statusResult = await execCommand(
        `gh api repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
        cwd
      );
      if (!statusResult.success) continue;

      const statuses = JSON.parse(statusResult.stdout);
      if (!Array.isArray(statuses) || statuses.length === 0) continue;

      const envUrl = statuses[0].environment_url;
      if (envUrl && (envUrl.includes('.pages.dev') || envUrl.includes('.workers.dev'))) {
        urls.push(envUrl);
      }
    }

    return [...new Set(urls)];
  } catch {
    return [];
  }
}

/**
 * Extract all preview URLs grouped by provider
 *
 * Consolidates preview URLs from Vercel, Cloudflare, and Supabase.
 * Fetches PR comments once and shares across all comment-based extractors.
 * Also queries GitHub Deployments API for additional Cloudflare URLs.
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @returns Grouped preview URLs by provider
 *
 * @example
 * ```typescript
 * const previews = await extractAllPreviews(42, '/path/to/repo');
 * // Returns: {
 * //   vercel: ['https://my-app-abc123.vercel.app'],
 * //   cloudflare: ['https://my-worker.workers.dev'],
 * //   supabase: [{ ref: 'abc', apiUrl: '...', dashboardUrl: '...' }]
 * // }
 * ```
 */
export async function extractAllPreviews(
  prNumber: number,
  cwd: string
): Promise<GroupedPreviewUrls> {
  // Fetch comments once, share across all comment-based extractors
  const commentBodies = await fetchPRCommentBodies(prNumber, cwd);

  // Fetch all previews in parallel
  const [vercelResult, commentCloudflareUrls, deploymentCloudflareUrls, supabasePreviews] = await Promise.all([
    extractPreviewUrls(prNumber, cwd, commentBodies),
    extractCloudflarePreviewUrls(prNumber, cwd, commentBodies),
    extractDeploymentUrls(prNumber, cwd),
    extractSupabasePreviewBranches(prNumber, cwd, commentBodies),
  ]);

  // Merge and deduplicate Cloudflare URLs from comments + deployments API
  const allCloudflareUrls = [...new Set([...commentCloudflareUrls, ...deploymentCloudflareUrls])];

  return {
    vercel: vercelResult.allUrls,
    cloudflare: allCloudflareUrls,
    supabase: supabasePreviews,
  };
}

/**
 * Format grouped preview URLs for display
 *
 * Formats preview URLs from all providers (Vercel, Cloudflare, Supabase)
 * into a markdown-formatted string with provider sections.
 *
 * @param previews - Grouped preview URLs by provider
 * @returns Formatted markdown string, empty if no previews
 *
 * @example
 * ```typescript
 * const previews = await extractAllPreviews(42, '/path/to/repo');
 * const formatted = formatGroupedPreviews(previews);
 * // Returns:
 * // "
 * // **Vercel Previews:**
 * //    - https://my-app-abc123.vercel.app
 * //
 * // **Cloudflare Previews:**
 * //    - https://my-worker.workers.dev
 * // "
 * ```
 */
export function formatGroupedPreviews(previews: GroupedPreviewUrls): string {
  let message = '';

  if (previews.vercel.length > 0) {
    message += '\n\n**Vercel Previews:**';
    for (const url of previews.vercel) {
      message += `\n   - ${url}`;
    }
  }

  if (previews.cloudflare.length > 0) {
    message += '\n\n**Cloudflare Deployments:**';
    for (const url of previews.cloudflare) {
      message += `\n   - ${url}`;
    }
  }

  if (previews.supabase.length > 0) {
    message += '\n\n**Supabase Previews:**';
    for (const preview of previews.supabase) {
      message += `\n   - ${preview.dashboardUrl}`;
    }
  }

  return message;
}

/**
 * Parse CI checks output into structured format
 *
 * @param output - Raw output from `gh pr checks`
 * @returns Array of parsed check statuses
 *
 * @example
 * ```typescript
 * const checks = parseCIChecks(ciOutput);
 * for (const check of checks) {
 *   console.log(`${check.emoji} ${check.name}: ${check.status}`);
 * }
 * ```
 */
export function parseCIChecks(output: string): CheckStatus[] {
  const checks: CheckStatus[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse line format: "✓ check-name" or "X check-name" or "* check-name"
    let emoji = '⏳';
    let status = 'pending';

    if (trimmed.startsWith('✓') || trimmed.includes('pass')) {
      emoji = '✅';
      status = 'success';
    } else if (trimmed.startsWith('X') || trimmed.includes('fail')) {
      emoji = '❌';
      status = 'failure';
    } else if (trimmed.includes('cancel')) {
      emoji = '⚪';
      status = 'cancelled';
    }

    // Extract check name (remove status indicator)
    const name = trimmed.replace(/^[✓X*\s]+/, '').split('\t')[0].trim();

    if (name) {
      checks.push({ name, emoji, status });
    }
  }

  return checks;
}

/**
 * Format CI status result as concise string
 *
 * Truncates output to MAX_OUTPUT_CHARS to prevent context bloat.
 *
 * @param result - CI check result
 * @param maxChars - Maximum output characters (default: 500)
 * @returns Formatted status string
 *
 * @example
 * ```typescript
 * const ciResult = await waitForCIChecks({ prNumber: 123 }, cwd);
 * const formatted = formatCIStatus(ciResult);
 * console.log(formatted);
 * ```
 */
export function formatCIStatus(
  result: CICheckResult,
  maxChars: number = MAX_OUTPUT_CHARS
): string {
  let output = '';

  if (result.success) {
    output = '✅ All CI checks passed';
  } else if (result.error) {
    output = `⚠️ ${result.error}`;
  } else {
    output = '❌ CI checks failed';
  }

  // Add check details if available
  if (result.output) {
    const checks = parseCIChecks(result.output);
    if (checks.length > 0) {
      const checkLines = checks.map((c) => `${c.emoji} ${c.name}`).join('\n');
      output += `\n\n${checkLines}`;
    }
  }

  // Truncate if too long
  if (output.length > maxChars) {
    output = output.slice(0, maxChars - 20) + '\n... (truncated)';
  }

  return output;
}

/**
 * Format full CI status with PR info and preview URLs
 *
 * @param prNumber - PR number
 * @param prUrl - PR URL
 * @param ciResult - CI check result
 * @param ciRun - CI run details
 * @param previewUrls - Preview URLs
 * @param maxChars - Maximum output characters (default: 500)
 * @returns Formatted status string
 *
 * @example
 * ```typescript
 * const status = formatFullCIStatus(
 *   123, 'https://github.com/...', ciResult, ciRun, previewUrls
 * );
 * ```
 */
export function formatFullCIStatus(
  prNumber: number,
  prUrl: string,
  ciResult: CICheckResult,
  ciRun: CIRunDetails | null,
  previewUrls: PreviewUrls,
  maxChars: number = MAX_OUTPUT_CHARS
): string {
  let output = `**PR #${prNumber}**\n`;

  // CI status
  if (ciResult.success) {
    output += '✅ All CI checks passed\n';
  } else if (ciResult.error) {
    output += `⏱️ ${ciResult.error}\n`;
  } else {
    output += '❌ CI checks failed\n';
  }

  // CI run link
  if (ciRun?.url) {
    output += `🔗 [CI](${ciRun.url})\n`;
  }

  // Preview URLs
  if (previewUrls.allUrls.length > 0) {
    output += `🌐 ${previewUrls.allUrls[0]}`;
    if (previewUrls.allUrls.length > 1) {
      output += ` (+${previewUrls.allUrls.length - 1})`;
    }
    output += '\n';
  }

  // Truncate if too long
  if (output.length > maxChars) {
    output = output.slice(0, maxChars - 20) + '\n... (truncated)';
  }

  return output;
}

// ============================================================================
// Fail-Fast CI Checking
// ============================================================================

/**
 * Check if PR has merge conflicts
 *
 * Queries GitHub API for the PR's mergeable state and returns immediately
 * if conflicts are detected.
 *
 * @param prNumber - PR number to check
 * @param cwd - Working directory
 * @returns Merge conflict result
 *
 * @example
 * ```typescript
 * const conflicts = await checkMergeConflicts(123, '/path/to/repo');
 * if (conflicts.hasConflicts) {
 *   console.log('PR has merge conflicts!');
 * }
 * ```
 */
export async function checkMergeConflicts(
  prNumber: number,
  cwd: string
): Promise<MergeConflictResult> {
  const result = await execCommand(
    `gh pr view ${prNumber} --json mergeable,mergeStateStatus`,
    cwd
  );

  if (!result.success) {
    return { hasConflicts: false, error: `Failed to check PR: ${result.stderr}` };
  }

  try {
    const data = JSON.parse(result.stdout);
    const mergeable = data.mergeable;
    const mergeStateStatus = data.mergeStateStatus;

    // CONFLICTING means merge conflicts exist
    // UNKNOWN means GitHub is still calculating
    const hasConflicts = mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY';

    return {
      hasConflicts,
      mergeableState: mergeStateStatus || mergeable,
    };
  } catch {
    return { hasConflicts: false, error: 'Failed to parse PR data' };
  }
}

/**
 * Check if branch is behind main/master
 *
 * Compares the current branch with the default branch (main or master)
 * to determine if it's out of date.
 *
 * @param cwd - Working directory
 * @returns Branch sync status result
 *
 * @example
 * ```typescript
 * const sync = await checkBranchSyncStatus('/path/to/repo');
 * if (!sync.inSync) {
 *   console.log(`Branch is ${sync.behindCount} commits behind main`);
 * }
 * ```
 */
export async function checkBranchSyncStatus(cwd: string): Promise<BranchSyncResult> {
  // First, fetch to ensure we have latest remote refs
  await execCommand('git fetch origin', cwd);

  // Get current branch
  const branchResult = await execCommand('git rev-parse --abbrev-ref HEAD', cwd);
  if (!branchResult.success) {
    return { inSync: true, behindCount: 0, aheadCount: 0, error: 'Failed to get current branch' };
  }
  const currentBranch = branchResult.stdout;

  // Determine main branch (main or master)
  let mainBranch = 'main';
  const mainCheck = await execCommand('git rev-parse --verify origin/main', cwd);
  if (!mainCheck.success) {
    const masterCheck = await execCommand('git rev-parse --verify origin/master', cwd);
    if (masterCheck.success) {
      mainBranch = 'master';
    } else {
      return { inSync: true, behindCount: 0, aheadCount: 0, error: 'No main/master branch found' };
    }
  }

  // Count commits behind and ahead
  const revListResult = await execCommand(
    `git rev-list --left-right --count origin/${mainBranch}...${currentBranch}`,
    cwd
  );

  if (!revListResult.success) {
    return { inSync: true, behindCount: 0, aheadCount: 0, error: 'Failed to compare branches' };
  }

  const [behind, ahead] = revListResult.stdout.split('\t').map(Number);

  return {
    inSync: behind === 0,
    behindCount: behind || 0,
    aheadCount: ahead || 0,
  };
}

/**
 * Get current CI check statuses without waiting
 *
 * @param prNumber - PR number
 * @param cwd - Working directory
 * @returns Array of check statuses
 */
async function getCurrentCIChecks(prNumber: number, cwd: string, timeout = 30000): Promise<CheckStatus[]> {
  const result = await execCommand(
    `gh pr checks ${prNumber} --json name,state`,
    cwd,
    timeout
  );

  if (!result.success) {
    return [];
  }

  try {
    const checks = JSON.parse(result.stdout);
    return checks.map((check: { name: string; state: string }) => {
      let emoji = '⏳';
      let status = 'pending';

      // gh pr checks returns state directly as SUCCESS, FAILURE, SKIPPED, PENDING, IN_PROGRESS
      const checkState = check.state.toUpperCase();

      if (checkState === 'SUCCESS') {
        emoji = '✅';
        status = 'success';
      } else if (checkState === 'FAILURE') {
        emoji = '❌';
        status = 'failure';
      } else if (checkState === 'CANCELLED') {
        emoji = '⚪';
        status = 'cancelled';
      } else if (checkState === 'SKIPPED') {
        emoji = '⏭️';
        status = 'skipped';
      } else if (checkState === 'IN_PROGRESS') {
        emoji = '🔄';
        status = 'in_progress';
      } else if (checkState === 'PENDING' || checkState === 'QUEUED') {
        emoji = '⏳';
        status = 'pending';
      }

      return { name: check.name, emoji, status };
    });
  } catch {
    return [];
  }
}

/**
 * Await CI checks with fail-fast behavior
 *
 * Checks for blocking conditions in order:
 * 1. Merge conflicts - block immediately
 * 2. Branch out of date with main - block immediately
 * 3. Any CI check failure - block immediately (don't wait for rest)
 *
 * Only returns success if ALL checks pass.
 *
 * @param options - Check options
 * @param options.prNumber - PR number (optional, will detect from branch)
 * @param options.timeout - Max wait time in ms (default: 10 minutes)
 * @param options.pollInterval - Polling interval in ms (default: 5 seconds)
 * @param cwd - Working directory
 * @returns Fail-fast result with blocking reason if failed
 *
 * @example
 * ```typescript
 * const result = await awaitCIWithFailFast({ prNumber: 123 }, '/path/to/repo');
 * if (!result.success) {
 *   return {
 *     decision: 'block',
 *     reason: result.blockReason,
 *   };
 * }
 * ```
 */
export async function awaitCIWithFailFast(
  options: {
    prNumber?: number;
    timeout?: number;
    pollInterval?: number;
  },
  cwd: string
): Promise<FailFastResult> {
  const { timeout = DEFAULT_TIMEOUT_MS } = options;
  let { prNumber } = options;

  // Get PR number if not provided
  if (!prNumber) {
    prNumber = await getPRForCurrentBranch(cwd) ?? undefined;
    if (!prNumber) {
      return {
        success: true,
        checks: [],
        error: 'No PR found for current branch - skipping CI check',
      };
    }
  }

  // 1. Check for merge conflicts FIRST
  const conflictCheck = await checkMergeConflicts(prNumber, cwd);
  if (conflictCheck.hasConflicts) {
    return {
      success: false,
      blockReason: `❌ PR #${prNumber} has merge conflicts. Resolve conflicts before continuing.`,
      checks: [],
      prNumber,
    };
  }

  // 2. Check if branch is out of date with main
  const syncCheck = await checkBranchSyncStatus(cwd);
  if (!syncCheck.inSync && syncCheck.behindCount > 0) {
    return {
      success: false,
      blockReason: `❌ Branch is ${syncCheck.behindCount} commit(s) behind main. Rebase or merge main before continuing.`,
      checks: [],
      prNumber,
    };
  }

  // 3. Get latest workflow run for PR's head SHA
  const headShaResult = await execCommand(
    `gh pr view ${prNumber} --json headRefOid --jq '.headRefOid'`,
    cwd,
    timeout
  );
  if (!headShaResult.success) {
    return {
      success: false,
      blockReason: `❌ Failed to get PR head SHA: ${headShaResult.stderr}`,
      checks: [],
      prNumber,
    };
  }
  const headSha = headShaResult.stdout.trim();

  // Get the workflow run ID for this commit
  const runListResult = await execCommand(
    `gh run list --commit ${headSha} --json databaseId,status --limit 1`,
    cwd,
    timeout
  );

  if (!runListResult.success || !runListResult.stdout.trim() || runListResult.stdout.trim() === '[]') {
    // No runs yet - check using pr checks instead
    const checks = await getCurrentCIChecks(prNumber, cwd, timeout);
    if (checks.length === 0) {
      return {
        success: true,
        checks: [],
        prNumber,
        error: 'No CI runs found for this commit',
      };
    }
    // Fall through to check status
    const allComplete = checks.every((c) => c.status === 'success' || c.status === 'skipped');
    if (allComplete) {
      return { success: true, checks, prNumber };
    }
    const failedCheck = checks.find((c) => c.status === 'failure' || c.status === 'cancelled');
    if (failedCheck) {
      return {
        success: false,
        blockReason: `❌ CI check "${failedCheck.name}" failed. Fix before continuing.`,
        failedCheck: failedCheck.name,
        checks,
        prNumber,
      };
    }
  }

  let runId: string | undefined;
  try {
    const runs = JSON.parse(runListResult.stdout);
    if (Array.isArray(runs) && runs.length > 0) {
      runId = String(runs[0].databaseId);
    }
  } catch {
    // Ignore parse errors, will fall back to pr checks
  }

  if (runId) {
    // 4. Use gh run watch to wait for completion (with timeout)
    const timeoutSecs = Math.floor(timeout / 1000);
    const _watchResult = await execCommand(
      `timeout ${timeoutSecs} gh run watch ${runId} --exit-status 2>&1 || true`,
      cwd,
      timeout + 5000 // Give a bit more time for timeout command
    );

    // 5. Get final run status using gh run view
    const viewResult = await execCommand(
      `gh run view ${runId} --json conclusion,jobs`,
      cwd,
      timeout
    );

    if (viewResult.success) {
      try {
        const runData = JSON.parse(viewResult.stdout);
        const conclusion = runData.conclusion;

        // Get check statuses from jobs
        const checks: CheckStatus[] = (runData.jobs || []).map((job: { name: string; conclusion: string; status: string }) => {
          let emoji = '⏳';
          let status = 'pending';

          if (job.status === 'completed') {
            if (job.conclusion === 'success') {
              emoji = '✅';
              status = 'success';
            } else if (job.conclusion === 'failure') {
              emoji = '❌';
              status = 'failure';
            } else if (job.conclusion === 'cancelled') {
              emoji = '⚪';
              status = 'cancelled';
            } else if (job.conclusion === 'skipped') {
              emoji = '⏭️';
              status = 'skipped';
            }
          } else if (job.status === 'in_progress') {
            emoji = '🔄';
            status = 'in_progress';
          }

          return { name: job.name, emoji, status };
        });

        if (conclusion === 'success') {
          return { success: true, checks, prNumber };
        } else if (conclusion === 'failure') {
          const failedCheck = checks.find((c) => c.status === 'failure');
          return {
            success: false,
            blockReason: `❌ CI check "${failedCheck?.name || 'unknown'}" failed. Fix before continuing.`,
            failedCheck: failedCheck?.name,
            checks,
            prNumber,
          };
        } else if (conclusion === 'cancelled') {
          return {
            success: false,
            blockReason: `⚪ CI run was cancelled.`,
            checks,
            prNumber,
          };
        }
        // Run still in progress or other state
      } catch {
        // Parse error, fall through
      }
    }
  }

  // Fallback: get current check statuses
  const finalChecks = await getCurrentCIChecks(prNumber, cwd, timeout);

  // Check for any failures
  const failedCheck = finalChecks.find((c) => c.status === 'failure' || c.status === 'cancelled');
  if (failedCheck) {
    return {
      success: false,
      blockReason: `❌ CI check "${failedCheck.name}" failed. Fix before continuing.`,
      failedCheck: failedCheck.name,
      checks: finalChecks,
      prNumber,
    };
  }

  // Check if all complete (success or skipped)
  const allComplete = finalChecks.every((c) => c.status === 'success' || c.status === 'skipped');

  // Safety net: Check for zero checks BEFORE allComplete check
  // (prevents vacuous truth bug where [].every() returns true)
  if (finalChecks.length === 0) {
    return {
      success: true,
      checks: [],
      prNumber,
      error: 'No CI workflows configured for this repository',
    };
  }

  if (allComplete) {
    return { success: true, checks: finalChecks, prNumber };
  }

  // Still pending
  const pendingChecks = finalChecks.filter((c) => c.status === 'pending' || c.status === 'in_progress');
  return {
    success: false,
    blockReason: `⏱️ CI check timeout (${Math.round(timeout / 60000)} minutes). ${pendingChecks.length} check(s) still pending.`,
    checks: finalChecks,
    prNumber,
    error: 'Timeout waiting for CI checks',
  };
}
