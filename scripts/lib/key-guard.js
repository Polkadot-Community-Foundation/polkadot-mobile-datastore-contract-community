// SPDX-License-Identifier: GPL-3.0-only

// Where each Cloud KMS deployer key may sign. A fork keeps its chain's genesis and chain id, so a signature
// made there is valid on the live chain: only *-rehearsal keys sign on forks, and they sign nowhere else.
//   *-rehearsal  forks only
//   *-devnet     live devnet Asset Hub only (eth chain id 420420417)
//   other        live Polkadot Asset Hub only (eth chain id 420420419)
const POLKADOT_ETH_CHAIN_ID = 420420419;
const DEVNET_ETH_CHAIN_ID = 420420417;

function keyClass(keyName) {
  if (keyName.endsWith("-rehearsal")) return "rehearsal";
  if (keyName.endsWith("-devnet")) return "devnet";
  return "production";
}

// Returns null when keyName may sign on this chain, otherwise the reason it may not.
function keyGuard(keyName, { chainId, fork }) {
  const kind = keyClass(keyName);
  const where = `${fork ? "a fork" : "the live chain"} with eth chain id ${chainId}`;
  if (kind === "rehearsal") return fork ? null : `${keyName} signs on forks only, not on ${where}`;
  if (fork) return `${keyName} never signs on a fork (${where}): its signatures would be valid on the live chain; use a *-rehearsal key`;
  if (kind === "devnet") return chainId === DEVNET_ETH_CHAIN_ID ? null : `${keyName} signs only on devnet (eth chain id ${DEVNET_ETH_CHAIN_ID}), not on ${where}`;
  return chainId === POLKADOT_ETH_CHAIN_ID ? null : `${keyName} signs only on Polkadot Asset Hub (eth chain id ${POLKADOT_ETH_CHAIN_ID}), not on ${where}`;
}

module.exports = { POLKADOT_ETH_CHAIN_ID, DEVNET_ETH_CHAIN_ID, keyClass, keyGuard };
