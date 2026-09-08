---
name: Issue Management
description: Use this skill when the user wants to "create issue", "update issue", "add labels", "assign issue", "close issue", "link issues", or manage GitHub issue metadata. Provides comprehensive GitHub issue CRUD operations with intelligent context awareness.
version: 0.1.0
---

# Issue Management

Comprehensive GitHub issue lifecycle management with templates, metadata, and intelligent context detection.

## Purpose

Issue Management provides explicit control over GitHub issue operations. While hooks automatically create issues on first prompt, this skill allows users to directly manage issue creation, updates, labeling, assignment, and linking with full control over templates and metadata.

## When to Use

- Creating issues with specific templates (bug/feature/epic/task)
- Updating existing issue metadata (labels, assignees, milestones)
- Linking issues as parent-child or related
- Searching and filtering issues
- When hooks don't fit the workflow (e.g., creating multiple issues at once)

## Core Capabilities

### Issue Creation

Create issues using structured templates:

```bash
# Bug report with template
gh issue create --title "Auth fails on Safari" --body "$(cat <<'EOF'
## Bug Description

Authentication fails silently on Safari 17.2

## Steps to Reproduce

1. Open Safari 17.2
2. Navigate to /login
3. Enter credentials
4. Click Sign In

## Expected Behavior

User should be redirected to dashboard

## Actual Behavior

Page reloads with no error message

## Environment

- OS: macOS 14.2
- Browser: Safari 17.2
- Version: v1.5.0
EOF
)"
```

**Available Templates:**
- `getBugTemplate()` - Bug report with repro steps
- `getFeatureTemplate()` - Feature request with problem statement
- `getEpicTemplate()` - Epic with subtasks checklist
- `getTaskTemplate()` - Simple task with acceptance criteria

**Utilities:**
- `renderTemplate(template, vars)` - Substitute {{varName}} placeholders
- `getMinimalIssueBody(description, context?)` - Basic issue without template
### Issue Updates

Update issue metadata after creation:

```bash
# Add labels
gh issue edit 42 --add-label "bug,priority:high"

# Assign users
gh issue edit 42 --add-assignee @me,@username

# Update milestone
gh issue edit 42 --milestone "v2.0"

# Update body
gh issue edit 42 --body-file updated-description.md
```

### Issue Linking

Link issues with parent-child or related relationships:

```bash
# Parent-child (in issue body)
**Parent Issue:** #42

This issue implements the authentication flow from the parent epic.

# Related issues (in body)
**Related Issues:** #40, #41, #43

# Closes references (auto-links on merge)
Closes #42
Fixes #43
```

**Utilities:**
- `addBranchReference(issueBody, branchName)` - Add branch marker to issue

### Issue Search

Find issues with advanced queries:

```bash
# Search by label
gh issue list --label "bug"

# Search by state and assignee
gh issue list --state open --assignee @me

# Search with text query
gh issue list --search "authentication in:title,body"

# Search by milestone
gh issue list --milestone "v2.0"

# Complex search
gh issue list --search "is:open label:bug author:@me created:>2024-01-01"
```

### Context Detection

The skill automatically detects context from:

1. **Branch names** - Extracts issue number from `42-feature/name` format
2. **State files** - Checks `.claude/logs/branch-issues.json` for linked issues
3. **Work type** - Detects from prompt using `detectWorkType()` for auto-labeling
4. **Session context** - Uses current session info for metadata

## Integration with Hooks

This skill complements the automatic hooks:

| Hook | Automatic Behavior | When to Use Skill |
|------|-------------------|------------------|
| create-issue-on-prompt | Creates issue on first prompt | Create multiple issues, use specific templates |
| sync-plan-to-issue | Syncs plan files to issues | Manually update issue from plan changes |

**State Files:**
- `.claude/logs/plan-issues.json` - Plan → Issue mapping
- `.claude/logs/branch-issues.json` - Branch → Issue mapping

## Work Type Detection

Automatically categorize issues:

```typescript
import { detectWorkType, formatWorkTypeLabel } from '../shared/hooks/utils/work-type-detector.js';

const workType = detectWorkType('fix the authentication bug');
// Returns: 'fix'

const label = formatWorkTypeLabel(workType);
// Returns: 'Bug Fix'
```

**Patterns:**
- **fix** - bug, error, broken, crash, fail
- **feature** - add, create, implement, build, new
- **docs** - document, readme, comment, explain
- **refactor** - clean, improve, optimize, restructure
- **chore** - maintain, update, upgrade, config

## Examples

### Example 1: Create Bug with Template

