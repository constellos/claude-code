---
title: Next.js Supabase AI SDK Dev Plugin
description: Development tooling for Next.js, Supabase, and AI SDK projects
version: 0.1.2
folder:
  subfolders:
    allowed: [.claude-plugin, hooks, agents, skills, shared, output-styles, templates]
    required: [.claude-plugin, hooks]
  files:
    allowed: [CLAUDE.md, README.md, .gitignore]
    required: [README.md]
---

# Next.js Supabase AI SDK Dev Plugin

Local dev environment setup for Vercel/Supabase and systematic UI development with 6 progressive skills and 4 specialized agents.

## Hook Summary

| Hook | Event | Blocking | Purpose |
|------|-------|----------|---------|
| install-vercel | SessionStart | No | Installs Vercel CLI |
| install-start-supabase-next | SessionStart | No | Sets up Supabase local dev, installs dependencies (skips if fresh), starts dev servers (Next.js, Cloudflare, Elysia, Turborepo) with health checks |
| cache-supabase-schema | SessionStart | No | Caches Supabase table/column metadata for context matching |
| run-file-eslint | PostToolUse[Write\|Edit] | Yes | Runs ESLint on edited files |
| run-file-vitests | PostToolUse[Write\|Edit] | No | Runs related tests (warns only) |
| move-playwright-screenshots | PostToolUse[browser_eval] | No | Moves screenshots to .claude/screenshots/ to prevent permission prompts |
| run-task-vitests | SubagentStop | Yes | Runs tests for all task edits |
| run-task-typechecks | SubagentStop | Yes | Runs tsc --noEmit after task |
| run-session-typechecks | Stop | Yes | Runs tsc --noEmit before session stops |
| cleanup-supabase-session | SessionEnd | No | Stops Supabase containers, restores config.toml, marks session stopped |

## Agents

| Agent | Purpose |
|-------|---------|
| ui-developer | Full UI implementation (all 6 skills) |
| ui-reviewer | Visual quality review |
| ui-tester | Mobile/desktop viewport testing |
| ui-researcher | Design research and screenshots |

## Skills

| Skill | Purpose |
|-------|---------|
| supabase-local-dev | Supabase local dev setup, Docker, migrations, types |
| ui-wireframing | ASCII wireframes (mobile-first) |
| ui-design | Static UI, compound components |
| ui-interaction | Client state, Zod validation |
| ui-integration | Server actions, Supabase |
| ai-sdk-ui | AI SDK streaming UI |

## Installation

```bash
claude plugin install nextjs-supabase-ai-sdk-dev@constellos
```

## See Also

- [README.md](./README.md)
- [Marketplace](../../CLAUDE.md)
