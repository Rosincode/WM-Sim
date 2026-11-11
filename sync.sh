#!/usr/bin/env bash
while true; do
  git add -A && git commit -qm "wip $(whoami)" 2>/dev/null
  git pull --rebase -q && git push -q || echo "⚠️ sync conflict — los handmatig op"
  sleep 45
done
