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
  while (( elapsed < 60 )); do
    if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
      echo "  $CHAIN ($PORT) ready"
      break
    fi
    sleep 1
    (( elapsed++ ))
  done
  if (( elapsed >= 60 )); then
    echo "  timeout waiting for $CHAIN ($PORT)" >&2
    tail -20 "/tmp/subway-${PORT}.log" >&2 || true
    exit 1
  fi
done

VITEST_ARGS=("$@")
TEST_CMD="set -a; . '$ENVFILE'; set +a; yarn test:$NETWORK ${VITEST_ARGS[*]@Q}; echo; echo 'test command exited; press any key to close window'; read -n 1"
LOG_CMD="tail -F /tmp/subway-*.log"

tmux new-session -d -s "$SESSION" -x 220 -y 60 "bash -lc \"$LOG_CMD\""
tmux split-window -v -t "$SESSION" "bash -lc \"$TEST_CMD\""
tmux select-pane -t "$SESSION":0.1

echo
echo "tmux session: $SESSION"
echo "attach with:  tmux a -t $SESSION"
echo
echo "leave running; cleanup happens when you Ctrl-C this script."
echo

while true; do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "tmux session closed; exiting."
    break
  fi
  sleep 5
done
