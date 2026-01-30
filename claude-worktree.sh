#!/usr/bin/env bash

# Claude Code Worktree Launcher
#
# Creates an isolated git worktree for Claude Code sessions.
# Each session gets its own branch and worktree in ~/.claude-worktrees/{repo}/
#
# Usage:
#   cw [owner/repo] [claude CLI flags]
#
# Examples:
#   cw                          # Use current directory
#   cw lazyjobs                 # Find lazyjobs in known locations
#   cw celestian-dev/lazyjobs   # Use ~/celestian-dev/lazyjobs
#   cw constellos/nodes-md      # Use ~/constellos/nodes-md
#   cw --verbose                # Current dir with claude flags
#
# Setup (add to ~/.bashrc or ~/.zshrc):
#   source ~/constellos/claude-code-plugins/claude-worktree.sh
#
# Self-Update:
#   The script auto-updates from origin/main when sourced or called.
#   If updates are pulled, you'll be prompted to re-source your shell config.
#
# Known repo locations (searched in order):
#   ~/constellos/
#   ~/celestian-dev/
#   ~/

# Store the directory where this script lives (for self-update)
_CW_SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]}" ]]; then
  _CW_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# Known locations to search for repos
_CW_REPO_PATHS=(
  "${HOME}/constellos"
  "${HOME}/celestian-dev"
  "${HOME}"
)

# Output formatting helpers
_cw_section() {
  local title="$1"
  echo ""
  echo "─── $title ───"
}

_cw_item() {
  local status="$1"
  local message="$2"
  echo "  $status $message"
}

# Per-worktree cache isolation helpers
# =====================================

# Generate short hash of worktree path for cache isolation
_cw_worktree_cache_hash() {
  local worktree_path="$1"
  echo "$worktree_path" | sha256sum | cut -c1-12
}

# Get/create worktree-specific cache directory
_cw_get_worktree_cache_dir() {
  local worktree_path="$1"
  local cache_hash=$(_cw_worktree_cache_hash "$worktree_path")
  local cache_base="${HOME}/.claude/plugins/cache/.constellos-local-caches"
  local cache_dir="${cache_base}/${cache_hash}"

  mkdir -p "$cache_dir"
  echo "$cache_dir"
}

# Update the constellos-local symlink to point to worktree cache
_cw_update_cache_symlink() {
  local target_cache="$1"
  local symlink_path="${HOME}/.claude/plugins/cache/constellos-local"

  # If it's an existing directory (not symlink), migrate it
  if [[ -d "$symlink_path" && ! -L "$symlink_path" ]]; then
    local backup_dir="${HOME}/.claude/plugins/cache/.constellos-local-legacy-$(date +%s)"
    mv "$symlink_path" "$backup_dir" 2>/dev/null || rm -rf "$symlink_path"
  fi

  # Create or update symlink atomically
  ln -sfn "$target_cache" "$symlink_path"
}

# Check if a worktree directory is currently in use by any process
# Returns 0 (true) if in use, 1 (false) if not
_cw_worktree_in_use() {
  local wt_path="$1"
  # Check if any process has files open in this directory
  if command -v lsof &>/dev/null; then
    lsof +D "$wt_path" &>/dev/null 2>&1 && return 0
  fi
  return 1
}

# Compute content hash of plugin source files
_cw_plugin_content_hash() {
  local plugin_source_dir="$1"
  find "$plugin_source_dir" -type f \( -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "*.md" \) \
    -exec sha256sum {} \; 2>/dev/null | sort | sha256sum | cut -c1-16
}

# Check if cache needs refresh based on content hash
_cw_cache_needs_refresh() {
  local plugin_name="$1"
  local plugin_source="$2"
  local cache_dir="$3"
  local version="$4"

  local hash_file="${cache_dir}/${plugin_name}/${version}/.content-hash"

  if [[ ! -f "$hash_file" ]]; then
    return 0  # No hash = needs refresh
  fi

  local current_hash=$(_cw_plugin_content_hash "$plugin_source")
  local cached_hash=$(cat "$hash_file" 2>/dev/null)
  [[ "$current_hash" != "$cached_hash" ]]
}

