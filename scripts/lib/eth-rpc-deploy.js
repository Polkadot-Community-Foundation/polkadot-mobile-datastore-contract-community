// SPDX-License-Identifier: GPL-3.0-only

// Chain reads for scripts/deploy-eth-rpc.js that go through Substrate only. Once the transaction is sent the
// ETH-RPC is not needed again: it may be pruned (--eth-pruning N keeps N blocks of receipts), restarted or
// down, the Substrate node keeps the blocks.
const { Transaction } = require("ethers");
const { encodeAddress, keccakAsHex } = require("@polkadot/util-crypto");

// Operators fund the deployer by its Polkadot-prefix address, whatever prefix the chain registry reports.
const POLKADOT_SS58 = 0;

// Retryable (chain or ETH-RPC read failed) unless marked otherwise.
class FatalDeployError extends Error {}

function fallbackAccount(h160) {
  return `${h160.toLowerCase()}${"ee".repeat(12)}`;
}

function describeAccount(h160) {
  const accountId = fallbackAccount(h160);
  return { accountId, ss58: encodeAddress(accountId, POLKADOT_SS58) };
}

// Substrate System.Account of the key's fallback account, at blockHash or at the best block. ETH-RPC balances
// and nonces can lag behind a chopsticks fork, and the sum free + reserved is what a deploy spends.
async function nativeAccount(api, h160, blockHash) {
  const at = blockHash ? await api.at(blockHash) : api;
  const { nonce, data } = await at.query.system.account(fallbackAccount(h160));
  const free = data.free.toBigInt();
  const reserved = data.reserved.toBigInt();
  return { nonce: nonce.toNumber(), free, reserved, total: free + reserved };
}

async function codeHashAt(api, address) {
  const info = await api.query.revive.accountInfoOf(address);
  if (!info.isSome || !info.unwrap().accountType.isContract) return null;
  return info.unwrap().accountType.asContract.codeHash.toHex();
}

async function codeHashesAt(api, addresses) {
  const infos = await api.query.revive.accountInfoOf.multi(addresses);
  return infos.map((info) => (info.isSome && info.unwrap().accountType.isContract ? info.unwrap().accountType.asContract.codeHash.toHex() : null));
}

// First block in (lo, hi] whose nonce is above `nonce`, given nonceAt(lo) <= nonce < nonceAt(hi).
async function firstBlockAfterNonce(nonceAt, lo, hi, nonce) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await nonceAt(mid)) > nonce) hi = mid;
    else lo = mid + 1;
  }
  return hi;
}

// The Revive.eth_transact extrinsic in a block that carries sender's transaction with this nonce: the payload is
// the signed eth transaction, so the sender and nonce are recovered from it and its keccak is the eth hash.
function findEthTransact(extrinsics, sender, nonce) {
  for (const extrinsic of extrinsics) {
    const { method } = extrinsic;
    if (method.section !== "revive" || method.method !== "ethTransact") continue;
    const payload = method.args[0].toHex();
    let tx;
    try {
      tx = Transaction.from(payload);
    } catch {
      continue;
    }
    if (tx.from?.toLowerCase() !== sender.toLowerCase() || tx.nonce !== nonce) continue;
    return { transactionHash: keccakAsHex(payload), extrinsicHash: extrinsic.hash.toHex() };
  }
  return null;
}

// Retries fn on a read error: a load-balanced RPC may not serve a block its sibling already announced.
async function retryRead(what, fn, { tries = 10, delayMs = 2000 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof FatalDeployError) throw error;
      last = error;
      if (i < tries) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${what}: ${last?.message || last}`);
}

module.exports = {
  POLKADOT_SS58,
  FatalDeployError,
  fallbackAccount,
  describeAccount,
  nativeAccount,
  codeHashAt,
  codeHashesAt,
  firstBlockAfterNonce,
  findEthTransact,
  retryRead,
};
