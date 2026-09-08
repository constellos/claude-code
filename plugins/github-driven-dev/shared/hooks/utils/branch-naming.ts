/**
 * Branch naming utility for GitHub workflow automation
 * Extracted from create-issue-on-prompt.ts for reusability
 */

import type { WorkType } from './work-type-detector.js';

/**
 * Parsed branch name components
 */
export interface ParsedBranchName {
  issueNumber?: number;
  workType?: WorkType;
  title: string;
}

/**
 * Branch name validation result
 */
export interface BranchValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Convert title to kebab-case for branch name (max 40 chars)
 *
 * @param title - The title to convert
 * @returns Kebab-cased string
 *
 * @example
 * toKebabCase('Add Dark Mode Feature') // 'add-dark-mode-feature'
 */
export function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim hyphens
    .substring(0, 40); // Max 40 chars
}

/**
 * Generate branch name from issue number, work type, and title
 * Format: {issueNumber}-{workType}/{kebab-name}
 *
 * @param issueNumber - The GitHub issue number
 * @param workType - The work type (feature/fix/chore/docs/refactor)
 * @param title - The issue title or description
 * @returns Generated branch name
 *
 * @example
 * generateBranchName(42, 'feature', 'Add Dark Mode') // '42-feature/add-dark-mode'
 * generateBranchName(123, 'fix', 'Fix Authentication Bug') // '123-fix/fix-authentication-bug'
 */
export function generateBranchName(issueNumber: number, workType: WorkType, title: string): string {
  const kebabName = toKebabCase(title);
  return `${issueNumber}-${workType}/${kebabName}`;
}

/**
 * Parse branch name into components
 * Supports formats:
 * - {issueNumber}-{workType}/{title} (e.g., "42-feature/add-dark-mode")
 * - {issueNumber}-{title} (e.g., "42-add-dark-mode")
 * - {title} (e.g., "add-dark-mode")
 *
 * @param branchName - The branch name to parse
 * @returns Parsed branch components
 *
 * @example
 * parseBranchName('42-feature/add-dark-mode')
 * // { issueNumber: 42, workType: 'feature', title: 'add-dark-mode' }
 *
 * parseBranchName('123-fix-auth-bug')
 * // { issueNumber: 123, title: 'fix-auth-bug' }
 */
export function parseBranchName(branchName: string): ParsedBranchName {
  // Pattern: {issueNumber}-{workType}/{title}
  const fullMatch = branchName.match(/^(\d+)-(feature|fix|chore|docs|refactor)\/(.+)$/);
  if (fullMatch) {
    return {
      issueNumber: parseInt(fullMatch[1], 10),
      workType: fullMatch[2] as WorkType,
      title: fullMatch[3],
    };
  }

  // Pattern: {issueNumber}-{title}
  const issueMatch = branchName.match(/^(\d+)-(.+)$/);
  if (issueMatch) {
    return {
      issueNumber: parseInt(issueMatch[1], 10),
      title: issueMatch[2],
    };
  }

  // Pattern: {title} only
  return {
    title: branchName,
  };
}

/**
 * Validate branch name against conventions
 *
 * @param branchName - The branch name to validate
 * @returns Validation result with reason if invalid
 *
 * @example
 * validateBranchName('42-feature/add-dark-mode') // { valid: true }
 * validateBranchName('invalid name with spaces') // { valid: false, reason: '...' }
 */
export function validateBranchName(branchName: string): BranchValidation {
  // Check for spaces
  if (/\s/.test(branchName)) {
    return {
      valid: false,
      reason: 'Branch name cannot contain spaces',
    };
  }

  // Check for invalid characters
  if (!/^[a-z0-9\-/]+$/.test(branchName)) {
    return {
      valid: false,
      reason: 'Branch name can only contain lowercase letters, numbers, hyphens, and slashes',
    };
  }

  // Check for multiple consecutive hyphens
  if (/--/.test(branchName)) {
    return {
      valid: false,
      reason: 'Branch name cannot contain consecutive hyphens',
    };
  }

  // Check for leading/trailing hyphens or slashes
  if (/^[-/]|[-/]$/.test(branchName)) {
    return {
      valid: false,
      reason: 'Branch name cannot start or end with hyphens or slashes',
    };
  }

  // Check length (reasonable max 100 chars)
  if (branchName.length > 100) {
    return {
      valid: false,
      reason: 'Branch name is too long (max 100 characters)',
    };
  }

  return { valid: true };
}

/**
 * Extract issue number from branch name prefix
 * Supports patterns: "42-*", "issue-42-*"
 *
 * @param branchName - The branch name to parse
 * @returns Issue number if found, null otherwise
 *
 * @example
 * extractIssueNumber('42-feature/add-dark-mode') // 42
 * extractIssueNumber('issue-123-fix-bug') // 123
 * extractIssueNumber('main') // null
 */
export function extractIssueNumber(branchName: string): number | null {
  // Pattern: {number}-*
  const match1 = branchName.match(/^(\d+)-/);
  if (match1) {
    return parseInt(match1[1], 10);
  }

  // Pattern: issue-{number}-*
  const match2 = branchName.match(/^issue-(\d+)-/);
  if (match2) {
    return parseInt(match2[1], 10);
  }

  return null;
}
