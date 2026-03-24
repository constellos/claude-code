![Version](https://img.shields.io/badge/version-0.2.0-blue?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)
![GitHub](https://img.shields.io/badge/GitHub-CLI-black?style=for-the-badge&logo=github)

# GitHub Orchestration Plugin

> Comprehensive GitHub workflow orchestration with skills for issues, branches, PRs, and CI management

## Purpose

Provides complete GitHub workflow automation for Claude Code sessions. Combines automatic hooks for session context with 4 specialized skills and a coordinating agent for complex multi-step workflows. Supports issue management, smart branch naming, CI orchestration, and PR lifecycle automation.

## Contents

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| install-github | SessionStart | Installs GitHub CLI on remote environments |
| add-github-context | SessionStart | Displays linked issue, branch sync status, outstanding issues |
| create-issue-on-prompt | UserPromptSubmit | Creates GitHub issue on first user prompt |
| sync-plan-to-issue | PostToolUse[Write\|Edit] | Creates/updates GitHub issues from plan files |
| enhance-commit-context | PostToolUse[Bash] | Enriches git commits with task context |
| await-pr-status | PostToolUse[Bash] | Detects PR creation, suggests CI check |
| commit-session-await-ci-status | Stop | Validates git state, reports PR status (blocking) |

### Skills

| Skill | Purpose |
|-------|---------|
| issue-management | Create, update, label, and link GitHub issues with templates |
| branch-orchestration | Smart branch naming (`{issue}-{type}/{name}`), lifecycle management |
| ci-orchestration | CI/CD monitoring with fail-fast patterns and preview URL extraction |
| pr-workflow | PR lifecycle with auto-generated descriptions from commits |

### Agents

| Agent | Purpose |
|-------|---------|
| github-orchestrator | Coordinates complex multi-step workflows across issues, branches, PRs, and CI |

## Usage Examples

### Create Issue with Template

```bash
# Using issue-management skill
gh issue create \
  --title "Safari auth failure" \
  --label "bug,priority:high" \
  --body "$(getBugTemplate | renderTemplate '{description: "Auth fails on Safari 17.2", ...}')"
```

### Smart Branch Naming

```bash
# Using branch-orchestration skill
BRANCH=$(generateBranchName 42 "feature" "Add dark mode")
# Returns: "42-feature/add-dark-mode"

git checkout -b "$BRANCH"
git push -u origin "$BRANCH"
```

### CI Monitoring

```bash
# Using ci-orchestration skill
# Wait for CI with fail-fast (10min timeout)
awaitCIWithFailFast "$PWD" 42 10

# Extract preview URLs
URLS=$(extractPreviewUrls "$(gh pr view 42 --json statusCheckRollup)")
```

### Auto-Generated PR Descriptions

```bash
# Using pr-workflow skill
COMMITS=$(git log main..HEAD --oneline)
ISSUE=$(extractIssueNumber "$(git branch --show-current)")
DESC=$(generatePRDescription "$COMMITS" "$ISSUE")

gh pr create --body "$DESC"
```

### Orchestrate Complete Feature Flow

```bash
# Using github-orchestrator agent
# 1. Create epic issue
# 2. Create branches with smart naming
# 3. Create PRs with auto-descriptions
# 4. Monitor CI and extract previews
# 5. Merge and close issues
```

## State Files

The plugin maintains workflow state in `.claude/logs/`:

- `plan-issues.json` - Plan → Issue mapping
- `branch-issues.json` - Branch → Issue mapping
- `session-config.json` - Session configuration
- `session-stops.json` - Session stop state tracking
- `task-calls.json` - Task tool context coordination

## Branch Naming Convention

Format: `{issueNumber}-{workType}/{kebab-case-title}`

**Work Types:** `feature` | `fix` | `chore` | `docs` | `refactor`

**Examples:**
- `42-feature/add-dark-mode`
- `123-fix/safari-auth-bug`
- `7-docs/update-readme`

## Installation

```bash
claude plugin install github-orchestration@constellos
```

## Migration from github-context

This plugin replaces `github-context` with expanded capabilities. All existing hooks remain unchanged. New skills and agent provide explicit control over workflows.

**What's New in v0.2.0:**
- 4 specialized skills for explicit GitHub operations
- github-orchestrator agent for complex workflows
- Extracted utilities (work-type-detector, branch-naming, issue-templates, pr-templates)
- Enhanced CI orchestration with preview URL extraction
- Auto-generated PR descriptions from commits

**Breaking Changes:** None - all hooks remain backward compatible

## License

MIT © constellos
