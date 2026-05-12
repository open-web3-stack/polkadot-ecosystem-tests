#!/usr/bin/env bash
#
# Spin up the CI Subway setup locally inside a tmux session, then run a
# selected test suite against it.
#
# This mirrors the chain/port mapping and lifecycle in `.github/workflows/ci.yml`:
# start one Subway per chain in the chosen network, wait for `/health` on each
# port, export the matching `<CHAIN>_ENDPOINT=ws://localhost:<port>` env var,
# then invoke `yarn test:<network> ...`. On exit (incl. Ctrl-C), all Subway
# processes are killed and `/tmp/subway-*.log` is preserved for inspection.
#
# Usage:
#   ./scripts/run-ci-locally.sh polkadot [vitest args...]
#   ./scripts/run-ci-locally.sh kusama [vitest args...]
#
# The tmux session has two panes: top runs Subway processes and tails the
# logs; bottom runs the test command. The session is created in the background
# so the script does not nest inside an existing tmux session; attach with
# `tmux a -t <session>` (the script prints the name on exit).

set -euo pipefail

NETWORK="${1:-}"
if [[ -z "$NETWORK" ]]; then
  echo "Usage: $0 <polkadot|kusama> [vitest args...]" >&2
  exit 1
fi
shift

# Chain/port/env-var triples per network, hardcoded to mirror the matrix in
# .github/workflows/ci.yml. Kept literal here (rather than parsed from the
# YAML) for two reasons: (1) no YAML parser dependency for a local script,
# (2) drift between this script and the CI workflow is rare and obvious in
# review when both change. If a chain is added to CI, mirror it here.
case "$NETWORK" in
  polkadot)
    CHAIN_SPECS=(
      "polkadot:9000:POLKADOT_ENDPOINT"
      "assetHubPolkadot:9001:ASSETHUBPOLKADOT_ENDPOINT"
      "bridgeHubPolkadot:9002:BRIDGEHUBPOLKADOT_ENDPOINT"
      "collectivesPolkadot:9003:COLLECTIVESPOLKADOT_ENDPOINT"
      "coretimePolkadot:9004:CORETIMEPOLKADOT_ENDPOINT"
      "peoplePolkadot:9005:PEOPLEPOLKADOT_ENDPOINT"
      "acala:9006:ACALA_ENDPOINT"
      "hydration:9007:HYDRATION_ENDPOINT"
      "bifrostPolkadot:9008:BIFROSTPOLKADOT_ENDPOINT"
    )
    ;;
  kusama)
    CHAIN_SPECS=(
      "kusama:9010:KUSAMA_ENDPOINT"
      "assetHubKusama:9011:ASSETHUBKUSAMA_ENDPOINT"
      "bridgeHubKusama:9012:BRIDGEHUBKUSAMA_ENDPOINT"
      "coretimeKusama:9013:CORETIMEKUSAMA_ENDPOINT"
      "peopleKusama:9014:PEOPLEKUSAMA_ENDPOINT"
      "encointerKusama:9015:ENCOINTERKUSAMA_ENDPOINT"
      "karura:9016:KARURA_ENDPOINT"
      "bifrostKusama:9017:BIFROSTKUSAMA_ENDPOINT"
    )
    ;;
  *)
    echo "Unknown network: $NETWORK (expected polkadot or kusama)" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TEMPLATE=".github/subway-template.yml"
ENDPOINTS_JSON="packages/networks/src/pet-chain-endpoints.json"
KNOWN_GOOD_ENV="KNOWN_GOOD_BLOCK_NUMBERS_$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]').env"

for tool in jq tmux subway curl; do
  if ! command -v "$tool" &> /dev/null; then
    echo "Error: required tool not found in PATH: $tool" >&2
    exit 1
  fi
done

for f in "$TEMPLATE" "$ENDPOINTS_JSON" "$KNOWN_GOOD_ENV"; do
  if [[ ! -f "$f" ]]; then
    echo "Error: required file missing: $f" >&2
    exit 1
  fi
done

