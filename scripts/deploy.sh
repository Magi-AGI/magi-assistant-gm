#!/usr/bin/env bash
# deploy.sh — Deploy Magi ecosystem services to the production server.
#
# Usage: ./scripts/deploy.sh [component...]
#   Components: gm, discord, foundry, all (default: all)
#
# Requires SSH access to magi-archive (configured in ~/.ssh/config).
# Refuses to deploy if any repo has a dirty working tree on the server.

set -euo pipefail

SERVER="magi-archive"
REPOS=(
  "gm:/home/ubuntu/magi-assistant-gm:magi-assistant-gm"
  "discord:/home/ubuntu/magi-assistant-discord:magi-assistant-discord"
  "foundry:/home/ubuntu/magi-assistant-foundry:magi-assistant-foundry"
)

# Parse arguments
COMPONENTS=("${@:-all}")

should_deploy() {
  local component="$1"
  for c in "${COMPONENTS[@]}"; do
    if [[ "$c" == "all" || "$c" == "$component" ]]; then
      return 0
    fi
  done
  return 1
}

echo "=== Magi Deployment ==="
echo ""

# Pre-flight: check for dirty repos
DIRTY=0
for entry in "${REPOS[@]}"; do
  IFS=: read -r name path service <<< "$entry"
  if ! should_deploy "$name"; then continue; fi

  STATUS=$(ssh "$SERVER" "cd $path && git status --short 2>/dev/null | grep -v '^??' | head -5" || true)
  if [[ -n "$STATUS" ]]; then
    echo "DIRTY: $name ($path)"
    echo "$STATUS"
    DIRTY=1
  fi
done

if [[ "$DIRTY" -eq 1 ]]; then
  echo ""
  echo "ERROR: Dirty working tree(s) detected. Commit or stash changes before deploying."
  echo "  Note: config.json is expected to be modified (local-only config)."
  echo "  Use 'git stash' on the server to temporarily save changes."
  exit 1
fi

# Deploy each component
for entry in "${REPOS[@]}"; do
  IFS=: read -r name path service <<< "$entry"
  if ! should_deploy "$name"; then continue; fi

  echo "--- Deploying: $name ---"

  # Pull and build
  ssh "$SERVER" "cd $path && git pull && npm run build 2>&1 | tail -3"

  # Restart service
  ssh "$SERVER" "sudo systemctl restart $service"
  echo "  Restarted $service"

  # Show version
  COMMIT=$(ssh "$SERVER" "cd $path && git log --oneline -1")
  echo "  Version: $COMMIT"
  echo ""
done

echo "=== Deployment complete ==="

# Verify all services
echo ""
echo "--- Service Status ---"
for entry in "${REPOS[@]}"; do
  IFS=: read -r name path service <<< "$entry"
  if ! should_deploy "$name"; then continue; fi
  STATUS=$(ssh "$SERVER" "systemctl is-active $service 2>/dev/null" || echo "unknown")
  COMMIT=$(ssh "$SERVER" "cd $path && git rev-parse --short HEAD 2>/dev/null" || echo "?")
  echo "  $name: $STATUS ($COMMIT)"
done