# Save content hash after install
_cw_save_content_hash() {
  local plugin_name="$1"
  local plugin_source="$2"
  local cache_dir="$3"
  local version="$4"

  local hash_dir="${cache_dir}/${plugin_name}/${version}"
  mkdir -p "$hash_dir"
  _cw_plugin_content_hash "$plugin_source" > "${hash_dir}/.content-hash"
}

# Invalidate all worktree caches (forces refresh on next session)
cw_refresh_all_caches() {
  local cache_base="${HOME}/.claude/plugins/cache/.constellos-local-caches"

  if [[ ! -d "$cache_base" ]]; then
    echo "No worktree caches found"
    return 0
  fi

  echo "Invalidating all worktree plugin caches..."

  for cache_dir in "$cache_base"/*/; do
    [[ -d "$cache_dir" ]] || continue

    # Remove content hashes to force refresh on next session
    find "$cache_dir" -name ".content-hash" -delete 2>/dev/null
    echo "  ✔ Invalidated: $(basename "$cache_dir")"
  done

  echo "Done. Caches will refresh on next worktree session."
}

# Self-update function: pulls latest from origin/main if script repo has updates
# If an update is found, exec-reinvokes with the updated script (never returns)
# Returns 0 if no update needed
# Arguments: All arguments to pass to cw on re-invocation
_cw_self_update() {
  # Only update if we know where the script lives and it's a git repo
  if [[ -z "$_CW_SCRIPT_DIR" ]] || [[ ! -d "$_CW_SCRIPT_DIR/.git" ]]; then
    return 0
  fi

  local current_dir="$PWD"
  cd "$_CW_SCRIPT_DIR" || return 0

  # Fetch latest from origin (silently)
  if ! git fetch origin main --quiet 2>/dev/null; then
    cd "$current_dir"
    return 0
  fi

  # Get current branch and check if main is behind
  local current_branch=$(git branch --show-current 2>/dev/null)
  local main_hash=$(git rev-parse main 2>/dev/null || git rev-parse origin/main 2>/dev/null)
  local remote_hash=$(git rev-parse origin/main 2>/dev/null)

  # If main is up to date, nothing to do
  if [[ "$main_hash" == "$remote_hash" ]]; then
    cd "$current_dir"
    return 0
  fi

  echo "🔄 Updating cw script from origin/main..."

  # If we're not on main, switch to it
  local switched_branch=""
  if [[ "$current_branch" != "main" ]]; then
    # Check for uncommitted changes
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
      echo "⚠️  Uncommitted changes in $current_branch, stashing..."
      git stash push -m "cw-auto-update: stashed from $current_branch" --quiet 2>/dev/null
    fi
    switched_branch="$current_branch"
    if ! git checkout main --quiet 2>/dev/null; then
      echo "⚠️  Could not checkout main, skipping update"
      cd "$current_dir"
      return 0
    fi
  fi

  # Now update main
  if git pull --ff-only origin main --quiet 2>/dev/null; then
    # Switch back to original branch if we switched
    if [[ -n "$switched_branch" ]]; then
      git checkout "$switched_branch" --quiet 2>/dev/null
      # Restore stash if we created one
      if git stash list 2>/dev/null | grep -q "cw-auto-update: stashed from $switched_branch"; then
        git stash pop --quiet 2>/dev/null
      fi
    fi

    echo "✔ cw script updated, re-invoking with new version..."
    echo ""

    # Build quoted args string for re-invocation
    local quoted_args=""
    for arg in "$@"; do
      quoted_args+=" $(printf '%q' "$arg")"
    done

    # Return to original directory before exec
    cd "$current_dir"

    # Exec-reinvoke with updated script - this replaces the current process
    # The new bash will source the updated script file and run cw
    exec bash -c "source '$_CW_SCRIPT_DIR/claude-worktree.sh' && cw$quoted_args"
  else
    echo "⚠️  Could not fast-forward main (local changes?), skipping update"
    # Switch back if we switched
    if [[ -n "$switched_branch" ]]; then
      git checkout "$switched_branch" --quiet 2>/dev/null
    fi
  fi

  cd "$current_dir"
  return 0
}

# Search for repo in local filesystem only
_cw_find_repo_local() {
  local query="$1"

  # If query contains /, treat as owner/repo
  if [[ "$query" == */* ]]; then
    local owner="${query%%/*}"
    local repo="${query#*/}"
    local path="${HOME}/${owner}/${repo}"
    if [[ -d "$path/.git" ]]; then
      echo "$path"
      return 0
    fi
  else
    # Search in known locations
    for base in "${_CW_REPO_PATHS[@]}"; do
      local path="${base}/${query}"
      if [[ -d "$path/.git" ]]; then
        echo "$path"
        return 0
      fi
    done
  fi

  return 1
}

