#!/usr/bin/env bash
# Git hooks aren't versioned, so run this after a fresh clone: it installs the publish guard.
set -euo pipefail
hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
mkdir -p "$hooks"
cp "$(git rev-parse --show-toplevel)/scripts/drop-guard-pre-push.sh" "$hooks/pre-push"
chmod +x "$hooks/pre-push"
git config --get-all drop.privateRemotes | grep -qx forgejo || git config --add drop.privateRemotes forgejo
echo "installed $hooks/pre-push"
