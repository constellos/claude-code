#!/bin/bash
# Refresh constellos plugins by clearing cache and reinstalling
# Reads enabled plugins from .claude/settings.json dynamically

SETTINGS_FILE=".claude/settings.json"

echo "🔄 Refreshing constellos plugins..."

# Extract enabled constellos and constellos-local plugins from settings.json
PLUGINS=$(jq -r '.enabledPlugins | keys[] | select(endswith("@constellos") or endswith("@constellos-local"))' "$SETTINGS_FILE")

if [ -z "$PLUGINS" ]; then
  echo "⚠️  No constellos plugins found in settings.json"
  exit 0
fi

# Uninstall all enabled constellos plugins
while IFS= read -r plugin; do
  echo "  - Uninstalling $plugin..."
  claude plugin uninstall --scope project "$plugin" 2>/dev/null || true
done <<< "$PLUGINS"

# Clear constellos and constellos-local cache directories
echo "  - Clearing constellos caches..."
rm -rf ~/.claude/plugins/cache/constellos/* 2>/dev/null || true
rm -rf ~/.claude/plugins/cache/constellos-local 2>/dev/null || true
rm -rf ~/.claude/plugins/cache/.constellos-local-caches/* 2>/dev/null || true

# Reinstall all enabled constellos plugins
while IFS= read -r plugin; do
  echo "  - Installing $plugin..."
  claude plugin install --scope project "$plugin" 2>/dev/null || true
done <<< "$PLUGINS"

echo "✅ Plugin refresh complete - fresh plugins ready for next session"