# Search for repo on GitHub using gh CLI
_cw_find_repo_github() {
  local query="$1"

  # Check if gh CLI is authenticated
  if ! command -v gh &>/dev/null || ! gh auth status &>/dev/null 2>&1; then
    return 1
  fi

  local owner_filter=""
  local repo_filter="$query"

  # If query contains /, extract owner and repo separately
  if [[ "$query" == */* ]]; then
    owner_filter="${query%%/*}"
    repo_filter="${query#*/}"
  fi

  # Get list of organizations user belongs to
  local orgs
  orgs=$(gh api user/orgs --jq '.[].login' 2>/dev/null) || orgs=""

  # Collect all repos from user and all orgs
  local all_repos=""

  # Add user's personal repos
  local user_repos
  user_repos=$(gh repo list --limit 1000 --json nameWithOwner,name 2>/dev/null)
  if [[ -n "$user_repos" && "$user_repos" != "[]" ]]; then
    all_repos="$user_repos"
  fi

  # Add repos from each org
  while IFS= read -r org; do
    [[ -z "$org" ]] && continue
    local org_repos
    org_repos=$(gh repo list "$org" --limit 1000 --json nameWithOwner,name 2>/dev/null)
    if [[ -n "$org_repos" && "$org_repos" != "[]" ]]; then
      if [[ -z "$all_repos" || "$all_repos" == "[]" ]]; then
        all_repos="$org_repos"
      else
        # Merge JSON arrays
        all_repos=$(echo "$all_repos" "$org_repos" | jq -s 'add' 2>/dev/null)
      fi
    fi
  done <<< "$orgs"

  # Filter repos matching the query
  local matching_repo=""
  if [[ -n "$owner_filter" ]]; then
    # Exact match for owner/repo format
    matching_repo=$(echo "$all_repos" | jq -r ".[] | select(.nameWithOwner == \"${owner_filter}/${repo_filter}\") | .nameWithOwner" 2>/dev/null | head -1)
  else
    # Match repo name only (first match wins)
    matching_repo=$(echo "$all_repos" | jq -r ".[] | select(.name == \"${repo_filter}\") | .nameWithOwner" 2>/dev/null | head -1)
  fi

  if [[ -n "$matching_repo" ]]; then
    echo "$matching_repo"
    return 0
  fi

  return 1
}

# Clone a repo from GitHub to appropriate local directory
_cw_clone_repo() {
  local repo_full_name="$1"  # Format: owner/repo
  local owner="${repo_full_name%%/*}"
  local repo="${repo_full_name#*/}"

  # Determine target directory based on owner
  local target_dir=""
  if [[ "$owner" == "constellos" ]]; then
    target_dir="${HOME}/constellos"
  elif [[ "$owner" == "celestian-dev" ]]; then
    target_dir="${HOME}/celestian-dev"
  else
    # For other owners, use ~/owner/ directory
    target_dir="${HOME}/${owner}"
  fi

  local repo_path="${target_dir}/${repo}"

  # Check if already exists
  if [[ -d "$repo_path/.git" ]]; then
    echo "$repo_path"
    return 0
  fi

  # Create target directory if needed
  mkdir -p "$target_dir"

  # Clone the repo
  echo "📦 Cloning ${repo_full_name} to ${target_dir/#$HOME/~}..."
  if gh repo clone "$repo_full_name" "$repo_path" 2>/dev/null; then
    echo "✔ Successfully cloned ${repo_full_name}"
    echo "$repo_path"
    return 0
  else
    echo "✘ Failed to clone ${repo_full_name}"
    return 1
  fi
}

# Find a repo by name or owner/name (local first, then GitHub)
_cw_find_repo() {
  local query="$1"

  # 1. Try local search first (fast path)
  local local_path
  local_path=$(_cw_find_repo_local "$query")
  if [[ -n "$local_path" ]]; then
    echo "$local_path"
    return 0
  fi

  # 2. Search GitHub API for repos
  local gh_repo
  gh_repo=$(_cw_find_repo_github "$query")
  if [[ -n "$gh_repo" ]]; then
    # 3. Auto-clone repo if found on GitHub
    _cw_clone_repo "$gh_repo"
    return $?
  fi

  return 1
}

# Get cached GitHub repos for tab completion (5 minute TTL)
_cw_get_cached_github_repos() {
  local cache_file="${HOME}/.cache/cw-github-repos.cache"
  local cache_ttl=300  # 5 minutes in seconds

  # Check if gh CLI is available and authenticated
  if ! command -v gh &>/dev/null || ! gh auth status &>/dev/null 2>&1; then
    return 1
  fi

  # Check if cache exists and is fresh
  if [[ -f "$cache_file" ]]; then
    local cache_age=$(($(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || stat -f %m "$cache_file" 2>/dev/null)))
    if [[ $cache_age -lt $cache_ttl ]]; then
      cat "$cache_file"
      return 0
    fi
  fi

  # Cache is stale or missing, refresh it
  mkdir -p "$(dirname "$cache_file")"

  # Get list of organizations user belongs to
  local orgs
  orgs=$(gh api user/orgs --jq '.[].login' 2>/dev/null) || orgs=""

  # Collect all repos from user and all orgs
  local all_repos=""

  # Add user's personal repos
  local user_repos
  user_repos=$(gh repo list --limit 1000 --json nameWithOwner 2>/dev/null)
  if [[ -n "$user_repos" && "$user_repos" != "[]" ]]; then
    all_repos="$user_repos"
  fi

  # Add repos from each org
  while IFS= read -r org; do
    [[ -z "$org" ]] && continue
    local org_repos
    org_repos=$(gh repo list "$org" --limit 1000 --json nameWithOwner 2>/dev/null)
    if [[ -n "$org_repos" && "$org_repos" != "[]" ]]; then
      if [[ -z "$all_repos" || "$all_repos" == "[]" ]]; then
        all_repos="$org_repos"
      else
        # Merge JSON arrays
        all_repos=$(echo "$all_repos" "$org_repos" | jq -s 'add' 2>/dev/null)
      fi
    fi
  done <<< "$orgs"

  # Write to cache
  if [[ -n "$all_repos" ]]; then
    echo "$all_repos" | jq -r '.[].nameWithOwner' > "$cache_file" 2>/dev/null
    cat "$cache_file"
    return 0
  fi

  return 1
}

# Tab completion function
_cw_completions() {
  local cur="${COMP_WORDS[COMP_CWORD]:-}"
  local repos=()
  local dir repo_name owner base owner_path partial_repo

  # Save and set nullglob to handle empty directories gracefully
  local nullglob_was_set=0
  shopt -q nullglob && nullglob_was_set=1
  shopt -s nullglob

  # Only complete first argument as repo
  if [[ ${COMP_CWORD:-0} -eq 1 ]]; then
    # Check if input has a slash (owner/repo format)
    if [[ "$cur" == */* ]]; then
      owner="${cur%%/*}"
      partial_repo="${cur#*/}"
      owner_path="${HOME}/${owner}"

      if [[ -d "$owner_path" ]]; then
        for dir in "${owner_path}"/*/; do
          [[ -d "${dir}.git" ]] || continue
          repo_name=$(basename "$dir")
          if [[ "$repo_name" == "$partial_repo"* ]]; then
            repos+=("${owner}/${repo_name}")
          fi
        done
      fi
    else
      # No slash - show owner/ prefixes and direct repo matches
      for base in "${_CW_REPO_PATHS[@]:-}"; do
        [[ -z "$base" || "$base" == "$HOME" ]] && continue
        [[ -d "$base" ]] || continue
        owner=$(basename "$base")
        if [[ "$owner" == "$cur"* || -z "$cur" ]]; then
          repos+=("${owner}/")
        fi
        for dir in "${base}"/*/; do
          [[ -d "${dir}.git" ]] || continue
          repo_name=$(basename "$dir")
          if [[ "$repo_name" == "$cur"* ]]; then
            repos+=("$repo_name")
          fi
        done
      done
    fi

    # Add GitHub repos to completions
    local gh_repos
    if gh_repos=$(_cw_get_cached_github_repos 2>/dev/null); then
      while IFS= read -r gh_repo; do
        [[ -z "$gh_repo" ]] && continue

        # If input has slash, filter by full name
        if [[ "$cur" == */* ]]; then
          if [[ "$gh_repo" == "$cur"* ]]; then
            # Check if not already in local repos (avoid duplicates)
            local is_duplicate=false
            for existing in "${repos[@]}"; do
              if [[ "$existing" == "$gh_repo" ]]; then
                is_duplicate=true
                break
              fi
            done
            [[ "$is_duplicate" == false ]] && repos+=("$gh_repo")
          fi
        else
          # No slash - extract repo name and add if matches
          local gh_repo_name="${gh_repo#*/}"
          if [[ "$gh_repo_name" == "$cur"* ]]; then
            # Check for duplicate by repo name
            local is_duplicate=false
            for existing in "${repos[@]}"; do
              if [[ "$existing" == "$gh_repo_name" || "$existing" == "$gh_repo" ]]; then
                is_duplicate=true
                break
              fi
            done
            [[ "$is_duplicate" == false ]] && repos+=("$gh_repo_name")
          fi
        fi
      done <<< "$gh_repos"
    fi
  fi

  # Restore nullglob setting
  [[ $nullglob_was_set -eq 0 ]] && shopt -u nullglob

  COMPREPLY=($(compgen -W "${repos[*]}" -- "$cur" 2>/dev/null)) || COMPREPLY=()

  # If completing owner/, don't add space after
  if [[ ${#COMPREPLY[@]} -eq 1 && "${COMPREPLY[0]}" == */ ]]; then
    compopt -o nospace 2>/dev/null || true
  fi
}

# Detect if script is being sourced or executed
_cw_is_sourced() {
  [[ "${BASH_SOURCE[0]}" != "${0}" ]]
}

# Main worktree creation logic
_cw_main() {
  set -e

  # Self-update check: pull latest script from origin/main if available
  # If update found, _cw_self_update will exec-reinvoke with new script (never returns)
  _cw_self_update "$@"

  local target_repo=""

  # Parse first argument - could be a repo reference or a claude flag
  if [[ $# -gt 0 && "$1" != -* ]]; then
    if _cw_find_repo "$1" >/dev/null 2>&1; then
      target_repo=$(_cw_find_repo "$1")
      shift
    fi
  fi

  # If we have a target repo, cd to it
  if [[ -n "$target_repo" ]]; then
    cd "$target_repo"
  fi

  # Adjectives for branch naming
  local adjectives=(
    admiring agile ambitious bold brave bright calm clever cosmic curious
    dazzling determined eager elegant epic fearless focused gallant gentle happy
    hopeful inspiring inventive jolly keen kind lucid magical merry mindful
    noble optimistic peaceful polished proud quick quirky radiant resolute
    serene sharp sleek smooth stellar stoic swift tender thoughtful tranquil
    upbeat valiant vibrant vigilant vivid warm wise witty zealous zen
  )

  # Animal names for branch naming
  local names=(
    albatross badger cardinal dolphin eagle falcon gecko heron ibis jaguar
    kestrel lemur marmot narwhal otter panda quail raven starling toucan
    urchin viper walrus xerus yak zebra bandicoot capybara dingo echidna
    flamingo gopher hedgehog iguana jackal koala lynx mongoose numbat ocelot
  )

  # Generate unique branch name
  local adj=${adjectives[$RANDOM % ${#adjectives[@]}]}
  local name=${names[$RANDOM % ${#names[@]}]}
  local suffix=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8)
  local branch_name="claude-${adj}-${name}-${suffix}"

  # Defense-in-depth: reject if generated name matches a protected branch
  case "$branch_name" in
    main|master|develop)
      echo "Error: Generated branch name '$branch_name' matches a protected branch."
      return 1
      ;;
  esac

  # Check if we're in a git repository
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    echo "Not in a git repo, launching claude normally..."
    claude "$@"
    return 0
  fi

  # Check if we're currently in a worktree
  if [[ -f .git ]]; then
    local gitdir=$(grep "gitdir:" .git | cut -d' ' -f2)
    local parent_repo=$(echo "$gitdir" | sed 's/\.git\/worktrees\/.*//')

    if [[ -d "$parent_repo" ]]; then
      cd "$parent_repo"
    else
      echo "Error: Could not find parent repository at $parent_repo"
      return 1
    fi
  fi

  # Now we're in the parent repo, proceed with worktree creation
  local repo_root=$(git rev-parse --show-toplevel)
  local repo_name=$(basename "$repo_root")
  local worktree_base="${HOME}/.claude-worktrees/${repo_name}"
  local worktree_dir="${worktree_base}/${branch_name}"

  # Detect remote
  local remote=$(git remote | head -1)
  if [[ -z "$remote" ]]; then
    echo "Error: No git remote configured"
    return 1
  fi

  # Show header
  echo ""
  echo "claude-worktree (cw) ${repo_name}"
  echo "═══════════════════════════════════════"

  # Status checks section
  _cw_section "Status"

  # Check cw script is up to date (already done in _cw_self_update, just report success)
  _cw_item "✔" "cw script up to date"

  # Fetch and check main branch sync
  git fetch --prune "$remote" 2>/dev/null || true

  # Detect main branch
  local main_branch=""
  if git show-ref --verify --quiet "refs/remotes/${remote}/main"; then
    main_branch="main"
  elif git show-ref --verify --quiet "refs/remotes/${remote}/master"; then
    main_branch="master"
  else
    echo "Error: Could not find main or master branch on remote '${remote}'"
    return 1
  fi

  # Sync local main with remote
  local current_branch=$(git branch --show-current)
  if [[ "$current_branch" == "$main_branch" ]]; then
    if git pull --ff-only "$remote" "$main_branch" 2>/dev/null; then
      _cw_item "✔" "local ${main_branch} synced with ${remote}/${main_branch}"
    else
      _cw_item "⚠" "local ${main_branch} has diverged (resolve manually)"
      return 1
    fi
  else
    if git fetch "$remote" "${main_branch}:${main_branch}" 2>/dev/null; then
      _cw_item "✔" "local ${main_branch} synced with ${remote}/${main_branch}"
    else
      _cw_item "⚠" "failed to update local ${main_branch}"
      return 1
    fi
  fi

  # Clean up stale worktrees
  local stale_count=0
  if [[ -d "$worktree_base" ]]; then
    local remote_branches=""
    remote_branches=$(git ls-remote --heads "$remote" 2>/dev/null | awk '{print $2}' | sed 's|refs/heads/||')

    local wt_path=""
    local is_locked=false
    while IFS= read -r line; do
      if [[ "$line" == "worktree "* ]]; then
        wt_path="${line#worktree }"
        is_locked=false
      elif [[ "$line" == "locked"* ]]; then
        is_locked=true
      elif [[ "$line" == "branch "* ]]; then
        local branch="${line#branch refs/heads/}"
        if [[ "$wt_path" == "$worktree_base"/* && "$branch" == claude-* ]]; then
          if [[ "$is_locked" != true ]]; then
            # Check if branch exists on remote (source of truth)
            # Do NOT check local refs - worktree branches are isolated and won't appear in base repo
            # Only delete worktrees for branches that have been deleted from remote
            local should_remove=false
            if [[ -n "$remote_branches" ]] && ! echo "$remote_branches" | grep -qx "$branch"; then
              should_remove=true
            fi
            if [[ "$should_remove" == true ]]; then
              # Safety: skip worktrees with active processes (e.g., running Claude sessions)
              if _cw_worktree_in_use "$wt_path"; then
                continue
              fi
              if git worktree remove --force "$wt_path" 2>/dev/null; then
                ((stale_count++)) || true
              fi
            fi
          fi
        fi
        wt_path=""
        is_locked=false
      elif [[ -z "$line" ]]; then
        wt_path=""
        is_locked=false
      fi
    done < <(git worktree list --porcelain)
    git worktree prune 2>/dev/null
  fi

  if [[ $stale_count -gt 0 ]]; then
    _cw_item "✔" "cleaned ${stale_count} stale worktree(s)"
  fi

  # Create worktree
  _cw_section "Worktree"
  if ! git worktree add -b "$branch_name" "$worktree_dir" "${remote}/${main_branch}" 2>/dev/null; then
    _cw_item "✘" "failed to create worktree"
    return 1
  fi
  _cw_item "✔" "branch: ${branch_name}"
  _cw_item "✔" "path: ${worktree_dir/#$HOME/~}"

  # Lock worktree to prevent cleanup by other cw instances during active session
  git worktree lock "$worktree_dir" --reason "Claude Code session active" 2>/dev/null || true
  _cw_item "✔" "locked for session"

  cd "$worktree_dir"

  # Plugin refresh (non-fatal)
  set +e
  local settings_file="${worktree_dir}/.claude/settings.json"
  local marketplace_file="${worktree_dir}/.claude-plugin/marketplace.json"
  local registered_local_marketplace=""
  local has_marketplace_output=false

  if [[ -f "$settings_file" ]] && command -v jq &>/dev/null; then
    # Local marketplace registration (only for plugin repos with marketplace.json)
    if [[ -f "$marketplace_file" ]]; then
      local has_local_marketplace=$(jq -r '.extraKnownMarketplaces["constellos-local"] // empty' "$settings_file" 2>/dev/null)

      if [[ -n "$has_local_marketplace" ]]; then
        # Get worktree-specific cache directory (per-worktree isolation)
        local wt_cache_dir=$(_cw_get_worktree_cache_dir "$worktree_dir")

        # NOTE: Symlink update is deferred until AFTER plugins are installed
        # This prevents race condition where hooks execute from empty cache

        local current_path=$(claude plugin marketplace list 2>/dev/null | grep -A1 "constellos-local" | grep "Directory" | sed 's/.*(\(.*\))/\1/')

        if [[ -z "$current_path" || "$current_path" != "$worktree_dir" ]]; then
          claude plugin marketplace remove constellos-local &>/dev/null || true
          # DO NOT rm -rf the shared cache - each worktree has isolated cache via symlink

          if [[ "$has_marketplace_output" == false ]]; then
            _cw_section "Marketplace"
            has_marketplace_output=true
          fi

          if claude plugin marketplace add "$worktree_dir" &>/dev/null; then
            _cw_item "✔" "constellos-local registered"
            registered_local_marketplace="constellos-local"
          else
            _cw_item "⚠" "constellos-local failed"
          fi
        else
          registered_local_marketplace="constellos-local"
        fi
      fi
    fi

    # Update git-based marketplaces
    local marketplace_names=$(jq -r '.extraKnownMarketplaces | keys[]' "$settings_file" 2>/dev/null)
    if [[ -n "$marketplace_names" ]]; then
      while IFS= read -r marketplace_name; do
        local marketplace_source=$(jq -r ".extraKnownMarketplaces[\"$marketplace_name\"].source.source" "$settings_file" 2>/dev/null)
        local marketplace_path="$HOME/.claude/plugins/marketplaces/$marketplace_name"

        if [[ "$marketplace_source" == "github" || "$marketplace_source" == "git" ]] && [[ -d "$marketplace_path/.git" ]]; then
          if [[ "$has_marketplace_output" == false ]]; then
            _cw_section "Marketplace"
            has_marketplace_output=true
          fi

          if git -C "$marketplace_path" fetch origin main --quiet 2>/dev/null && \
             git -C "$marketplace_path" reset --hard origin/main --quiet 2>/dev/null; then
            _cw_item "✔" "${marketplace_name} updated"
          else
            _cw_item "⚠" "${marketplace_name} (cached)"
          fi
        fi
      done <<< "$marketplace_names"
    fi

    # Install plugins from worktree settings
    local plugins=$(jq -r '.enabledPlugins | keys[]' "$settings_file" 2>/dev/null)
    if [[ -n "$plugins" ]]; then
      _cw_section "Plugins"
      local plugin_count=0
      local installed_count=0

      while IFS= read -r plugin; do
        local plugin_name="${plugin%@*}"
        local marketplace="${plugin#*@}"

        ((plugin_count++)) || true

        # For local marketplace plugins, use content-hash based refresh
        if [[ "$marketplace" == "$registered_local_marketplace" ]] && [[ -n "$wt_cache_dir" ]]; then
          # Get plugin source path and version from marketplace.json
          local plugin_source_rel=$(jq -r ".plugins[] | select(.name == \"$plugin_name\") | .source" "$marketplace_file" 2>/dev/null)
          local plugin_version=$(jq -r ".plugins[] | select(.name == \"$plugin_name\") | .version" "$marketplace_file" 2>/dev/null)
          local plugin_source="${worktree_dir}/${plugin_source_rel#./}"

          if [[ -n "$plugin_source_rel" ]] && [[ -d "$plugin_source" ]]; then
            # Check if content hash changed (plugin source files modified)
            if _cw_cache_needs_refresh "$plugin_name" "$plugin_source" "$wt_cache_dir" "$plugin_version"; then
              # Clear only this plugin from worktree-specific cache
              rm -rf "${wt_cache_dir}/${plugin_name}" 2>/dev/null || true

              if claude plugin install --scope project "$plugin" &>/dev/null; then
                _cw_save_content_hash "$plugin_name" "$plugin_source" "$wt_cache_dir" "$plugin_version"
                _cw_item "✔" "${plugin} (refreshed)"
                ((installed_count++)) || true
              else
                _cw_item "✘" "${plugin}"
              fi
            else
              _cw_item "✔" "${plugin} (cached)"
              ((installed_count++)) || true
            fi
          else
            _cw_item "✔" "${plugin}"
            ((installed_count++)) || true
          fi
          continue
        fi

        # For remote marketplace plugins, standard install
        # Uninstall quietly
        claude plugin uninstall --scope project "$plugin" &>/dev/null || true

        # Clear this plugin's cache
        rm -rf ~/.claude/plugins/cache/"${marketplace}"/"${plugin_name}" 2>/dev/null || true

        # Reinstall (suppress verbose output)
        if claude plugin install --scope project "$plugin" &>/dev/null; then
          _cw_item "✔" "${plugin}"
          ((installed_count++)) || true
        else
          _cw_item "✘" "${plugin}"
        fi
      done <<< "$plugins"
    fi

    # Update symlink AFTER plugins are installed to prevent race condition
    # where SessionStart hooks execute from empty cache directory
    if [[ -n "$wt_cache_dir" ]]; then
      _cw_update_cache_symlink "$wt_cache_dir"
    fi
  fi
  set -e

  # Ready message
  echo ""
  echo "Ready!"

  # Unlock worktree when Claude session fully ends (shell EXIT, not Stop/Compact events)
  trap "git worktree unlock '$worktree_dir' 2>/dev/null || true" EXIT

  # Launch Claude Code
  claude "$@" || true  # Ignore exit code to prevent set -e from terminating shell
  echo ""
  echo "Claude exited. You're in: $(pwd)"
}

# The cw function that users call
cw() {
  _cw_main "$@"
}

# Setup when sourced
if _cw_is_sourced; then
  # Zsh compatibility
  if [[ -n "$ZSH_VERSION" ]]; then
    autoload -U +X bashcompinit && bashcompinit 2>/dev/null
  fi

  # Register completion
  complete -F _cw_completions cw 2>/dev/null

  # Success message (only on interactive shells)
  if [[ $- == *i* ]]; then
    echo "cw: Claude worktree command ready (tab completion enabled)"
  fi
else
  # Script executed directly
  _cw_main "$@"
fi
