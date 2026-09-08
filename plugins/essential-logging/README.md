# Essential Logging Plugin

> Core task execution logging and transcript utilities for all Claude Code sessions

## Purpose

Provides foundational task logging infrastructure that tracks Task tool execution from PreToolUse (before agent starts) through PostToolUse (after completion). Creates a shared state file (`.claude/logs/task-calls.json`) that enables rich commit messages, GitHub integration, and task analytics across all plugins.

**Key capabilities:**
- Automatic task context capture (agent type, prompt, timestamps)
- Shared state coordination between hooks
- Debug logging with `DEBUG=task` environment variable
- Foundation for plugin ecosystem (github-driven-dev, project-context depend on this)

## Contents

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| log-task-call | PreToolUse[Task] | Saves task context before agent execution to `.claude/logs/task-calls.json` for later retrieval |
| log-task-result | PostToolUse[Task] | Logs task completion metrics after agent finishes, using saved context from PreToolUse |

## How It Works

### Task Execution Flow

```
1. User calls Task tool with prompt/agent_type
                    ↓
2. PreToolUse[Task] fires
   └─→ log-task-call.ts
       └─→ saveTaskCallContext() → .claude/logs/task-calls.json
                    ↓
3. Subagent executes and performs file operations
                    ↓
4. PostToolUse[Task] fires (after subagent completes)
   └─→ log-task-result.ts
       └─→ loadTaskCallContext() → Log completion + metrics
                    ↓
5. Other plugins can read task-calls.json
   └─→ github-driven-dev: Creates GitHub subissues
   └─→ project-context: Runs tests for task edits
```

### State File Schema

**File**: `.claude/logs/task-calls.json`

```json
{
  "toolu_abc123": {
    "toolUseId": "toolu_abc123",
    "agentType": "Explore",
    "sessionId": "session-xyz",
    "timestamp": "2026-01-06T10:30:00.000Z",
    "prompt": "Find all API endpoints in the codebase"
  },
  "toolu_def456": {
    "toolUseId": "toolu_def456",
    "agentType": "Plan",
    "sessionId": "session-xyz",
    "timestamp": "2026-01-06T10:35:00.000Z",
    "prompt": "Design implementation for new feature"
  }
}
```

**Lifecycle:**
- **Created**: PreToolUse[Task] via `log-task-call.ts`
- **Read**: PostToolUse[Task], SubagentStop hooks, other plugins
- **Cleaned up**: After processing in PostToolUse or SubagentStop

### Shared Utilities

Located in `shared/hooks/utils/`:

**task-state.ts** - Core context management:
```typescript
// Save task context at PreToolUse
await saveTaskCallContext({
  tool_use_id: 'toolu_abc123',
  agent_type: 'Explore',
  session_id: 'session-xyz',
  prompt: 'Find all API endpoints',
  cwd: '/path/to/project'
});

// Load context at PostToolUse or SubagentStop
const context = await loadTaskCallContext('toolu_abc123', '/path/to/project');
// Returns: { toolUseId, agentType, sessionId, timestamp, prompt }

// Cleanup after processing
await removeTaskCallContext('toolu_abc123', '/path/to/project');

// Comprehensive task analysis (for SubagentStop)
const edits = await getTaskEdits('/path/to/agent-transcript.jsonl');
// Returns: { agentNewFiles, agentEditedFiles, agentDeletedFiles, ... }
```

**Other utilities:**
- `io.ts` - File operations (readJson, writeJson, fileExists)
- `debug.ts` - Debug logger with DEBUG environment variable
- `transcripts.ts` - Parse .jsonl transcript files
- `frontmatter.ts` - YAML frontmatter parsing

## Integration with Other Plugins

### github-driven-dev

Reads `task-calls.json` to:
- **sync-task-to-subissue.ts** - Creates GitHub subissues from Task prompts (excludes Plan/Explore)
- **enhance-commit-context.ts** - Enriches commits with task context and issue references

### project-context

Uses task logging for:
- **run-task-vitests.ts** - Runs tests for all files edited during task
- **run-task-typechecks.ts** - Runs `tsc --noEmit` after task completes

### Custom Plugins

Any plugin can leverage task logging by reading `.claude/logs/task-calls.json`:

```typescript
import { loadTaskCallContext } from 'essential-logging/shared/hooks/utils/task-state.js';

// In your PostToolUse[Task] or SubagentStop hook
const context = await loadTaskCallContext(toolUseId, cwd);
if (context) {
  console.log('Task type:', context.agentType);
  console.log('Task prompt:', context.prompt);
  // Use context for your plugin logic
}
```

## Installation

