/**
 * GitHub PR template utility for workflow automation
 * Generates PR descriptions from commits and issues
 */

import type { WorkType } from './work-type-detector.js';

/**
 * Template variables for PR substitution
 */
export interface PRTemplateVars {
  [key: string]: string;
}

/**
 * Get feature PR template
 *
 * @returns Feature PR markdown template
 */
export function getFeaturePRTemplate(): string {
  return `## Summary

{{summary}}

## Changes

{{changes}}

## Testing

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed

## Screenshots

{{screenshots}}

## Related Issues

{{issues}}

## Breaking Changes

{{breaking}}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/**
 * Get bugfix PR template
 *
 * @returns Bugfix PR markdown template
 */
export function getBugfixPRTemplate(): string {
  return `## Bug Fix

{{summary}}

## Root Cause

{{cause}}

## Solution

{{solution}}

## Testing

- [ ] Bug reproduced before fix
- [ ] Bug no longer occurs after fix
- [ ] Regression tests added
- [ ] Manual testing completed

## Related Issues

{{issues}}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/**
 * Get chore PR template
 *
 * @returns Chore PR markdown template
 */
export function getChorePRTemplate(): string {
  return `## Chore

{{summary}}

## Changes

{{changes}}

## Impact

{{impact}}

## Related Issues

{{issues}}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/**
 * Get docs PR template
 *
 * @returns Documentation PR markdown template
 */
export function getDocsPRTemplate(): string {
  return `## Documentation

{{summary}}

## Changes

{{changes}}

## Related Issues

{{issues}}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/**
 * Get refactor PR template
 *
 * @returns Refactor PR markdown template
 */
export function getRefactorPRTemplate(): string {
  return `## Refactor

{{summary}}

## Motivation

{{motivation}}

## Changes

{{changes}}

## Testing

- [ ] All existing tests pass
- [ ] No behavior changes
- [ ] Code coverage maintained

## Related Issues

{{issues}}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/**
 * Get PR template by work type
 *
 * @param workType - The work type (feature/fix/chore/docs/refactor)
 * @returns Appropriate PR template
 */
export function getPRTemplateByWorkType(workType: WorkType): string {
  const templates: Record<WorkType, string> = {
    feature: getFeaturePRTemplate(),
    fix: getBugfixPRTemplate(),
    chore: getChorePRTemplate(),
    docs: getDocsPRTemplate(),
    refactor: getRefactorPRTemplate(),
  };

  return templates[workType];
}

/**
 * Render PR template by substituting variables
 *
 * @param template - The template string with {{varName}} placeholders
 * @param vars - Key-value pairs for substitution
 * @returns Rendered template with substituted values
 */
export function renderPRTemplate(template: string, vars: PRTemplateVars): string {
  let result = template;

  for (const [key, value] of Object.entries(vars)) {
    const placeholder = `{{${key}}}`;
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

/**
 * Generate PR description from commits
 * Extracts commit messages and formats them into a bulleted list
 *
 * @param commits - Array of commit messages
 * @param linkedIssue - Optional linked issue number
 * @returns Generated PR description
 *
 * @example
 * generatePRDescription(['feat: add dark mode', 'fix: button styling'], 42)
 * // Returns formatted description with commits and issue link
 */
export function generatePRDescription(commits: string[], linkedIssue?: number): string {
  const commitSection = commits.length > 0
    ? `## Changes

${commits.map((msg) => `- ${msg.replace(/^(feat|fix|chore|docs|refactor):\s*/i, '')}`).join('\n')}`
    : '## Changes\n\n<!-- Add description of changes -->';

  const issueSection = linkedIssue
    ? `\n\n## Related Issues\n\nCloses #${linkedIssue}`
    : '';

  return `${commitSection}${issueSection}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/**
 * Extract conventional commit type from commit message
 *
 * @param commitMessage - The commit message
 * @returns Commit type (feat/fix/chore/docs/refactor) or null
 *
 * @example
 * extractCommitType('feat: add dark mode') // 'feat'
 * extractCommitType('fix(auth): resolve token issue') // 'fix'
 * extractCommitType('regular commit message') // null
 */
export function extractCommitType(commitMessage: string): string | null {
  const match = commitMessage.match(/^(feat|fix|chore|docs|refactor|style|test|perf|ci|build|revert)(\(.+?\))?:/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Group commits by conventional commit type
 *
 * @param commits - Array of commit messages
 * @returns Grouped commits by type
 *
 * @example
 * groupCommitsByType(['feat: add X', 'fix: resolve Y', 'feat: add Z'])
 * // { feat: ['add X', 'add Z'], fix: ['resolve Y'] }
 */
export function groupCommitsByType(commits: string[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};

  for (const commit of commits) {
    const type = extractCommitType(commit) || 'other';
    const message = commit.replace(/^(feat|fix|chore|docs|refactor|style|test|perf|ci|build|revert)(\(.+?\))?:\s*/i, '');

    if (!grouped[type]) {
      grouped[type] = [];
    }
    grouped[type].push(message);
  }

  return grouped;
}

/**
 * Format grouped commits for PR description
 *
 * @param grouped - Commits grouped by type
 * @returns Formatted markdown with sections
 */
export function formatGroupedCommits(grouped: Record<string, string[]>): string {
  const sections: string[] = [];

  const order = ['feat', 'fix', 'refactor', 'docs', 'chore', 'other'];
  const titles: Record<string, string> = {
    feat: '### Features',
    fix: '### Bug Fixes',
    refactor: '### Refactoring',
    docs: '### Documentation',
    chore: '### Chores',
    other: '### Other Changes',
  };

  for (const type of order) {
    if (grouped[type] && grouped[type].length > 0) {
      sections.push(`${titles[type] || `### ${type}`}\n\n${grouped[type].map((msg) => `- ${msg}`).join('\n')}`);
    }
  }

  return sections.join('\n\n');
}
