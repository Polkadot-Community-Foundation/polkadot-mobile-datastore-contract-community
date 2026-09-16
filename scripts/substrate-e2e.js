// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// End-to-end check of the path the mobile client uses: an sr25519 substrate account calls the
// contract through `Revive.call`, not through eth-rpc. Runs against a LOCAL dev chain only
// (anvil-polkadot exposes eth-rpc on :8545 and substrate RPC on :9944).
//
//   npx hardhat run scripts/substrate-e2e.js --network localNode
//
// It funds a fresh sr25519 account from the eth dev account by dispatching
// `Balances.transfer_keep_alive` through the runtime-pallets precompile address, which only
// works on dev chains where the eth dev account is endowed.
const { ethers } = require("hardhat");
const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { cryptoWaitReady, mnemonicGenerate } = require("@polkadot/util-crypto");
const { u8aToHex } = require("@polkadot/util");

const SUBSTRATE_WS_URL = process.env.LOCAL_SUBSTRATE_WS_URL || "ws://127.0.0.1:9944";

function expectedH160(accountId) {
  return ethers.getAddress(ethers.dataSlice(ethers.keccak256(accountId), 12));
}

function signAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (!status.isInBlock && !status.isFinalized) return;
      if (dispatchError) {
        const error = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        reject(new Error(error ? `${error.section}.${error.name}` : dispatchError.toString()));
        return;
      }
      resolve(events);
    }).catch(reject);
  });
}

function feeFrom(events) {
  const paid = events.find(({ event }) => event.section === "transactionPayment" && event.method === "TransactionFeePaid");
  return paid ? paid.event.data.actualFee.toBigInt() : null;
}

async function balances(api, address) {
  const { data } = await api.query.system.account(address);
  return { free: data.free.toBigInt(), reserved: data.reserved.toBigInt() };
}

async function dryRunCall(api, origin, dest, data) {
  const result = await api.call.reviveApi.call(origin, dest, 0, null, null, data);
  const json = result.toJSON();
  const deposit = result.storageDeposit.isCharge
    ? result.storageDeposit.asCharge.toBigInt()
    : -result.storageDeposit.asRefund.toBigInt();
  return { result, json, deposit, weightRequired: result.weightRequired };
}

async function main() {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(SUBSTRATE_WS_URL), noInitWarn: true });
  const [ethDev] = await ethers.getSigners();

  const store = await ethers.deployContract("AccountDataStore");
  await store.waitForDeployment();
  const code = await ethers.provider.getCode(store.target);
  console.log(`contract ${store.target} (${code.startsWith("0x50564d00") ? "PolkaVM" : "EVM"})`);

  const keyring = new Keyring({ type: "sr25519" });
  const user = keyring.addFromUri(mnemonicGenerate());
  const accountId = u8aToHex(user.publicKey);
  const h160 = expectedH160(accountId);
  const runtimeH160 = (await api.call.reviveApi.address(user.address)).toString();
  console.log(`sr25519 ${user.address}`);
  console.log(`keccak256(accountId)[12..] = ${h160}, ReviveApi.address = ${ethers.getAddress(runtimeH160)}`);

  const funding = api.tx.balances.transferKeepAlive(user.address, 10n ** 14n);
  const runtimePallets = (await api.call.reviveApi.runtimePalletsAddress()).toString();
  await (await ethDev.sendTransaction({ to: runtimePallets, data: funding.method.toHex() })).wait();
  console.log(`funded: ${JSON.stringify(await balances(api, user.address), (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  const installation = ethers.hexlify(ethers.randomBytes(60));
  const callData = store.interface.encodeFunctionData("registerCoinageInstallation", [installation]);

  const unmappedDryRun = await dryRunCall(api, user.address, store.target, callData);
  console.log(`dry-run before map_account: ${JSON.stringify(unmappedDryRun.json.result)}`);

  let unmappedCallOutcome;
  try {
    const events = await signAndWait(
      api,
      api.tx.revive.call(store.target, 0, unmappedDryRun.weightRequired, unmappedDryRun.deposit > 0n ? unmappedDryRun.deposit : 0n, callData),
      user,
    );
    unmappedCallOutcome = `succeeded, fee=${feeFrom(events)}`;
  } catch (error) {
    unmappedCallOutcome = `failed: ${error.message}`;
  }
  console.log(`Revive.call before map_account: ${unmappedCallOutcome}`);
  console.log(`  stored under h160 after unmapped call: ${(await store.getCoinageInstallations(h160)).length}`);

  const beforeMap = await balances(api, user.address);
  const mapEvents = await signAndWait(api, api.tx.revive.mapAccount(), user);
  const afterMap = await balances(api, user.address);
  console.log(`map_account: fee=${feeFrom(mapEvents)} reserved/held delta=${afterMap.reserved - beforeMap.reserved} free delta=${afterMap.free - beforeMap.free}`);
  console.log(`  OriginalAccount(${h160}) = ${(await api.query.revive.originalAccount(h160)).toString()}`);

  const secondInstallation = ethers.hexlify(ethers.randomBytes(60));
  const secondCallData = store.interface.encodeFunctionData("registerCoinageInstallation", [secondInstallation]);
  const dryRun = await dryRunCall(api, user.address, store.target, secondCallData);
  console.log(`dry-run after map_account: weightRequired=${JSON.stringify(dryRun.json.weightRequired)} storageDeposit=${dryRun.deposit} gasConsumed=${JSON.stringify(dryRun.json.gasConsumed ?? null)}`);

  const beforeCall = await balances(api, user.address);
  const callEvents = await signAndWait(api, api.tx.revive.call(store.target, 0, dryRun.weightRequired, dryRun.deposit, secondCallData), user);
  const afterCall = await balances(api, user.address);
  console.log(`Revive.call: fee=${feeFrom(callEvents)} free delta=${afterCall.free - beforeCall.free} reserved delta=${afterCall.reserved - beforeCall.reserved}`);

  const repeatDryRun = await dryRunCall(api, user.address, store.target, secondCallData);
  const repeatEvents = await signAndWait(api, api.tx.revive.call(store.target, 0, repeatDryRun.weightRequired, 0, secondCallData), user);
  console.log(`idempotent re-register: storageDeposit=${repeatDryRun.deposit} fee=${feeFrom(repeatEvents)} weightRequired=${JSON.stringify(repeatDryRun.json.weightRequired)}`);

  const stored = await store.getCoinageInstallations(h160);
  console.log(`getCoinageInstallations(${h160}) -> ${stored.length} entries, contains second blob: ${stored.includes(secondInstallation)}`);

  await api.disconnect();
}

// The open WebSocket and hardhat's provider keep the event loop alive after main() finishes.
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
