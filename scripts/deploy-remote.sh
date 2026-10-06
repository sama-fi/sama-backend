#!/usr/bin/env bash
# Runs on the VPS (piped over ssh by .semaphore/semaphore.yml). Pulls both repos,
# installs dependencies, restarts sama-backend, and waits for /api/health.
set -euo pipefail

SAMA_DIR="${SAMA_DIR:-$HOME/sama}"
BUN="${BUN:-/usr/local/bin/bun}"

# `bun install` can rewrite bun.lock on the server (newer bun, a workspace the committed lockfile did not list yet).
# That is never a deliberate edit, and a dirty lockfile makes the next `git pull --ff-only` refuse. Drop it first.
pull() {
  git checkout -- bun.lock 2>/dev/null || true
  git pull --ff-only
}

echo "==> sama-packages"
cd "$SAMA_DIR/sama-packages"
pull
"$BUN" install

echo "==> sama-backend"
cd "$SAMA_DIR/sama-backend"
pull
"$BUN" install

echo "==> restart sama-backend"
sudo systemctl restart sama-backend.service

echo "==> health"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3300/api/health; then
    echo
    echo "deploy ok: $(git -C "$SAMA_DIR/sama-backend" rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done

echo "health check failed; recent logs:" >&2
sudo journalctl -u sama-backend -n 40 --no-pager >&2
exit 1
