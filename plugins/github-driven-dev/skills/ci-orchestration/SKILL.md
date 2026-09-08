---
name: CI Orchestration
description: Use this skill when the user wants to "check CI", "wait for CI", "CI status", "retry failed checks", "cancel CI", "debug CI failure", or manage CI/CD workflows. Provides comprehensive CI checking with fail-fast patterns and preview URL extraction.
version: 0.1.0
---

# CI Orchestration

Comprehensive CI/CD workflow management with fail-fast error detection and preview URL extraction.

## Purpose

CI Orchestration provides explicit control over GitHub Actions and other CI systems. Monitor check status, extract preview URLs, debug failures, and manage workflow retries with intelligent fail-fast patterns.

## When to Use

- Waiting for CI checks with real-time status
- Extracting preview deployment URLs (Vercel, Netlify)
- Debugging CI failures
- Retrying failed workflows
- Managing CI in complex workflows

## Core Capabilities

### Check CI Status

```bash
# Check PR status
gh pr checks 42

# Watch and wait
gh pr checks 42 --watch

# Get JSON output
gh pr view 42 --json statusCheckRollup
```

### Extract Preview URLs

The existing `ci-status.ts` utility provides comprehensive preview URL extraction:

```typescript
import { extractPreviewUrls } from '../shared/hooks/utils/ci-status.js';

// Extract from CI output
const urls = extractPreviewUrls(ciOutput);
// Returns: { web: 'https://...', marketing: 'https://...' }
```

### Fail-Fast Patterns

```bash
# Wait with fail-fast
awaitCIWithFailFast "$PWD" 42 10  # 10 minute timeout

# Detects:
# - Merge conflicts
# - Branch divergence
# - Failed checks
# - Workflow errors
```

### Retry Failed Checks

```bash
# Get latest workflow run
RUN_ID=$(gh run list --branch $(git branch --show-current) --limit 1 --json databaseId -q '.[0].databaseId')

# Re-run failed jobs
gh run rerun $RUN_ID --failed
```

## Integration with Hooks

| Hook | Behavior |
|------|----------|
| await-pr-status | Waits for CI after `gh pr create` |
| commit-task-await-ci-status | Auto-commits and checks CI on SubagentStop |
| commit-session-await-ci-status | Blocking CI check on Stop |

## Utilities

From `ci-status.ts`:
- `awaitCIWithFailFast(cwd, prNumber, timeout)` - Wait with fail-fast
- `extractPreviewUrls(output)` - Parse Vercel/Netlify URLs
- `getLatestCIRun(cwd, branch)` - Get workflow run ID
- `formatCiChecksTable(checks)` - Format as markdown table

## Examples

### Wait for CI with Preview URLs

```bash
# Create PR
PR=$(gh pr create --title "Add feature" --body "..." --json number -q .number)

# Wait for CI
awaitCIWithFailFast "$PWD" $PR 10

# Extract preview URLs
CHECKS=$(gh pr view $PR --json statusCheckRollup -q '.statusCheckRollup')
PREVIEW=$(extractPreviewUrls "$CHECKS")

echo "Preview: $PREVIEW"
```

### Debug Failed CI

```bash
# Get failed checks
gh pr checks 42 --json name,conclusion,detailsUrl \
  --jq '.[] | select(.conclusion=="FAILURE") | {name, url: .detailsUrl}'

# View logs
gh run view $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --log-failed
```

### Retry with Backoff

```bash
MAX_RETRIES=3
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  if gh pr checks $PR --watch; then
    echo "✓ CI passed"
    break
  fi

  RETRY=$((RETRY + 1))
  if [ $RETRY -lt $MAX_RETRIES ]; then
    echo "Retry $RETRY/$MAX_RETRIES..."
    gh run rerun $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --failed
  fi
done
```

## Best Practices

1. Use fail-fast patterns (10min timeout)
2. Extract and share preview URLs
3. Auto-retry transient failures (max 3 times)
4. Parse logs for actionable errors
5. Update PR comments with CI status
