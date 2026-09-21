#!/usr/bin/env bash
# Local rehearsal of the ETH-RPC deploy on a chopsticks fork of live Asset Hub (Polkadot by default, devnet with
# FORK_NETWORK=devnet): fork + eth-rpc container, fund the key, stand in for the DotNS factory at nonce 0,
# check the nonce-0 rule (a fresh key is refused on a fork of production, logged on a fork of devnet),
# dry-run, deploy, verify. Nothing leaves the fork. Not run in CI.
#
#   npm run build:pvm && npm run rehearse:fork
#   FORK_NETWORK=devnet npm run rehearse:fork
#
# Env:
#   FORK_NETWORK      production (default) | devnet: which live chain to fork
#   DEPLOY_SIGNER     keystore (default; a throwaway key is created when ETH_KEYSTORE is unset) | gcp
#                     (the *-devnet key, FORK_NETWORK=devnet only: the production key never signs on a fork)
#   WORK_DIR          fork config, logs, throwaway keys and the deployment record (default: a new temp dir)
#   FORK_PORT         chopsticks port (default 8120)
#   ETH_RPC_PORT      eth-rpc port (default 8157)
#   ETH_RPC_IMAGE     eth-rpc container image
#   ETH_RPC_CONTAINER container name (default datastore-pipeline-ethrpc)
#   FORK_ENDPOINTS    comma-separated live Asset Hub endpoints (default: FORK_NETWORK's)
#   FORK_BLOCK        block to fork at (default: latest)
#   FUND              planck set as the key's free balance (default 10 DOT / 10 PAS)
#   CHOPSTICKS_VERSION  default 1.5.1
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FORK_NETWORK=${FORK_NETWORK:-production}
case "$FORK_NETWORK" in
  production) default_endpoints=wss://polkadot-asset-hub-rpc.polkadot.io,wss://asset-hub-polkadot-rpc.n.dwellir.com ;;
  devnet) default_endpoints=wss://asset-hub-paseo-rpc.n.dwellir.com,wss://asset-hub-paseo.dotters.network ;;
  *) echo "REFUSED: FORK_NETWORK must be production or devnet, got '$FORK_NETWORK'" >&2; exit 1 ;;
esac
FORK_PORT=${FORK_PORT:-8120}
ETH_RPC_PORT=${ETH_RPC_PORT:-8157}
ETH_RPC_IMAGE=${ETH_RPC_IMAGE:-docker.io/parity/eth-rpc:v1.24.2@sha256:74ebf6671d93e6ab759de4f84454b4d00be011530845b8edaaa83dbfc64c40c9}
ETH_RPC_CONTAINER=${ETH_RPC_CONTAINER:-datastore-pipeline-ethrpc}
FORK_ENDPOINTS=${FORK_ENDPOINTS:-$default_endpoints}
FUND=${FUND:-100000000000}
CHOPSTICKS_VERSION=${CHOPSTICKS_VERSION:-1.5.1}
WORK_DIR=${WORK_DIR:-$(mktemp -d)}
export DEPLOY_SIGNER=${DEPLOY_SIGNER:-keystore}
export NETWORK=$FORK_NETWORK DEPLOY_MODE=fork
export SUBSTRATE_WS_URL=ws://127.0.0.1:$FORK_PORT ETH_RPC_URL=http://127.0.0.1:$ETH_RPC_PORT
SUBSTRATE_HTTP=http://127.0.0.1:$FORK_PORT
RECORD=$ROOT/deployments/$NETWORK.json
PASSWORD_FILE=$WORK_DIR/keys/password
# Init code of a contract returning one zero byte: stands in for the DotNS factory at nonce 0.
NONCE0_STANDIN=0x600180600a3d393df300

mkdir -p "$WORK_DIR/keys"
[ -f "$PASSWORD_FILE" ] || printf rehearsal >"$PASSWORD_FILE"
[ -e "$RECORD" ] && { echo "REFUSED: $RECORD exists; move it out first" >&2; exit 1; }
# The stand-in below signs before scripts/deploy-eth-rpc.js runs its key guard: check the key here too.
if [ "$DEPLOY_SIGNER" = gcp ] && { [ "$FORK_NETWORK" != devnet ] || [[ "${GCP_KEY_NAME:-}" != *-devnet ]]; }; then
  echo "REFUSED: a KMS key signs on a fork only when it is a *-devnet key on FORK_NETWORK=devnet, got '${GCP_KEY_NAME:-}' on $FORK_NETWORK" >&2
  exit 1
fi

