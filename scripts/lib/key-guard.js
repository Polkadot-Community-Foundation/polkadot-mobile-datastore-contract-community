// SPDX-License-Identifier: GPL-3.0-only

// Where each Cloud KMS deployer key may sign. A fork keeps its chain's genesis and chain id, so a signature
// made there is valid on the live chain: the production key never signs on a fork.
//   contract-deployer  live Polkadot Asset Hub only (eth chain id 420420419), DEPLOY_MODE=live
//   *-devnet           devnet Asset Hub (eth chain id 420420417), live or a local fork of it, DEPLOY_MODE=devnet|fork
//   any other name     refused
const POLKADOT_ETH_CHAIN_ID = 420420419;
const DEVNET_ETH_CHAIN_ID = 420420417;
const PRODUCTION_KEY = "contract-deployer";

function keyClass(keyName) {
  if (keyName === PRODUCTION_KEY) return "production";
  if (keyName.endsWith("-devnet")) return "devnet";
  return "unknown";
}

// Returns null when keyName may sign in this DEPLOY_MODE, otherwise the reason it may not.
function keyModeGuard(keyName, mode) {
  switch (keyClass(keyName)) {
    case "production":
      return mode === "live" ? null : `${keyName} signs in DEPLOY_MODE=live only, not ${mode}`;
    case "devnet":
      return mode === "devnet" || mode === "fork" ? null : `${keyName} signs in DEPLOY_MODE=devnet (or a fork of devnet), not ${mode}`;
    default:
      return `${keyName} is not a deployer key: expected ${PRODUCTION_KEY} or a *-devnet key`;
  }
}

// Returns null when keyName may sign on this chain, otherwise the reason it may not.
function keyGuard(keyName, { chainId, fork }) {
  const where = `${fork ? "a fork" : "the live chain"} with eth chain id ${chainId}`;
  switch (keyClass(keyName)) {
    case "production":
      if (fork) return `${keyName} never signs on a fork (${where}): its signatures would be valid on the live chain`;
      return chainId === POLKADOT_ETH_CHAIN_ID ? null : `${keyName} signs only on Polkadot Asset Hub (eth chain id ${POLKADOT_ETH_CHAIN_ID}), not on ${where}`;
    case "devnet":
      return chainId === DEVNET_ETH_CHAIN_ID ? null : `${keyName} signs only on devnet (eth chain id ${DEVNET_ETH_CHAIN_ID}), not on ${where}`;
    default:
      return `${keyName} is not a deployer key: expected ${PRODUCTION_KEY} or a *-devnet key`;
  }
}

module.exports = { POLKADOT_ETH_CHAIN_ID, DEVNET_ETH_CHAIN_ID, PRODUCTION_KEY, keyClass, keyModeGuard, keyGuard };