```bash
# Install from marketplace
claude plugin install essential-logging@constellos

# Verify installation
claude plugin list

# Should show:
# ✓ essential-logging@0.1.0 (constellos)
```

**Important**: This plugin should be listed FIRST in marketplace.json to ensure its hooks fire before other plugins that depend on task context.

## Debug Logging

Enable debug output to trace task execution:

```bash
# Task logging only
DEBUG=task claude

# All plugin debug output
DEBUG=* claude

# Multiple namespaces
DEBUG=task,subagent claude
```

**Debug output shows:**
- When PreToolUse[Task] fires
- Task metadata (tool_use_id, agent_type, prompt preview)
- Context save operations
- When PostToolUse[Task] fires
- Task completion events

**Debug logs written to:**
- Console (stderr)
- `.claude/logs/hook-events.json` (if enabled)

### Example Debug Session

```bash
$ DEBUG=task claude

[PreToolUse:Task] Hook triggered
[PreToolUse:Task] Tool Use ID: toolu_abc123
[PreToolUse:Task] Session ID: session-xyz
[PreToolUse:Task] Agent Type: Explore
[PreToolUse:Task] Prompt: Find all API endpoints in the codebase...
[PreToolUse:Task] Saved task call context
[PreToolUse:Task] Tool Use ID: toolu_abc123
[PreToolUse:Task] Timestamp: 2026-01-06T10:30:00.000Z

[PostToolUse:Task] Hook triggered
[PostToolUse:Task] Tool Use ID: toolu_abc123
[PostToolUse:Task] Session ID: session-xyz
[PostToolUse:Task] Task completed
[PostToolUse:Task] Agent Type: Explore
[PostToolUse:Task] Response: Found 15 API endpoints across 8 files...
```

## Troubleshooting

### Hooks not firing

**Symptom**: No task-calls.json file created, no debug output

**Solutions**:
1. Verify plugin is installed:
   ```bash
   claude plugin list | grep essential-logging
   ```

2. Check plugin cache:
   ```bash
   ls ~/.claude/plugins/cache/constellos/essential-logging/
   ```

3. Reinstall plugin:
   ```bash
   claude plugin uninstall essential-logging@constellos
   rm -rf ~/.claude/plugins/cache/constellos/essential-logging
   claude plugin install --scope project essential-logging@constellos
   ```

### ENOENT errors

**Symptom**: `ENOENT: no such file or directory, posix_spawn '/bin/sh'`

**Cause**: Hook file paths incorrect or plugin cache stale

**Solutions**:
1. Clear plugin cache:
   ```bash
   rm -rf ~/.claude/plugins/cache/constellos/essential-logging
   ```

2. Reinstall:
   ```bash
   claude plugin install --scope project essential-logging@constellos
   ```

3. Verify hooks.json uses correct paths:
   ```json
   {
     "command": "npx tsx ${CLAUDE_PLUGIN_ROOT}/hooks/log-task-call.ts"
   }
   ```

### task-calls.json growing large

**Symptom**: State file contains old/stale entries

**Cause**: Context cleanup failed in PostToolUse or SubagentStop

**Solutions**:
1. Manual cleanup:
   ```bash
   rm .claude/logs/task-calls.json
   ```

2. The file will be recreated on next Task tool use

3. Check for hooks that read but don't cleanup:
   ```typescript
   // Always cleanup after reading
   const context = await loadTaskCallContext(toolUseId, cwd);
   // ... use context ...
   await removeTaskCallContext(toolUseId, cwd); // Important!
   ```

## Architecture

### Why Consolidate Logging?

**Before**: Task logging hooks duplicated across 3+ plugins
- `project-context/shared/hooks/log-task-call.ts`
- `nextjs-supabase-ai-sdk-dev/shared/hooks/log-task-call.ts`
- `github-context/shared/hooks/log-task-call.ts`

**Problems**:
- Code duplication (identical implementations)
- Maintenance burden (fixes needed in multiple places)
- Plugin cache conflicts (ENOENT errors)
- Multiple PreToolUse[Task] hooks competing

**After**: Single source of truth
- `essential-logging/hooks/log-task-call.ts` (one implementation)
- Other plugins READ shared state file
- No duplication, no conflicts
- Easier maintenance and debugging

### Plugin Load Order

Essential-logging must be listed FIRST in marketplace.json:

```json
{
  "plugins": [
    {
      "name": "essential-logging",
      "source": "./plugins/essential-logging"
    },
    {
      "name": "github-driven-dev",
      "source": "./plugins/github-driven-dev"
    }
  ]
}
```

**Why?** Ensures essential-logging's PreToolUse[Task] hook fires BEFORE other plugins that depend on the state file.

## License

MIT