# PID suffixed with $$ so multiple instances of this script (e.g. one for
# polkadot, one for kusama) coexist without stomping each other's PIDFILE
# or tmux session. The pidfile is the only persistent record of children
# we spawn; cleanup reads it on EXIT to make sure Subways die with us
# even if the test command panics.
SESSION="pet-local-${NETWORK}-$$"
PIDFILE="/tmp/run-ci-locally-${SESSION}.pids"
ENVFILE="/tmp/run-ci-locally-${SESSION}.env"
: > "$PIDFILE"
: > "$ENVFILE"

cleanup() {
  if [[ -f "$PIDFILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < "$PIDFILE"
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

# Seed the per-run env file with KNOWN_GOOD block numbers for the chosen
# network. The test pane sources this file via `set -a` to export every
# variable in one shot; ENDPOINT vars are appended per-chain below.
cat "$KNOWN_GOOD_ENV" > "$ENVFILE"

echo "Starting Subway instances for $NETWORK..."
for spec in "${CHAIN_SPECS[@]}"; do
  IFS=':' read -r CHAIN PORT ENDPOINT_VAR <<< "$spec"
  ENDPOINTS=$(jq -c ".$CHAIN" "$ENDPOINTS_JSON")
  if [[ "$ENDPOINTS" == "null" || -z "$ENDPOINTS" ]]; then
    echo "Error: no endpoints for $CHAIN in $ENDPOINTS_JSON" >&2
    exit 1
  fi
  CONFIG="/tmp/subway-${PORT}.yml"
  LOG="/tmp/subway-${PORT}.log"
  sed -e "s/{{PORT}}/$PORT/g" -e "s|{{ENDPOINTS}}|$ENDPOINTS|g" "$TEMPLATE" > "$CONFIG"
  subway --config "$CONFIG" > "$LOG" 2>&1 &
  echo "$!" >> "$PIDFILE"
  echo "${ENDPOINT_VAR}=ws://localhost:${PORT}" >> "$ENVFILE"
  echo "  $CHAIN -> port $PORT (pid $!)"
done

echo "Waiting for /health on each Subway..."
for spec in "${CHAIN_SPECS[@]}"; do
  IFS=':' read -r CHAIN PORT _ <<< "$spec"
  elapsed=0
  # `(( elapsed++ ))` returns exit status 1 when the pre-increment value is
  # 0, which trips `set -e`. Same trap on `(( elapsed < 60 ))` once elapsed
  # falsifies. Trailing `|| true` keeps the loop's exit status 0 either way.
  while [[ $elapsed -lt 60 ]]; do
    if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
      echo "  $CHAIN ($PORT) ready"
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if [[ $elapsed -ge 60 ]]; then
    echo "  timeout waiting for $CHAIN ($PORT)" >&2
    tail -20 "/tmp/subway-${PORT}.log" >&2 || true
    exit 1
  fi
done

# `set -a` makes every variable assignment thereafter automatically exported
# so the env file's KEY=VALUE lines become exported env vars; `set +a` then
# restores normal scoping for the test command itself. `${VITEST_ARGS[*]@Q}`
# (bash >=4.4) re-quotes each element so spaces/quotes in vitest args
# survive being embedded inside the outer double-quoted string.
VITEST_ARGS=("$@")
TEST_CMD="set -a; . '$ENVFILE'; set +a; yarn test:$NETWORK --pool=forks --maxWorkers=8 ${VITEST_ARGS[*]@Q}; echo; echo 'test command exited; press any key to close window'; read -n 1"
LOG_CMD="tail -F /tmp/subway-*.log"

# Two-pane layout: left pane follows Subway logs across all instances;
# right pane runs the test command. Created detached (`-d`) and then
# auto-attached after a brief settle, so the operator sees output without
# having to type anything.
tmux new-session -d -s "$SESSION" -x 220 -y 60 "bash -lc \"$LOG_CMD\""
tmux split-window -h -t "$SESSION" "bash -lc \"$TEST_CMD\""
tmux select-pane -t "$SESSION":0.1

echo
echo "tmux session: $SESSION"
echo "attaching in 3 seconds (detach with Ctrl-b d to leave it running)..."
sleep 3

if [[ -n "${TMUX:-}" ]]; then
  tmux switch-client -t "$SESSION"
else
  tmux attach-session -t "$SESSION"
fi

while true; do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "tmux session closed; exiting."
    break
  fi
  sleep 5
done
