#!/usr/bin/env bash
# Starts an isolated Paseo daemon in development mode for the end-to-end tests.
# Development mode enables the `mock` provider, which needs no credentials.
# It never touches ~/.paseo or the daemon on port 6767.
set -euo pipefail

PORT="${PORT:-7788}"
ROOT="${ROOT:-$(mktemp -d -t paseo-vk-e2e-XXXXXX)}"
HOME_DIR="$ROOT/paseo-home"
PROJECT="$ROOT/project"

mkdir -p "$HOME_DIR" "$PROJECT"
git -C "$PROJECT" init -q
echo "# e2e project" > "$PROJECT/README.md"
cat > "$HOME_DIR/config.json" <<EOF
{
  "version": 1,
  "daemon": { "listen": "127.0.0.1:$PORT", "relay": { "enabled": false } }
}
EOF

PASEO_NODE_ENV=development npx -y @getpaseo/cli@0.12.0 daemon start --home "$HOME_DIR" >&2

echo "PASEO_E2E_DAEMON=127.0.0.1:$PORT"
echo "PASEO_E2E_CWD=$PROJECT"
echo "# stop with: npx -y @getpaseo/cli@0.12.0 daemon stop --home $HOME_DIR" >&2
