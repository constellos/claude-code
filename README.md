# Claude Code Plugins

A curated marketplace of plugins that extend Claude Code with typed hooks for development workflows. This repository provides both ready-to-use plugins and shared TypeScript utilities for creating your own.

## Overview

This marketplace contains three production-ready plugins designed for modern development workflows:

- **github-orchestration** - GitHub workflow orchestration with branch context, commit enhancement, and CI management
- **nextjs-supabase-ai-sdk-dev** - Development quality enforcement with linting, type checking, and testing
- **project-context** - Context discovery, folder validation, and documentation management

All plugins leverage shared TypeScript utilities for consistent behavior, comprehensive type safety, and automatic logging. Hooks are self-executable TypeScript files with full type definitions.

## Quick Start

### Installation

1. Add this marketplace to your `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "constellos": {
      "source": {
        "source": "directory",
        "path": "./.claude-plugin"
      }
    }
  }
}
```

2. Install plugins using the CLI:

```bash
claude plugin install github-orchestration@constellos
claude plugin install nextjs-supabase-ai-sdk-dev@constellos
claude plugin install project-context@constellos
```

Or enable them in your settings:

```json
{
  "enabledPlugins": {
    "github-orchestration@constellos": true,
    "nextjs-supabase-ai-sdk-dev@constellos": true,
    "project-context@constellos": true
  }
}
```

## Available Plugins

### GitHub Orchestration (`github-orchestration`)

**Purpose:** Comprehensive GitHub workflow orchestration for issue-driven development with automatic context discovery and commit enhancement.

**Key Features:**
- Displays linked GitHub issue for current branch at session start
- Shows branch sync status (remote tracking branch and origin/main)
- Lists outstanding open issues available for work
- Auto-commits subagent work with task context and git trailers
- Automatically creates/updates GitHub issues from plan files
- Enhances commits with task and issue metadata
- Checks PR status at session end with CI and preview URL reporting
- Installs GitHub CLI on remote environments

**Hooks:**
- **SessionStart** (`install-github.ts`) - Installs GitHub CLI (non-blocking)
- **SessionStart** (`add-github-context.ts`) - Displays branch issue context and sync status (non-blocking)
- **PostToolUse[Write|Edit]** (`sync-plan-to-issue.ts`) - Syncs plan files to GitHub issues (non-blocking)
- **PostToolUse[Bash]** (`enhance-commit-context.ts`) - Enriches commits with task metadata (non-blocking)
- **SubagentStop** (`commit-task.ts`) - Auto-commits agent work (non-blocking)
- **Stop** (`commit-session-check-pr-status.ts`) - Session commit and PR checks (progressive blocking)

**Use Cases:**
- Issue-driven development with branch linking
- Multi-agent workflows with automatic commit documentation
- PR readiness checks before ending sessions
- Automated task documentation through enriched commits

**Documentation:** [plugins/github-orchestration/README.md](./plugins/github-orchestration/README.md)

---

### Next.js Development Tools (`nextjs-supabase-ai-sdk-dev`)

**Purpose:** Enforces code quality through automated checks at both file and project levels for Next.js, Supabase, and AI SDK projects.

**Key Features:**
- Per-file quality checks (ESLint, TypeScript, TSDoc) on every edit
- Automatic test execution when test files are modified
- Comprehensive project-wide validation at session end (blocking)
- Installs Vercel and Supabase CLIs on remote environments
- Encourages UI review after ui-developer agent completes
- Logs all Task tool calls for context in SubagentStop hooks

**Hooks:**
- **SessionStart** (`install-vercel.ts`, `install-supabase.ts`) - CLI installation (non-blocking)
- **PreToolUse[Task]** (shared `log-task-call.ts`) - Task context logging (non-blocking)
- **PostToolUse[Task]** (shared `log-task-result.ts`) - Task result logging (non-blocking)
- **PostToolUse[Task]** (`encourage-ui-review.ts`) - UI review encouragement (non-blocking)
- **PostToolUse[Write|Edit]** (`check-file-eslint.ts`) - ESLint on files (non-blocking, informational)
- **PostToolUse[Write|Edit]** (`check-file-types.ts`) - TypeScript on files (non-blocking, informational)
- **PostToolUse[Write|Edit]** (`check-file-tsdoc.ts`) - TSDoc validation (non-blocking, informational)
- **PostToolUse[Write|Edit test files]** (`check-file-vitest-results.ts`) - Test execution (non-blocking, informational)
- **Stop** (`check-global-eslint.ts`) - Project-wide ESLint (blocking)
- **Stop** (`check-global-types.ts`) - Project-wide TypeScript (blocking)
- **Stop** (`check-global-vitest-results.ts`) - Full test suite (blocking)

