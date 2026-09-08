/**
 * Work type detection utility for GitHub workflow automation
 * Extracted from create-issue-on-prompt.ts for reusability
 */

/**
 * Work type prefixes for branch naming and issue labeling
 */
export type WorkType = 'feature' | 'fix' | 'chore' | 'docs' | 'refactor';

/**
 * Detect work type from prompt keywords
 *
 * @param prompt - The user prompt or issue title
 * @param issueLabels - Optional array of issue labels to help with detection
 * @returns Detected work type
 *
 * @example
 * detectWorkType('fix the broken authentication') // 'fix'
 * detectWorkType('add dark mode feature') // 'feature'
 * detectWorkType('update README docs') // 'docs'
 */
export function detectWorkType(prompt: string, issueLabels?: string[]): WorkType {
  const lower = prompt.toLowerCase();

  // Check labels first if available
  if (issueLabels) {
    const labelLower = issueLabels.map((l) => l.toLowerCase());
    if (labelLower.some((l) => l.includes('bug') || l.includes('fix'))) {
      return 'fix';
    }
    if (labelLower.some((l) => l.includes('docs') || l.includes('documentation'))) {
      return 'docs';
    }
    if (labelLower.some((l) => l.includes('refactor') || l.includes('cleanup'))) {
      return 'refactor';
    }
    if (labelLower.some((l) => l.includes('chore') || l.includes('maintenance'))) {
      return 'chore';
    }
    if (labelLower.some((l) => l.includes('feature') || l.includes('enhancement'))) {
      return 'feature';
    }
  }

  // Fix patterns
  if (/\b(fix|bug|error|issue|broken|crash|fail|wrong)\b/.test(lower)) {
    return 'fix';
  }

  // Docs patterns
  if (/\b(doc|readme|document|comment|explain)\b/.test(lower)) {
    return 'docs';
  }

  // Refactor patterns
  if (/\b(refactor|clean|improve|optimize|reorganize|restructure)\b/.test(lower)) {
    return 'refactor';
  }

  // Chore patterns
  if (/\b(chore|maintain|update|upgrade|config|setup)\b/.test(lower)) {
    return 'chore';
  }

  // Feature patterns (default for most work)
  if (/\b(add|create|implement|build|new|feature|develop)\b/.test(lower)) {
    return 'feature';
  }

  // Default to feature for general work
  return 'feature';
}

/**
 * Format work type as a label string
 *
 * @param workType - The work type to format
 * @returns Formatted label (e.g., "Feature", "Bug Fix")
 *
 * @example
 * formatWorkTypeLabel('feature') // 'Feature'
 * formatWorkTypeLabel('fix') // 'Bug Fix'
 */
export function formatWorkTypeLabel(workType: WorkType): string {
  const labels: Record<WorkType, string> = {
    feature: 'Feature',
    fix: 'Bug Fix',
    chore: 'Chore',
    docs: 'Documentation',
    refactor: 'Refactor',
  };

  return labels[workType];
}
