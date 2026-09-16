// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Measures deploy and registration storage deposits and weights on a LOCAL revive node.
// Use a fresh node: the deploy deposit includes the code upload only if that code is not on chain yet.
//
//   npx hardhat run scripts/measure-deposits.js --network localNode      # PolkaVM
//   npx hardhat run scripts/measure-deposits.js --network localNodeEvm   # EVM
//
// Env: CONTRACTS (comma list, default AccountDataStore), REGISTRATIONS (default 10),
//      BLOB_LENGTH (default 60), LOCAL_SUBSTRATE_WS_URL (default ws://127.0.0.1:9944).
const { ethers, network, artifacts } = require("hardhat");
const { ApiPromise, WsProvider } = require("@polkadot/api");

const SUBSTRATE_WS_URL = process.env.LOCAL_SUBSTRATE_WS_URL || "ws://127.0.0.1:9944";
const CONTRACTS = (process.env.CONTRACTS || "AccountDataStore").split(",");
const REGISTRATIONS = Number(process.env.REGISTRATIONS || "10");
const BLOB_LENGTH = Number(process.env.BLOB_LENGTH || "60");
const REPORTED = new Set([1, 2, 5, REGISTRATIONS]);

function depositOf(result) {
  return result.storageDeposit.isCharge ? result.storageDeposit.asCharge.toBigInt() : -result.storageDeposit.asRefund.toBigInt();
}

function weightOf(result) {
  return `${result.weightRequired.refTime.toBigInt()}/${result.weightRequired.proofSize.toBigInt()}`;
}

async function dryRunCall(api, origin, contract, data) {
  const result = await api.call.reviveApi.call(origin, contract, 0, null, null, data);
  if (result.result.isErr || result.result.asOk.flags.toU8a().some((byte) => byte !== 0)) {
    throw new Error(`dry-run call failed: ${JSON.stringify(result.result.toHuman())}`);
  }
  return result;
}

async function measure(api, signer, origin, name) {
  const { bytecode } = await artifacts.readArtifact(name);
  const deployDryRun = await api.call.reviveApi.instantiate(origin, 0, null, null, { Upload: bytecode }, "0x", null);
  if (deployDryRun.result.isErr) throw new Error(`${name}: instantiate dry-run failed`);
  const deployTx = api.tx.revive.instantiateWithCode(0, deployDryRun.weightRequired, depositOf(deployDryRun), bytecode, "0x", null);
  const deployFee = (await deployTx.paymentInfo(origin)).partialFee.toBigInt();
  console.log(`${name} [${network.name}] code=${(bytecode.length - 2) / 2}B deployDeposit=${depositOf(deployDryRun)} deployFee=${deployFee} deployWeight=${weightOf(deployDryRun)}`);

  const store = await ethers.deployContract(name, signer);
  await store.waitForDeployment();
  const contract = await store.getAddress();

  const blobs = [];
  for (let n = 1; n <= REGISTRATIONS; n++) {
    const blob = ethers.hexlify(ethers.randomBytes(BLOB_LENGTH));
    const data = store.interface.encodeFunctionData("registerCoinageInstallation", [blob]);
    const dryRun = await dryRunCall(api, origin, contract, data);
    if (REPORTED.has(n)) {
      console.log(`  register #${n}: deposit=${depositOf(dryRun)} weight(refTime/proof)=${weightOf(dryRun)}`);
    }
    await (await store.registerCoinageInstallation(blob)).wait();
    blobs.push(blob);
  }

  for (const [label, blob] of [["first", blobs[0]], ["last", blobs[blobs.length - 1]]]) {
    const data = store.interface.encodeFunctionData("registerCoinageInstallation", [blob]);
    const dryRun = await dryRunCall(api, origin, contract, data);
    console.log(`  no-op re-register of ${label} entry (list of ${blobs.length}): deposit=${depositOf(dryRun)} weight=${weightOf(dryRun)}`);
  }

  const stored = await store.getCoinageInstallations(signer.address);
  const intact = stored.length === blobs.length && stored.every((blob, i) => blob === blobs[i]);
  console.log(`  getCoinageInstallations -> ${stored.length} entries, matches registration order: ${intact}`);
}

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(SUBSTRATE_WS_URL), noInitWarn: true });
  const [signer] = await ethers.getSigners();
  const origin = (await api.call.reviveApi.accountId(signer.address)).toString();
  for (const name of CONTRACTS) {
    await measure(api, signer, origin, name);
  }
  await api.disconnect();
}

// The open WebSocket and hardhat's provider keep the event loop alive after main() finishes.
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
