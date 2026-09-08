---
title: Shared Utilities Library
description: TypeScript utilities and types shared across all plugins in the marketplace
tags: [shared, utilities, types, hooks, io, debug, typescript]
folder:
  subfolders:
    allowed: [hooks, rules, types]
    required: [hooks, types]
  files:
    allowed: [CLAUDE.md, README.md, .gitignore]
    required: [CLAUDE.md]
---

# Shared Utilities Library

TypeScript utilities and types shared across all plugins in the Claude Code marketplace.

## Overview

The `shared/` directory contains TypeScript utilities, hook implementations, and type definitions that can be imported by any plugin in the marketplace. This provides consistent typing, shared functionality, and eliminates code duplication.

## Directory Structure

```
shared/
├── lib/                      # Utility modules
│   ├── types.ts             # Hook type definitions
│   ├── io.ts                # File operations
│   ├── debug.ts             # Debug logging
│   ├── transcripts.ts       # Transcript parsing
│   ├── subagent-state.ts    # Subagent context management
│   ├── package-manager.ts   # Package manager detection
│   └── index.ts             # Re-exports all utilities
│
├── hooks/                    # Shared hook implementations (deprecated)
│   ├── log-subagent-start.ts  # SubagentStart hook (moved to logging plugin)
│   └── log-subagent-stop.ts   # SubagentStop hook (moved to logging plugin)
│
├── runner.ts                # TypeScript hook runner
└── CLAUDE.md                # This file
```

## Core Modules

### types.ts - Hook Type Definitions

Provides TypeScript types for all hook events:

```typescript
export interface HookInput {
  event: string;
  cwd: string;
  // ... full typing for all hook events
}

export interface HookOutput {
  success: boolean;
  message?: string;
  // ... typed outputs
}
```

**Key Types:**
- `SessionStartInput` / `SessionStartHookOutput`
- `PostToolUseInput` / `PostToolUseHookOutput`
- `SubagentStartInput` / `SubagentStartHookOutput`
- `SubagentStopInput` / `SubagentStopHookOutput`
- `PreToolUseInput` / `PreToolUseHookOutput`
- `UserPromptSubmitInput` / `UserPromptSubmitHookOutput`
- `StopInput` / `StopHookOutput`

### io.ts - File Operations

Helper functions for file I/O:

```typescript
export async function readJson<T>(path: string): Promise<T>
export async function writeJson(path: string, data: any): Promise<void>
export async function readFile(path: string): Promise<string>
export async function writeFile(path: string, content: string): Promise<void>
export async function fileExists(path: string): Promise<boolean>
```

### debug.ts - Debug Logging

Debug logger with `DEBUG` environment variable support:

```typescript
export function createDebugLogger(
  cwd: string,
  namespace: string,
  writeToFile: boolean = false
): DebugLogger
```

**Usage:**
```typescript
import { createDebugLogger } from '../../../shared/lib/debug.js';

const logger = createDebugLogger(input.cwd, 'my-hook', true);
await logger.logInput({ tool_name: input.tool_name });
await logger.logOutput({ success: true });
```

**Enable debug output:**
```bash
DEBUG=* claude              # All debug output
DEBUG=my-hook claude        # Specific namespace
DEBUG=hook1,hook2 claude    # Multiple namespaces
```

### transcripts.ts - Transcript Parsing

Parse Claude Code transcript JSONL files:

```typescript
export async function parseTranscript(path: string): Promise<Transcript>
export function extractToolCalls(messages: Message[]): ToolCall[]
export function extractWriteOperations(messages: Message[]): WriteOperation[]
```

**Usage:**
```typescript
import { parseTranscript } from '../../../shared/lib/transcripts.js';

const transcript = await parseTranscript(input.agent_transcript_path);
console.log('Agent ID:', transcript.agentId);
console.log('Messages:', transcript.messages.length);
```

### subagent-state.ts - Subagent Context Management

Manage subagent execution context and analyze file operations:

```typescript
export async function saveAgentStartContext(context: AgentContext): Promise<SavedContext>
export async function getAgentEdits(transcriptPath: string): Promise<AgentEdits>
```

