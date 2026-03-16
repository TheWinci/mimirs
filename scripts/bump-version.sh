#!/usr/bin/env bash
set -euo pipefail

# Bump version in package.json and sync to plugin.json.
# Usage: ./scripts/bump-version.sh [patch|minor|major|<version>]
# Default: patch

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="$ROOT/package.json"
PLUGIN="$ROOT/.claude-plugin/plugin.json"

BUMP="${1:-patch}"

# Read current version
CURRENT=$(grep -o '"version": "[^"]*"' "$PKG" | head -1 | sed 's/"version": "//;s/"//')

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$BUMP"
else
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  case "$BUMP" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    *) echo "Usage: $0 [patch|minor|major|<version>]"; exit 1 ;;
  esac
  NEW="$MAJOR.$MINOR.$PATCH"
fi

# Update package.json
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" "$PKG"

# Update plugin.json
PLUGIN_CURRENT=$(grep -o '"version": "[^"]*"' "$PLUGIN" | head -1 | sed 's/"version": "//;s/"//')
sed -i '' "s/\"version\": \"$PLUGIN_CURRENT\"/\"version\": \"$NEW\"/" "$PLUGIN"

echo "$CURRENT -> $NEW"
echo "  $PKG"
echo "  $PLUGIN"

# Commit and tag
git -C "$ROOT" add "$PKG" "$PLUGIN"
git -C "$ROOT" commit -m "$NEW"
git -C "$ROOT" tag -a "v$NEW" -m "v$NEW"

echo "Committed and tagged v$NEW"
