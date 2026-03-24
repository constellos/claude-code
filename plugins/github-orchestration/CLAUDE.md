---
title: GitHub Orchestration Plugin
description: Comprehensive GitHub workflow orchestration with skills for issues, branches, PRs, and CI management
version: 0.2.0
folder:
  subfolders:
    allowed: [.claude-plugin, hooks, shared, skills, agents]
    required: [.claude-plugin, hooks]
  files:
    allowed: [CLAUDE.md, README.md, .gitignore]
    required: [README.md]
---

# GitHub Orchestration Plugin

Comprehensive GitHub workflow orchestration with skills for issues, branches, PRs, and CI management.

## Hook Summary

| Hook | Event | Blocking | Purpose |
|------|-------|----------|---------|
| install-github | SessionStart | No | Installs GitHub CLI on remote |
| add-github-context | SessionStart | No | Shows linked issue, sync status |
| create-issue-on-prompt | UserPromptSubmit | No | Creates issue on first prompt |
| sync-plan-to-issue | PostToolUse[Write\|Edit] | No | Syncs plans to issues with version comments |
| sync-issue-to-plan | PostToolUse[Bash] | No | Syncs gh issue edit back to plan file |
| enhance-commit-context | PostToolUse[Bash] | No | Enriches commits with context |
| await-pr-status | PostToolUse[Bash] | No | Detects PR creation, suggests CI check |
| post-explore-findings | SubagentStop | No | Posts Explore agent findings as comments |
| commit-session-await-ci-status | Stop | Yes | Validates git state, reports PR status |
| close-issue-on-session-end | SessionEnd | No | Closes issue if session ends without PR |

## Skills

| Skill | Purpose |
|-------|---------|
| issue-management | Create, update, label, and link issues with templates |
| branch-orchestration | Smart branch naming, lifecycle management |
| ci-orchestration | CI/CD monitoring with fail-fast patterns |
| pr-workflow | PR lifecycle with auto-generated descriptions |

## Agents

| Agent | Purpose |
|-------|---------|
| github-orchestrator | Coordinates complex multi-step workflows |

## Installation

```bash
claude plugin install github-orchestration@constellos
```

## See Also

- [README.md](./README.md)
- [Marketplace](../../CLAUDE.md)