**Usage:**
```typescript
import { getAgentEdits } from '../../../shared/lib/subagent-state.js';

const edits = await getAgentEdits(input.agent_transcript_path);
console.log('Files created:', edits.agentNewFiles);
console.log('Files edited:', edits.agentEditedFiles);
console.log('Files deleted:', edits.agentDeletedFiles);
```

### package-manager.ts - Package Manager Detection

Detect which package manager a project uses:

```typescript
export function detectPackageManager(cwd: string): PackageManager
export function getScriptCommand(cwd: string, script: string): string
```

**Supported package managers:** npm, yarn, pnpm, bun

**Usage:**
```typescript
import { getScriptCommand } from '../../../shared/lib/package-manager.js';

const command = getScriptCommand(input.cwd, 'lint');
// Returns: "npm run lint" or "yarn lint" or "pnpm lint" etc.
```

## Hook Runner

### runner.ts

The TypeScript hook runner executes hook files:

```bash
node shared/runner.ts path/to/hook-file.ts
```

**Features:**
- Reads JSON input from stdin
- Passes to hook's default export function
- Writes JSON output to stdout
- Supports `--log` flag for debug output
- Handles errors gracefully

**Usage in hooks.json:**
```json
{
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node ${CLAUDE_PROJECT_DIR}/shared/runner.ts ${CLAUDE_PLUGIN_ROOT}/hooks/my-hook.ts"
        }
      ]
    }
  ]
}
```

## Importing Shared Utilities

All plugins import from `shared/lib/` via relative path:

```typescript
// Import types
import type { HookInput, HookOutput } from '../../../shared/lib/types.ts';

// Import utilities (named imports)
import { readJson, writeJson } from '../../../shared/lib/io.ts';
import { createDebugLogger } from '../../../shared/lib/debug.ts';
import { detectPackageManager } from '../../../shared/lib/package-manager.ts';

// Or import everything
import * as shared from '../../../shared/lib/index.ts';
```

The relative path `../../../shared/lib/` works from any hook file in `plugins/*/hooks/*.ts`.

## Testing

Run tests for shared utilities:

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
```

Test files are located alongside their implementation:
- `shared/lib/types.test.ts`
- `shared/lib/io.test.ts`
- `shared/lib/transcripts.test.ts`
- etc.

## Environment Variables

### DEBUG

Control debug logging output:

```bash
DEBUG=* claude                    # All debug output
DEBUG=namespace1,namespace2       # Multiple namespaces
DEBUG=namespace1* claude          # Wildcard matching
```

## Best Practices

1. **Use TypeScript types** - Import hook types for full type safety
2. **Use debug logger** - Enable tracing with DEBUG environment variable
3. **Handle errors gracefully** - Hooks should be non-blocking by default
4. **Keep utilities focused** - Each module has a single responsibility
5. **Write tests** - Add tests for new utilities
6. **Document functions** - Use JSDoc for all exports

## Architecture Decisions

### Why Shared Utilities?

- **Consistency**: Same patterns across all plugins
- **DRY**: No code duplication
- **Type Safety**: Shared TypeScript types
- **Maintainability**: Single source of truth
- **Testability**: Centralized testing

### Why TypeScript Hook Runner?

- **No Build Step**: Uses Node's native TypeScript support
- **Simple**: stdin/stdout JSON communication
- **Portable**: Works across all plugins
- **Type-Safe**: Full TypeScript type checking

## Contributing

When adding new shared utilities:

1. Add implementation to `shared/lib/`
2. Export from `shared/lib/index.ts`
3. Add TypeScript types to `shared/lib/types.ts` (if needed)
4. Add tests to `shared/lib/*.test.ts`
5. Update this documentation
6. Use in plugins via relative import

## See Also

- Parent: `/CLAUDE.md` - Marketplace overview
- `plugins/*/CLAUDE.md` - Individual plugin documentation
- `.claude/skills/claude-hooks/SKILL.md` - Hook development guide