**Use Cases:**
- Next.js application development
- TypeScript projects requiring strict type safety
- Projects with comprehensive test suites
- Teams enforcing code quality standards
- CI/CD workflows requiring pre-push validation

**Documentation:** [plugins/nextjs-supabase-ai-sdk-dev/README.md](./plugins/nextjs-supabase-ai-sdk-dev/README.md)

---

### Project Context (`project-context`)

**Purpose:** Automatically discovers and links documentation, validates project structure, and provides intelligent guidance for Claude Code workflows.

**Key Features:**
- Discovers and links CLAUDE.md files when reading project files
- Validates .claude directory structure (agents, skills, rules, hooks)
- Enforces plan-based path scoping for file operations
- Validates rule files require proper Required Skills metadata
- Encourages context updates based on user prompts
- Redirects WebFetch to markdown versions of documentation URLs
- Creates PLAN.md symlink to active plan file
- Comprehensive task tracking and logging

**Hooks:**
- **UserPromptSubmit** (`encourage-context-review.ts`) - Context update encouragement (non-blocking)
- **PreToolUse[Task]** (shared `log-task-call.ts`) - Task logging (non-blocking)
- **PreToolUse[Write|Edit]** (shared `validate-folder-structure-write.ts`) - Folder validation (blocking on violations)
- **PreToolUse[Write|Edit]** (shared `validate-rules-file.ts`) - Rules validation (blocking on errors)
- **PreToolUse[Bash]** (shared `validate-folder-structure-mkdir.ts`) - mkdir validation (blocking on invalid paths)
- **PreToolUse[WebFetch]** (`try-markdown-page.ts`) - Markdown URL preference (non-blocking)
- **PostToolUse[Task]** (shared `log-task-result.ts`) - Task result logging (non-blocking)
- **PostToolUse[Write|Edit]** (`create-plan-symlink.ts`) - Plan symlink creation (non-blocking)
- **PostToolUse[Write|Edit]** (shared `enforce-plan-scoping.ts`) - Plan scope enforcement (can block)
- **PostToolUse[Read]** (`add-folder-context.ts`) - Context discovery (non-blocking)
- **PostToolUse[Read]** (shared `enforce-plan-scoping.ts`) - Read scope guidance (non-blocking)

**Use Cases:**
- Large codebases requiring organized documentation
- Projects with .claude directory structures
- Plan-driven development workflows
- Documentation-heavy projects
- Teams enforcing project structure standards
- Research-oriented development (markdown preference)

**Documentation:** [plugins/project-context/README.md](./plugins/project-context/README.md)

---

## Architecture

```
.
├── .claude-plugin/
│   └── marketplace.json        # Marketplace definition
│
├── shared/                     # Shared utilities for all plugins
│   ├── types/
│   │   └── types.ts           # Hook type definitions
│   ├── hooks/
│   │   ├── utils/             # Hook utilities (I/O, debug, etc.)
│   │   ├── log-task-call.ts   # PreToolUse[Task] hook
│   │   ├── log-task-result.ts # PostToolUse[Task] hook
│   │   ├── validate-folder-structure-write.ts
│   │   ├── validate-folder-structure-mkdir.ts
│   │   ├── validate-rules-file.ts
│   │   └── enforce-plan-scoping.ts
│   └── rules/                  # Rule documentation
│
└── plugins/                    # Individual marketplace plugins
    ├── github-orchestration/
    │   ├── .claude-plugin/plugin.json
    │   ├── README.md
    │   └── hooks/
    │       ├── hooks.json
    │       ├── install-github.ts
    │       ├── add-github-context.ts
    │       ├── sync-plan-to-issue.ts
    │       ├── enhance-commit-context.ts
    │       ├── commit-task.ts
    │       └── commit-session-check-pr-status.ts
    │
    ├── nextjs-supabase-ai-sdk-dev/
    │   ├── .claude-plugin/plugin.json
    │   ├── README.md
    │   └── hooks/
    │       ├── hooks.json
    │       ├── install-vercel.ts
    │       ├── install-supabase.ts
    │       ├── check-file-eslint.ts
    │       ├── check-file-types.ts
    │       ├── check-file-tsdoc.ts
    │       ├── check-file-vitest-results.ts
    │       ├── encourage-ui-review.ts
    │       ├── check-global-eslint.ts
    │       ├── check-global-types.ts
    │       └── check-global-vitest-results.ts
    │
    └── project-context/
        ├── .claude-plugin/plugin.json
        ├── README.md
        └── hooks/
            ├── hooks.json
            ├── encourage-context-review.ts
            ├── add-folder-context.ts
            ├── create-plan-symlink.ts
            └── try-markdown-page.ts
```

