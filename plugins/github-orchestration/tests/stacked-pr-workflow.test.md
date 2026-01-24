# Stacked PR Workflow Test Results

## Test Date
2026-01-23

## Test Branch
`311-fix/can-u-test-out-the-gh-orchestration-plug`

## Parent Issue
#311

## Hooks Under Test

| Hook | Event | Status |
|------|-------|--------|
| `sync-task-to-subissue.ts` | PostToolUse[Task] | Pending |
| `create-subagent-branch.ts` | SubagentStart | Pending |
| `stacked-pr-subagent-stop.ts` | SubagentStop | Pending |

## Expected Flow

1. Main PR created (this branch → main)
2. Subagent task launched
3. Subissue created and linked to #311
4. Subagent branch created
5. Subagent completes work
6. Stacked PR created (subagent-branch → this branch)
7. PR references subissue with "Closes #X"

## Results

### Test Run 1 (07:33 UTC)
- **Subissue #313** ✅ Created with labels `task`, `subissue`
- **Native sub-issue API** ❌ Returns `[]` (using markdown fallback)
- **Stacked branch** ❌ Not created (no active PR detected yet)

### Test Run 2 (07:35 UTC)
- **Subissue #315** ✅ Created with labels `task`, `subissue`
- **Stacked branch** ✅ Created: `311-fix/can-u-test-out-the-gh-orchestration-plug-subagent-a18c360`
- **Stacked PR** ❌ Failed - Bug in `getTaskEdits()` (wrong parent transcript path)
- **Branch cleanup** ✅ Ran (deleted branch due to error)

### Bug Found
**File**: `plugins/github-orchestration/shared/hooks/utils/task-state.ts:340`

**Issue**: `getTaskEdits()` constructs wrong path for parent transcript
- Agent transcript: `.../project/{sessionId}/subagents/agent-{agentId}.jsonl`
- Code looked for: `.../project/{sessionId}/subagents/{sessionId}.jsonl` ❌
- Should look for: `.../project/{sessionId}.jsonl` ✅

**Fix Applied**: Go up two directory levels from agent transcript path

### Test Run 3 (07:38 UTC)
- **Subissue #316** ✅ Created with labels `task`, `subissue`
- **Stacked branch** ✅ Created but cleaned up due to error
- **Stacked PR** ❌ Still failing (fix not in plugin cache yet)
- **Note**: Fix applied to source but hooks run from `~/.claude/plugins/cache/constellos-local/`

## Summary

| Hook | Status | Notes |
|------|--------|-------|
| `sync-task-to-subissue.ts` | ✅ Working | Creates subissues linked to parent |
| `create-subagent-branch.ts` | ✅ Working | Creates branch when PR exists |
| `stacked-pr-subagent-stop.ts` | ❌ Bug | Path calculation error - fixed in source |

### Issues Created During Test
- #313, #315, #316 - All linked to parent #311

### PRs Created
- #312 - Main PR (this branch → main)
- No stacked PRs (blocked by bug)

### Fix Required
File: `plugins/github-orchestration/shared/hooks/utils/task-state.ts`

Before:
```typescript
const dir = path.dirname(agentTranscriptPath);
const parentPath = path.join(dir, `${sessionId}.jsonl`);
```

After:
```typescript
let dir = path.dirname(agentTranscriptPath);
if (path.basename(dir) === 'subagents') {
  dir = path.dirname(dir);
}
dir = path.dirname(dir);
const parentPath = path.join(dir, `${sessionId}.jsonl`);
```
