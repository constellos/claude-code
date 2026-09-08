---
name: PR Workflow
description: Use this skill when the user wants to "create PR", "update PR", "merge PR", "PR template", "auto-fill PR", "request review", or manage pull request lifecycle. Generates PR descriptions from commits/issues with intelligent defaults.
version: 0.1.0
---

# PR Workflow

Complete PR lifecycle management with auto-generated descriptions from commits and issues.

## Purpose

PR Workflow provides systematic pull request management with intelligent description generation, template selection based on work type, and automated review requests.

## When to Use

- Creating PRs with auto-generated descriptions
- Using templates based on work type (feature/fix/chore/docs/refactor)
- Updating PR metadata (reviewers, labels, milestones)
- Managing PR lifecycle (draft → ready → merge)

## Core Capabilities

### PR Creation with Auto-Description

```bash
# Get commits since base branch
COMMITS=$(git log main..HEAD --oneline --no-decorate)

# Get linked issue
BRANCH=$(git branch --show-current)
ISSUE=$(extractIssueNumber "$BRANCH")

# Generate description
DESC=$(generatePRDescription "$COMMITS" "$ISSUE")

# Create PR
gh pr create --title "Add authentication system" --body "$DESC"
```

**Utilities:**
- `generatePRDescription(commits, linkedIssue?)` - Auto-generate from commits
- `getPRTemplateByWorkType(workType)` - Get template by type
- `renderPRTemplate(template, vars)` - Substitute variables
- `groupCommitsByType(commits)` - Group by conventional commit types
- `formatGroupedCommits(grouped)` - Format as sections

### Template Selection

Templates automatically adapt to work type:

**Feature PR:**
```markdown
## Summary
Brief overview

## Changes
- Change 1
- Change 2

## Testing
- [ ] Unit tests
- [ ] Integration tests

## Related Issues
Closes #42
```

**Bug Fix PR:**
```markdown
## Bug Fix
Brief description

## Root Cause
What caused it

## Solution
How we fixed it

## Testing
- [ ] Bug reproduced before fix
- [ ] Bug resolved after fix
```

### Review Requests

```bash
# Auto-request reviewers from CODEOWNERS
OWNERS=$(grep "^$(dirname $FILE)" .github/CODEOWNERS | awk '{print $2}')

gh pr edit $PR --add-reviewer "$OWNERS"

# Or manually
gh pr edit $PR --add-reviewer @user1,@user2
```

### PR Updates

```bash
# Update labels
gh pr edit 42 --add-label "enhancement,priority:high"

# Update milestone
gh pr edit 42 --milestone "v2.0"

# Convert to draft
gh pr ready --undo 42

# Mark ready for review
gh pr ready 42
```

## Templates

- `getFeaturePRTemplate()` - New features
- `getBugfixPRTemplate()` - Bug fixes
- `getChorePRTemplate()` - Maintenance
- `getDocsPRTemplate()` - Documentation
- `getRefactorPRTemplate()` - Code improvements

All templates include:
- Summary section
- Change list
- Testing checklist
- Related issues
- Claude Code footer

## Examples

### Create PR with Grouped Commits

```bash
# Get commits
COMMITS=$(git log main..HEAD --pretty=format:"%s")

# Group by type
GROUPED=$(groupCommitsByType "$COMMITS")
# Returns: { feat: [...], fix: [...], docs: [...] }

# Format as sections
BODY=$(formatGroupedCommits "$GROUPED")

# Add issue reference
ISSUE=$(extractIssueNumber "$(git branch --show-current)")
BODY="$BODY

## Related Issues

Closes #$ISSUE"

# Create PR
gh pr create --title "Authentication system" --body "$BODY"
```

### Auto-Merge When CI Passes

```bash
# Create PR and enable auto-merge
PR=$(gh pr create --title "..." --body "..." --json number -q .number)

# Enable auto-merge (squash)
gh pr merge $PR --auto --squash --delete-branch

# CI will auto-merge when checks pass
```

### Request Reviews from CODEOWNERS

```bash
# Parse CODEOWNERS for file
FILE="src/auth/login.ts"
PATTERN=$(grep -E "^[^#].*$(dirname $FILE)" .github/CODEOWNERS | head -1)
REVIEWERS=$(echo "$PATTERN" | awk '{for(i=2;i<=NF;i++) print $i}' | tr '\n' ',' | sed 's/,$//')

# Request review
gh pr edit $PR --add-reviewer "$REVIEWERS"
```

## Best Practices

1. Auto-generate descriptions from commits
2. Use conventional commits for grouping (feat:, fix:, etc.)
3. Link to issues with "Closes #N"
4. Request reviews from CODEOWNERS
5. Use templates matching work type
6. Enable auto-merge for simple PRs
7. Add preview URLs to description