## Creating Your Own Plugin

### 1. Create plugin directory structure

```bash
mkdir -p plugins/my-plugin/.claude-plugin
mkdir -p plugins/my-plugin/hooks
```

### 2. Create `plugin.json`

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "My custom plugin",
  "author": { "name": "your-name" }
}
```

### 3. Create `hooks/hooks.json`

**Important:** Hooks must be wrapped in a `"hooks"` object.

```json
{
  "description": "My plugin hooks",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx tsx ${CLAUDE_PLUGIN_ROOT}/hooks/my-hook.ts"
          }
        ]
      }
    ]
  }
}
```

### 4. Create hook file `hooks/my-hook.ts`

```typescript
import type { SessionStartInput, SessionStartHookOutput } from '../../../shared/types/types.js';
import { runHook } from '../../../shared/hooks/utils/io.js';

async function handler(input: SessionStartInput): Promise<SessionStartHookOutput> {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'My hook executed!',
    },
  };
}

export { handler };
runHook(handler);
```

### 5. Add to marketplace.json

```json
{
  "plugins": [
    {
      "name": "my-plugin",
      "source": "./plugins/my-plugin"
    }
  ]
}
```

### 6. Create README.md

Document your plugin following the official Claude Code patterns. See existing plugin READMEs for examples.

## Shared Utilities

All plugins can import from the `shared/` folder for consistent behavior:

### Types (`shared/types/types.ts`)

Full TypeScript typing for all Claude Code hook events:
- SessionStart, SessionEnd, Stop
- PreToolUse, PostToolUse
- SubagentStart, SubagentStop
- UserPromptSubmit
- And more

### Hook Utilities (`shared/hooks/utils/`)

- **io.ts** - stdin/stdout JSON handling and `runHook` wrapper with automatic logging
- **debug.ts** - Debug logging with JSONL output to `.claude/logs/hook-events.json`
- **transcripts.ts** - Parse Claude transcript JSONL files
- **subagent-state.ts** - Save/load/analyze subagent context and file operations
- **task-state.ts** - Task state management for PreToolUse[Task] → SubagentStop flow
- **package-manager.ts** - Detect npm/yarn/pnpm/bun from lockfiles
- **toml.ts** - Simple TOML parser for config files
- **was-tool-event-main-agent.ts** - Detect if tool event is from main agent or subagent

## Development

### Testing

```bash
npm run typecheck     # TypeScript type checking
npm run lint          # ESLint
npm run test          # Vitest
npm run test:watch    # Vitest watch mode
```

### Debug Logging

Enable debug output:

```bash
DEBUG=* claude              # All debug output
DEBUG=plugin-name claude    # Specific plugin
```

Debug logs are written to `.claude/logs/hook-events.json` in JSONL format.

### Local Testing

After editing plugin files:
1. Exit Claude Code session
2. Start new session
3. Changes are automatically loaded

## Troubleshooting

### Plugins Not Loading

**Issue:** Plugins don't appear in Claude Code or hooks don't fire

**Solution:**
1. Verify `.claude/settings.json` has correct marketplace path and enabled plugins
2. Check plugin cache: `~/.claude/plugins/cache/`
3. Reinstall plugins:
   ```bash
   claude plugin uninstall --scope project my-plugin@constellos
   claude plugin install --scope project my-plugin@constellos
   ```
4. Restart Claude Code session

### Hooks Not Firing

**Issue:** Hooks registered but not executing

**Solution:**
1. Verify `hooks.json` has correct format with `"hooks"` wrapper object
2. Check `.claude/logs/hook-events.json` for hook execution logs
3. Ensure hook file paths use `${CLAUDE_PLUGIN_ROOT}` variable
4. Reinstall plugin to refresh cache

### When to Restart vs Reinstall

**Requires NEW session** (exit and restart Claude Code):
- Changes to `.claude/settings.json`
- Adding/removing plugins from marketplace
- Changes to marketplace.json

**Requires plugin REINSTALL** (no session restart needed):
- Changes to `hooks/hooks.json`
- Changes to hook implementation files (.ts)
- Changes to shared utilities
- Bug fixes or improvements

**Reinstall command:**
```bash
claude plugin uninstall --scope project my-plugin@constellos
claude plugin install --scope project my-plugin@constellos
```

## Claude Worktree Launcher (`cw`)

This repository includes `claude-worktree.sh`, a utility script that creates isolated git worktrees for Claude Code sessions. Each session gets its own branch and worktree, enabling parallel development without conflicts.

### Features

- **Isolated Worktrees:** Creates worktrees at `~/.claude-worktrees/{repo}/{branch-name}`
- **Automatic Branch Naming:** Generates unique branch names like `claude-kind-marmot-s7y8gh44`
- **Fresh Remote State:** Always fetches and creates worktree from latest `origin/main` or `origin/master`
- **Plugin Cache Refresh:** Automatically reinstalls plugins to ensure worktree uses current plugin code
- **Worktree Detection:** If already in a worktree, navigates to parent repo first
- **Tab Completion:** Autocomplete repo names from known locations
- **Repo Shortcuts:** Jump to any repo by name or `owner/repo` path

### Setup

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
# Claude Worktree launcher with tab completion
source ~/constellos/claude-code/claude-worktree.sh
```

