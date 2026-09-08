---
title: Essential Logging Plugin
description: Core task execution logging and transcript utilities
version: 0.1.0
folder:
  subfolders:
    allowed: [.claude-plugin, hooks, shared]
    required: [.claude-plugin, hooks, shared]
  files:
    allowed: [CLAUDE.md, README.md, .gitignore]
    required: [README.md]
---

# Essential Logging Plugin

## Quick Reference

**Purpose**: Provides core task execution logging infrastructure for all Claude Code sessions. Tracks Task tool execution from PreToolUse (before agent starts) through PostToolUse (after agent completes), saving context to enable rich commit messages, GitHub integration, and task analytics.

**When to use**:
- Automatically enabled for all Claude Code sessions
- No manual intervention required
- Foundation for other plugins (github-driven-dev, project-context)
- Debugging task execution with `DEBUG=task`

## Hook Summary

| Hook | Event | Blocking | Purpose |
|------|-------|----------|---------|
| log-task-call | PreToolUse[Task] | No | Saves task context before agent execution to `.claude/logs/task-calls.json` |
| log-task-result | PostToolUse[Task] | No | Logs task completion after agent finishes using saved context |

## Key Features

### Task Context Coordination

Implements PreToolUse → PostToolUse coordination pattern:

1. **PreToolUse[Task]** - When Task tool is called, saves metadata:
   - `tool_use_id` - Unique identifier for this task execution
   - `agent_type` - Type of agent (Explore, Plan, etc.)
   - `session_id` - Current session ID
   - `prompt` - Task description/instructions
   - `timestamp` - When task started

2. **PostToolUse[Task]** - When Task tool completes:
   - Loads saved context by `tool_use_id`
   - Logs completion metrics (agent type, prompt summary, response)
   - Enables debug output with `DEBUG=task`

### Shared State File

Creates `.claude/logs/task-calls.json` as a coordination mechanism:

```json
{
  "toolu_abc123": {
    "toolUseId": "toolu_abc123",
    "agentType": "Explore",
    "sessionId": "session-xyz",
    "timestamp": "2026-01-06T10:30:00.000Z",
    "prompt": "Find all API endpoints in the codebase"
  }
}
```

This state file enables:
- PostToolUse hooks to retrieve context from PreToolUse
- SubagentStop hooks to correlate file operations with task prompts
- Other plugins (github-driven-dev) to create GitHub subissues from tasks
- Task analytics and debugging

### Plugin-Local Shared Utilities

Includes plugin-local copies of essential utilities in `shared/hooks/utils/`:

- **task-state.ts** - Core context management functions:
  - `saveTaskCallContext()` - Saves task metadata to state file
  - `loadTaskCallContext()` - Retrieves saved context by tool_use_id
  - `removeTaskCallContext()` - Cleans up after processing
  - `getTaskEdits()` - Comprehensive task analysis for SubagentStop

- **io.ts** - File operations (readJson, writeJson, fileExists)
- **debug.ts** - Debug logger with `DEBUG` environment variable support
- **transcripts.ts** - Transcript parsing utilities
- **frontmatter.ts** - YAML frontmatter parsing

## State Files

### task-calls.json

**Location**: `.claude/logs/task-calls.json`

**Purpose**: Stores active task execution contexts during session. Entries are created at PreToolUse[Task] and cleaned up at PostToolUse[Task].

**Schema**:
```json
{
  "[tool_use_id]": {
    "toolUseId": "string",
    "agentType": "string",
    "sessionId": "string",
    "timestamp": "ISO 8601 datetime",
    "prompt": "string"
  }
}
```

**Lifecycle**:
- Created: PreToolUse[Task] via `log-task-call.ts`
- Read: PostToolUse[Task] via `log-task-result.ts`, other plugins (sync-task-to-subissue.ts)
- Deleted: PostToolUse[Task] or SubagentStop (cleanup)

## Installation

```bash
claude plugin install essential-logging@constellos
```

**Note**: This plugin should be installed FIRST (listed first in marketplace.json) to ensure its hooks fire before other plugins that depend on task context.

## Debug Logging

Enable debug output for task logging:

```bash
DEBUG=task claude                # Task logging only
DEBUG=* claude                   # All debug output
```

Debug output shows:
- When task hooks fire
- Task metadata (tool_use_id, agent_type, prompt preview)
- Context save/load operations
- Task completion events

Logs are also written to `.claude/logs/hook-events.json` when debug mode is enabled.

## Architecture

### Why a Dedicated Logging Plugin?

Prior to this plugin, task logging hooks were duplicated across multiple plugins:
- `project-context/shared/hooks/log-task-call.ts`
- `nextjs-supabase-ai-sdk-dev/shared/hooks/log-task-call.ts`
- `github-context/shared/hooks/log-task-call.ts`

This caused:
- Code duplication (identical hooks in 3+ locations)
- Maintenance burden (fixes needed in multiple places)
- Plugin cache conflicts (ENOENT errors)

**Solution**: Consolidate core logging in one plugin that:
- Fires first (listed first in marketplace)
- Provides shared state file (task-calls.json)
- Enables other plugins to read task context without duplication

### Integration with Other Plugins

**github-driven-dev** reads task-calls.json to:
- Create GitHub subissues from Task prompts (sync-task-to-subissue.ts)
- Enhance commits with task context (enhance-commit-context.ts)

**project-context** relies on task logging for:
- Test execution after tasks (run-task-vitests.ts)
- Type checking after tasks (run-task-typechecks.ts)

**All plugins** can use task context via the shared state file without implementing their own PreToolUse[Task] hooks.

## See Also

- [Full Documentation](./README.md) - Comprehensive plugin guide
- [Marketplace](../../CLAUDE.md) - All available plugins
- [Task State Utilities](./shared/hooks/utils/task-state.ts) - Core implementation