FORK_PID=
cleanup() {
  [ -n "$FORK_PID" ] && kill -- -"$FORK_PID" 2>/dev/null || true
  docker rm -f "$ETH_RPC_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# chopsticks serves HTTP and WebSocket on the same port.
rpc() {
  curl -fsS -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1"
}

wait_for() {
  for _ in $(seq 1 "$3"); do
    rpc "$1" "$2" '[]' >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$1 did not answer $2" >&2
  return 1
}

# Keystore of a fresh throwaway key; prints its path.
new_keystore() {
  local dir=$WORK_DIR/keys/$1
  mkdir -p "$dir"
  cast wallet new "$dir" --unsafe-password "$(cat "$PASSWORD_FILE")" >/dev/null
  find "$dir" -type f | head -n1
}

account_of() {
  echo "0x$(echo "${1#0x}" | tr 'A-F' 'a-f')$(printf 'ee%.0s' {1..12})"
}

fund() {
  rpc "$SUBSTRATE_HTTP" dev_setStorage \
    "[{\"System\":{\"Account\":[[[\"$(account_of "$1")\"],{\"providers\":1,\"data\":{\"free\":\"$FUND\"}}]]}}]" >/dev/null
}

# From Substrate: ETH-RPC nonces can lag behind the fork.
nonce_of() {
  rpc "$SUBSTRATE_HTTP" system_accountNextIndex "[\"$(account_of "$1")\"]" | jq -r .result
}

echo "== fork of $FORK_NETWORK: chopsticks $CHOPSTICKS_VERSION on :$FORK_PORT, work dir $WORK_DIR"
{
  echo "endpoint:"
  IFS=, read -ra endpoints <<<"$FORK_ENDPOINTS"
  for endpoint in "${endpoints[@]}"; do echo "  - $endpoint"; done
  echo "port: $FORK_PORT"
  echo "build-block-mode: Instant"
  echo "mock-signature-host: true"
  if [ -n "${FORK_BLOCK:-}" ]; then echo "block: $FORK_BLOCK"; fi
} >"$WORK_DIR/chopsticks.yml"
setsid npx --yes "@acala-network/chopsticks@$CHOPSTICKS_VERSION" -c "$WORK_DIR/chopsticks.yml" >"$WORK_DIR/chopsticks.log" 2>&1 &
FORK_PID=$!
wait_for "$SUBSTRATE_HTTP" system_chain 180

echo "== eth-rpc: $ETH_RPC_IMAGE on :$ETH_RPC_PORT"
docker rm -f "$ETH_RPC_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$ETH_RPC_CONTAINER" --network host "$ETH_RPC_IMAGE" \
  --node-rpc-url "$SUBSTRATE_WS_URL" --rpc-port "$ETH_RPC_PORT" --eth-pruning 1 >/dev/null
wait_for "$ETH_RPC_URL" eth_chainId 120

signer_args=()
if [ "$DEPLOY_SIGNER" = gcp ]; then
  signer_args=(--gcp)
elif [ -z "${ETH_KEYSTORE:-}" ] && [ -z "${ETH_KEYSTORE_ACCOUNT:-}" ]; then
  ETH_KEYSTORE=$(new_keystore deployer)
  export ETH_KEYSTORE ETH_PASSWORD=$PASSWORD_FILE
fi
SENDER=$(cast wallet address "${signer_args[@]}")
echo "== deployer $SENDER, funding $FUND planck"
fund "$SENDER"

if [ "$(nonce_of "$SENDER")" = 0 ]; then
  echo "== nonce 0: stand-in for the DotNS factory"
  cast send --rpc-url "$ETH_RPC_URL" --json "${signer_args[@]}" --create "$NONCE0_STANDIN" | jq -c '{contractAddress, status, gasUsed}'
fi

fresh_keystore=$(new_keystore fresh)
fresh=$(ETH_KEYSTORE=$fresh_keystore ETH_PASSWORD=$PASSWORD_FILE cast wallet address)
fund "$fresh"
if [ "$FORK_NETWORK" = production ]; then
  echo "== negative: a fresh key at nonce 0 is refused on a fork of production"
  if ETH_KEYSTORE=$fresh_keystore ETH_PASSWORD=$PASSWORD_FILE DEPLOY_SIGNER=keystore \
    node "$ROOT/scripts/deploy-eth-rpc.js" >"$WORK_DIR/negative.log" 2>&1; then
    echo "FAIL: the fresh key $fresh deployed" >&2
    exit 1
  fi
  grep -q 'REFUSED: create1' "$WORK_DIR/negative.log" || { cat "$WORK_DIR/negative.log" >&2; exit 1; }
  grep REFUSED "$WORK_DIR/negative.log"
else
  echo "== nonce rule: a fresh key at nonce 0 passes preflight on a fork of $FORK_NETWORK (dry run)"
  ETH_KEYSTORE=$fresh_keystore ETH_PASSWORD=$PASSWORD_FILE DEPLOY_SIGNER=keystore DRY_RUN=1 \
    node "$ROOT/scripts/deploy-eth-rpc.js" >"$WORK_DIR/nonce-rule.log" 2>&1 || { cat "$WORK_DIR/nonce-rule.log" >&2; exit 1; }
  grep -q 'nonce 0 free' "$WORK_DIR/nonce-rule.log" || { cat "$WORK_DIR/nonce-rule.log" >&2; exit 1; }
  grep 'nonce 0 free' "$WORK_DIR/nonce-rule.log"
fi
[ "$(nonce_of "$fresh")" = 0 ] || { echo "FAIL: the fresh key's nonce moved" >&2; exit 1; }

echo "== dry run"
DRY_RUN=1 node "$ROOT/scripts/deploy-eth-rpc.js"

echo "== deploy"
DRY_RUN=0 node "$ROOT/scripts/deploy-eth-rpc.js"

echo "== verify"
node "$ROOT/scripts/verify-deployment.js"

mv "$RECORD" "$WORK_DIR/deployment-fork.json"
echo "== record moved to $WORK_DIR/deployment-fork.json"