```bash
# Use getBugTemplate() and renderTemplate()
TEMPLATE=$(cat <<'EOF'
## Bug Description

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
EOF
)

# Substitute variables and create issue
gh issue create \
  --title "Safari auth failure" \
  --label "bug,priority:high" \
  --body "$TEMPLATE" # (after variable substitution)
```

### Example 2: Create Epic Issue

```bash
# Create epic issue with task checklist
PARENT=$(gh issue create \
  --title "Implement authentication system" \
  --label "epic" \
  --body "$(cat <<'EOF'
## Epic Overview

Build complete authentication system with OAuth and email/password support.

## Goals

- OAuth integration (Google, GitHub)
- Email/password authentication
- Password reset flow
- Session management

## Success Criteria

- All auth flows tested
- Security audit passed
- Documentation complete

## Subtasks

- [ ] OAuth integration
- [ ] Email/password auth
- [ ] Password reset
- [ ] Session management
EOF
)" \
  --json number -q .number)
```

### Example 3: Update Issue Labels Based on Work Type

```bash
# Detect work type from title
TITLE="Fix authentication bug in Safari"
WORK_TYPE="fix"  # Detected by detectWorkType()

# Add appropriate labels
gh issue edit 42 --add-label "bug,browser:safari,priority:high"
```

### Example 4: Link Issue to Branch

```bash
# Add branch reference to issue body
CURRENT_BODY=$(gh issue view 42 --json body -q .body)
UPDATED_BODY="$CURRENT_BODY

---

**Branch:** \`42-fix/safari-auth-bug\`"

echo "$UPDATED_BODY" | gh issue edit 42 --body-file -
```

### Example 5: Bulk Issue Creation

```bash
# Create multiple related issues
ISSUES=(
  "Implement login form:feature"
  "Add form validation:chore"
  "Create auth API endpoints:feature"
  "Write authentication tests:chore"
)

for item in "${ISSUES[@]}"; do
  TITLE="${item%:*}"
  TYPE="${item#*:}"
  LABEL=$(echo "$TYPE" | sed 's/feature/enhancement/;s/fix/bug/')

  gh issue create --title "$TITLE" --label "$LABEL" --body "Task for authentication epic"
done
```

## Best Practices

1. **Use templates** - Structured issues are easier to understand and track
2. **Detect work type** - Automatically label issues based on content
3. **Link issues** - Use parent-child and related issue references
4. **Update state files** - Keep `.claude/logs/` files synced when creating issues manually
5. **Check existing issues** - Search before creating to avoid duplicates
6. **Use consistent labels** - Follow project's labeling conventions
7. **Add context** - Include branch names, related PRs, and file references

## Utilities Reference

### Templates
- `getBugTemplate()` - Bug report template
- `getFeatureTemplate()` - Feature request template
- `getEpicTemplate(subtasks?)` - Epic with optional subtasks
- `getTaskTemplate()` - Simple task template
- `renderTemplate(template, vars)` - Substitute variables
- `getMinimalIssueBody(description, context?)` - Basic body
- `addBranchReference(body, branchName)` - Add branch marker

### Work Type
- `detectWorkType(prompt, issueLabels?)` - Detect work type from text
- `formatWorkTypeLabel(workType)` - Format as human-readable label

### State Files
- `.claude/logs/plan-issues.json` - Plan → Issue mapping
- `.claude/logs/branch-issues.json` - Branch → Issue mapping

## Common Patterns

### Pattern: Create Issue from Plan

```bash
# Read plan file
PLAN_CONTENT=$(cat .claude/plans/feature-auth.md)

# Extract title from first heading
TITLE=$(echo "$PLAN_CONTENT" | grep -m1 "^# " | sed 's/^# //')

# Create issue with plan content
ISSUE_NUM=$(gh issue create \
  --title "$TITLE" \
  --label "planned" \
  --body "$PLAN_CONTENT" \
  --json number -q .number)

# Save to state file
echo "{\"feature-auth\": {\"issueNumber\": $ISSUE_NUM}}" > .claude/logs/plan-issues.json
```

### Pattern: Sync Issue with Current Work

```bash
# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Extract issue number
ISSUE_NUM=$(echo "$BRANCH" | grep -oE '^[0-9]+')

if [ -n "$ISSUE_NUM" ]; then
  # Update issue with progress
  gh issue comment $ISSUE_NUM --body "🚧 Currently working on this in branch \`$BRANCH\`"
fi
```

### Pattern: Close Related Issues

```bash
# Close all issues in epic when epic closes
PARENT=42
CHILD_ISSUES=$(gh issue list --search "in:body \"Parent Issue: #$PARENT\"" --json number -q '.[].number')

for issue in $CHILD_ISSUES; do
  gh issue close $issue --comment "Closing as part of completed epic #$PARENT"
done
```
