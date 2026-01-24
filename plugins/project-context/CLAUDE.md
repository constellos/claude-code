---
title: Project Context Plugin
description: Context discovery, structure validation, and rule-based checks
version: 0.1.1
folder:
  subfolders:
    allowed: [.claude-plugin, hooks, skills, shared]
    required: [.claude-plugin, hooks]
  files:
    allowed: [CLAUDE.md, README.md, .gitignore]
    required: [README.md]
---

# Project Context Plugin

Automatic CLAUDE.md discovery, .claude structure validation, and rule-based checks for file edits.

## Hook Summary

| Hook | Event | Blocking | Purpose |
|------|-------|----------|---------|
| encourage-context-review | UserPromptSubmit | No | Encourages CLAUDE.md updates |
| log-task-call | PreToolUse[Task] | No | Saves task context |
| validate-folder-structure-write | PreToolUse[Write\|Edit] | Yes | Validates .claude structure |
| validate-rules-file | PreToolUse[Write\|Edit] | Yes | Validates rule frontmatter |
| validate-folder-structure-mkdir | PreToolUse[Bash] | Yes | Validates mkdir commands |
| try-markdown-page | PreToolUse[WebFetch] | No | Redirects to .md URLs |
| log-task-result | PostToolUse[Task] | No | Logs task results |
| track-task-scope | PostToolUse[Write\|Edit] | No | Advisory when file outside task scope |
| add-folder-context | PostToolUse[Read] | No | Discovers CLAUDE.md files |

## Skills

| Skill | Purpose |
|-------|---------|
| feature-sliced-design | FSD architecture for Next.js |

## Installation

```bash
claude plugin install project-context@constellos
```

## See Also

- [README.md](./README.md)
- [Marketplace](../../CLAUDE.md)
