#!/bin/bash
# Test script for folder validation hooks
# Tests validate-folder-structure-bash.ts and validate-folder-structure-write.ts

set -e

echo "Testing folder validation hooks..."
echo ""

CWD="/home/user/claude-code-plugins"
SESSION_ID="test-session-123"
TRANSCRIPT_PATH="/tmp/test-transcript.jsonl"

# Test 1: validate-folder-structure-bash.ts with allowed folder
echo "=== Test 1: Bash hook - allowed subfolder (should allow) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_1",
  "tool_name": "Bash",
  "tool_input": {
    "command": "mkdir shared/types"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-bash.ts"
echo ""

# Test 2: validate-folder-structure-bash.ts with forbidden folder
echo "=== Test 2: Bash hook - forbidden subfolder (should deny) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_2",
  "tool_name": "Bash",
  "tool_input": {
    "command": "mkdir shared/invalid_folder"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-bash.ts"
echo ""

# Test 3: validate-folder-structure-bash.ts with mkdir -p
echo "=== Test 3: Bash hook - mkdir with -p flag (should allow) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_3",
  "tool_name": "Bash",
  "tool_input": {
    "command": "mkdir -p shared/types"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-bash.ts"
echo ""

# Test 4: validate-folder-structure-bash.ts with non-mkdir command
echo "=== Test 4: Bash hook - non-mkdir command (should allow) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_4",
  "tool_name": "Bash",
  "tool_input": {
    "command": "ls -la"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-bash.ts"
echo ""

# Test 5: validate-folder-structure-write.ts with allowed file
echo "=== Test 5: Write hook - allowed file in allowed folder (should allow) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_5",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "shared/CLAUDE.md",
    "content": "test"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-write.ts"
echo ""

# Test 6: validate-folder-structure-write.ts with forbidden file
echo "=== Test 6: Write hook - forbidden file (should deny if files spec exists) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_6",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "shared/forbidden.exe",
    "content": "test"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-write.ts"
echo ""

# Test 7: validate-folder-structure-write.ts with file in new subfolder
echo "=== Test 7: Write hook - file in allowed subfolder (should allow) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_7",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "shared/types/new-type.ts",
    "content": "export type NewType = string;"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-write.ts"
echo ""

# Test 8: validate-folder-structure-write.ts with non-Write tool
echo "=== Test 8: Write hook - non-Write tool (should allow) ==="
echo '{
  "hook_event_name": "PreToolUse",
  "session_id": "'"$SESSION_ID"'",
  "transcript_path": "'"$TRANSCRIPT_PATH"'",
  "cwd": "'"$CWD"'",
  "permission_mode": "default",
  "tool_use_id": "tool_use_8",
  "tool_name": "Read",
  "tool_input": {
    "file_path": "shared/CLAUDE.md"
  }
}' | npx tsx "$CWD/shared/hooks/validate-folder-structure-write.ts"
echo ""

echo "All tests completed!"
