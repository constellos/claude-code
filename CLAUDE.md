# Claude Code Plugins

Plugin marketplace with shared TypeScript utilities for typed hooks.

## Plugins

| Plugin | Purpose |
|--------|---------|
| [github-driven-dev](./plugins/github-driven-dev/) | GitHub workflow orchestration, branch context, CI |
| [project-context](./plugins/project-context/) | CLAUDE.md discovery, validation |
| [nextjs-supabase-ai-sdk-dev](./plugins/nextjs-supabase-ai-sdk-dev/) | Vercel/Supabase, UI dev system |

## Hook Pattern

```typescript
import type { SessionStartInput, SessionStartHookOutput } from '../shared/types/types.js';
import { runHook } from '../shared/hooks/utils/io.js';

async function handler(input: SessionStartInput): Promise<SessionStartHookOutput> {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Hook executed',
    },
  };
}

export { handler };
runHook(handler);
```

**Important**: Imports use `../shared/` (plugin-local), NOT `../../../shared/` (repo root).

## hooks.json

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx tsx ${CLAUDE_PLUGIN_ROOT}/hooks/my-hook.ts" }] }]
  }
}
```

Variables: `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`

## Installation

```bash
claude plugin install plugin-name@constellos
```

## Troubleshooting

- **Hooks not firing**: Check `~/.claude/plugins/cache/`, reinstall plugin, restart session
- **Cache stale**: `rm -rf ~/.claude/plugins/cache/constellos && claude plugin install --scope project`

## Debug

```bash
DEBUG=hook-name claude
```

Logs: `.claude/logs/hook-events.json`