Then reload your shell:

```bash
source ~/.bashrc  # or source ~/.zshrc
```

You'll see: `cw: Claude worktree command ready (tab completion enabled)`

### Usage

```bash
# From current directory
cw

# Jump to a repo by name (searches ~/constellos, ~/celestian-dev, ~/)
cw lazyjobs
cw nodes-md

# Jump to a repo by owner/name
cw celestian-dev/lazyjobs
cw constellos/claude-code

# Pass CLI flags to Claude
cw --verbose
cw lazyjobs --no-context
```

### Tab Completion

```bash
cw laz<TAB>              # → lazyjobs
cw celestian-dev/<TAB>   # → shows all repos in ~/celestian-dev/
cw con<TAB>              # → constellos/
```

### Known Repo Locations

The script searches these directories (in order):
- `~/constellos/`
- `~/celestian-dev/`
- `~/`

### How It Works

1. Resolves repo from argument (if provided) or uses current directory
2. Detects if you're in a git repository (launches Claude normally if not)
3. If in a worktree, navigates to parent repository first
4. Fetches latest from remote main branch
5. Creates new worktree at `~/.claude-worktrees/{repo}/{branch-name}`
6. Refreshes project-scoped plugin cache
7. Launches Claude Code in the worktree
8. Returns you to the worktree directory when Claude exits

### Dependencies

- `git` - Git version control
- `jq` - JSON processor (optional, for plugin cache refresh)

Install jq if needed:
```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt install jq
```

## Nodes-md MCP Server (Elysia-based)

The [nodes-md](https://github.com/constellos/nodes-md) project includes a custom MCP server built with Elysia and Supabase. This serves as a reference implementation for building MCP servers with the Bun runtime.

### Architecture

- **Framework**: [Elysia](https://elysiajs.com/) - Fast Bun web framework
- **Database**: Supabase for persistent storage
- **Protocol**: Model Context Protocol SDK

### Location

```
~/constellos/nodes-md/apps/mcp/
├── src/
│   └── index.ts          # MCP server implementation
├── package.json          # Dependencies
└── tsconfig.json         # TypeScript config
```

### Available Tools

| Tool | Description |
|------|-------------|
| `hello` | Simple hello world test tool |
| `create_nodeset` | Create a new nodeset in the database |

### Running the Server

```bash
cd ~/constellos/nodes-md/apps/mcp
bun install
bun run src/index.ts
```

### Environment Variables

```bash
SUPABASE_URL=your-supabase-url
SUPABASE_SECRET_KEY=your-service-role-key
PORT=3001  # Optional, defaults to 3001
```

### Using as Reference

This implementation demonstrates:
- Elysia server setup with MCP SDK
- Supabase client initialization
- Tool definition patterns
- Type-safe database operations

## Documentation

Comprehensive documentation:

- **[CLAUDE.md](./CLAUDE.md)** - Detailed technical documentation and architecture
- **Individual plugin READMEs** - Plugin-specific documentation with hooks, configuration, and usage

Skills documentation in `.claude/skills/`:
- **claude-plugins** - Plugin development guide
- **claude-hooks** - Hook types and patterns
- **claude-skills** - Agent Skills
- **claude-commands** - Slash commands
- **claude-agents** - Subagent configuration

## Requirements

- Node.js 18+
- Claude Code CLI
- TypeScript (via tsx)

## License

MIT

## Contributing

Contributions welcome! Please ensure:
- All hooks are self-executable TypeScript files
- Proper typing using `shared/types/types.ts`
- Tests pass (`npm test`)
- Type checking passes (`npm run typecheck`)
- ESLint passes (`npm run lint`)
- Follow official Claude Code plugin patterns
- Document new plugins with comprehensive READMEs
