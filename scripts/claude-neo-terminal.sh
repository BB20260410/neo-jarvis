#!/usr/bin/env bash
set -euo pipefail

ROOT="~/Desktop/Neo 贾维斯"
PROMPT_FILE="$ROOT/docs/prompts/claude-terminal-neo-48.md"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

has_arg() {
  local name="$1"
  shift
  for arg in "$@"; do
    if [[ "$arg" == "$name" || "$arg" == "$name="* ]]; then
      return 0
    fi
  done
  return 1
}

cd "$ROOT"

top_level="$(git rev-parse --show-toplevel)"
if [[ "$top_level" != "$ROOT" ]]; then
  echo "Unexpected repo root: $top_level" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Missing prompt file: $PROMPT_FILE" >&2
  exit 1
fi

args=()

if ! has_arg "--model" "$@" && ! has_arg "-m" "$@"; then
  args+=(--model claude-opus-4-8)
fi

if ! has_arg "--effort" "$@"; then
  args+=(--effort xhigh)
fi

if ! has_arg "--append-system-prompt" "$@" && ! has_arg "--system-prompt" "$@"; then
  args+=(--append-system-prompt "$(cat "$PROMPT_FILE")")
fi

exec "$CLAUDE_BIN" "${args[@]}" "$@"
