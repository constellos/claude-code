/**
 * GitHub issue template utility for workflow automation
 * Provides reusable templates for bug reports, feature requests, and epics
 */

/**
 * Template variables for substitution
 */
export interface TemplateVars {
  [key: string]: string;
}

/**
 * Get bug report issue template
 *
 * @returns Bug report markdown template
 */
export function getBugTemplate(): string {
  return `## Bug Description

{{description}}

## Steps to Reproduce

1. {{step1}}
2. {{step2}}
3. {{step3}}

## Expected Behavior

{{expected}}

## Actual Behavior

{{actual}}

## Environment

- OS: {{os}}
- Browser: {{browser}}
- Version: {{version}}

## Additional Context

{{context}}`;
}

/**
 * Get feature request issue template
 *
 * @returns Feature request markdown template
 */
export function getFeatureTemplate(): string {
  return `## Feature Description

{{description}}

## Problem Statement

{{problem}}

## Proposed Solution

{{solution}}

## Alternatives Considered

{{alternatives}}

## Additional Context

{{context}}`;
}

/**
 * Get epic issue template with optional subissue list
 *
 * @param subissues - Optional array of subissue titles for checklist
 * @returns Epic markdown template
 */
export function getEpicTemplate(subissues?: string[]): string {
  const checklistSection = subissues && subissues.length > 0
    ? `

## Subtasks

${subissues.map((title) => `- [ ] ${title}`).join('\n')}`
    : '';

  return `## Epic Overview

{{description}}

## Goals

- {{goal1}}
- {{goal2}}
- {{goal3}}

## Success Criteria

- {{criteria1}}
- {{criteria2}}
- {{criteria3}}

## Technical Approach

{{approach}}${checklistSection}

## Additional Context

{{context}}`;
}

/**
 * Get simple task issue template
 *
 * @returns Task markdown template
 */
export function getTaskTemplate(): string {
  return `## Task Description

{{description}}

## Acceptance Criteria

- [ ] {{criteria1}}
- [ ] {{criteria2}}
- [ ] {{criteria3}}

## Additional Context

{{context}}`;
}

/**
 * Render template by substituting variables
 * Variables are denoted with {{varName}} syntax
 * Missing variables are left as-is (not replaced)
 *
 * @param template - The template string with {{varName}} placeholders
 * @param vars - Key-value pairs for substitution
 * @returns Rendered template with substituted values
 *
 * @example
 * const template = "Hello {{name}}, you are {{age}} years old";
 * renderTemplate(template, { name: "Alice", age: "30" })
 * // "Hello Alice, you are 30 years old"
 *
 * @example
 * // Missing variables are preserved
 * renderTemplate("Hello {{name}}", {})
 * // "Hello {{name}}"
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  let result = template;

  for (const [key, value] of Object.entries(vars)) {
    const placeholder = `{{${key}}}`;
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

/**
 * Get minimal issue body with just description and context
 *
 * @param description - Issue description
 * @param context - Additional context (optional)
 * @returns Minimal issue markdown
 */
export function getMinimalIssueBody(description: string, context?: string): string {
  const contextSection = context ? `\n\n## Additional Context\n\n${context}` : '';
  return `${description}${contextSection}`;
}

/**
 * Add branch reference to issue body
 *
 * @param issueBody - Existing issue body
 * @param branchName - Branch name to reference
 * @returns Updated issue body with branch marker
 */
export function addBranchReference(issueBody: string, branchName: string): string {
  const branchSection = `\n\n---\n\n**Branch:** \`${branchName}\``;
  return `${issueBody}${branchSection}`;
}
