// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Shared Substrate-side deploy flow: `Revive.instantiate_with_code` signed by an sr25519 key.
// Used by scripts/deploy-substrate.js and scripts/deploy-alice.js.
const fs = require("fs");
const path = require("path");
const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { cryptoWaitReady, decodeAddress, keccakAsHex } = require("@polkadot/util-crypto");
const { u8aEq } = require("@polkadot/util");
const { JsonRpcProvider, Wallet } = require("ethers");

const ROOT = path.join(__dirname, "..", "..");

// genesisHash pins a preset to its chain, so a SUBSTRATE_WS_URL pointing elsewhere aborts before signing.
// ethChainId is what the chain's ETH-RPC reports; scripts/deploy-eth-rpc.js refuses any other.
const NETWORKS = {
  local: { wsUrl: "ws://127.0.0.1:9944", ethRpcUrl: "http://127.0.0.1:8545" },
  next: { wsUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io", pgasAssetId: "2000000000" },
  // PCF devnet: Paseo Asset Hub, para 1000.
  devnet: {
    wsUrl: "wss://asset-hub-paseo-rpc.n.dwellir.com",
    genesisHash: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
    ethChainId: 420420417,
    pgasAssetId: "2000000000",
  },
  // The devnet chain under a CI-only record name (deployments/pcf-devnet-ci.json): deploy.yml mode=devnet
  // proves the KMS path there without touching the devnet instance's record.
  "pcf-devnet-ci": {
    wsUrl: "wss://asset-hub-paseo-rpc.n.dwellir.com",
    ethRpcUrl: "https://eth-rpc-testnet.polkadot.io",
    genesisHash: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
    ethChainId: 420420417,
    pgasAssetId: "2000000000",
  },
  // PCF production: Polkadot Asset Hub, para 1000.
  production: {
    wsUrl: "wss://polkadot-asset-hub-rpc.polkadot.io",
    genesisHash: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
    ethChainId: 420420419,
    pgasAssetId: "49999999",
  },
};

const ARTIFACTS = {
  pvm: "artifacts-pvm/contracts/AccountDataStore.sol/AccountDataStore.json",
  evm: "artifacts/contracts/AccountDataStore.sol/AccountDataStore.json",
};

// Individuality runtimes add these extensions. Encoding them as None / false (a single 0x00 byte)
// is what a plain signed transaction sends. Chains without them ignore these definitions.
const INDIVIDUALITY_EXTENSIONS = {
  AsScarcity: { extrinsic: { asScarcity: "Option<u8>" }, payload: {} },
  AsPgas: { extrinsic: { asPgas: "Option<u8>" }, payload: {} },
  AsDotnsGateway: { extrinsic: { asDotnsGateway: "Option<u8>" }, payload: {} },
  RestrictOrigins: { extrinsic: { restrictOrigins: "bool" }, payload: {} },
  AuthorizeCall: { extrinsic: {}, payload: {} },
  UnitTransactionExtension: { extrinsic: {}, payload: {} },
  EthSetOrigin: { extrinsic: {}, payload: {} },
};

// anvil's well-known dev account #0 (from the public "test test ... junk" mnemonic). anvil-polkadot
// endows it but not //Alice, so local runs top Alice up from it.
const ANVIL_DEV_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // gitleaks:allow (public anvil dev key)
const LOCAL_TOP_UP = 10n ** 14n;

const FUNDS_ERRORS = new Set([
  "revive.StorageDepositNotEnoughFunds",
  "revive.TransferFailed",
  "Token.FundsUnavailable",
  "Token.BelowMinimum",
  "Token.NoFunds",
]);

class InsufficientBalanceError extends Error {}

function errorText(api, error) {
  if (error.isModule) {
    const { section, name } = api.registry.findMetaError(error.asModule);
    return `${section}.${name}`;
  }
  if (error.isToken) return `Token.${error.asToken.type}`;
  return error.toString();
}

function signAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError, txHash }) => {
      if (!status.isInBlock && !status.isFinalized) return;
      if (dispatchError) reject(new Error(errorText(api, dispatchError)));
      else resolve({ events, txHash, blockHash: status.isInBlock ? status.asInBlock : status.asFinalized });
    }).catch(reject);
  });
}

function withMargin(value, marginPercent) {
  return value + (value * marginPercent) / 100n;
}

function loadBytecode(kind) {
  const relative = ARTIFACTS[kind];
  if (!relative) throw new Error(`BYTECODE must be one of ${Object.keys(ARTIFACTS).join(", ")}, got ${kind}`);
  const artifactPath = path.join(ROOT, relative);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing ${relative}; run \`npm run ${kind === "pvm" ? "build:pvm" : "build"}\` first`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).bytecode;
}

async function readAccountState(api, deployer, pgasAssetId) {
  const { data } = await api.query.system.account(deployer.address);
  const existentialDeposit = api.consts.balances.existentialDeposit.toBigInt();
  const free = data.free.toBigInt();
  const state = {
    free,
    reserved: data.reserved.toBigInt(),
    nativeSpendable: free > existentialDeposit ? free - existentialDeposit : 0n,
    pgas: null,
    pgasSpendable: 0n,
  };
  if (api.query.assets) {
    const [account, asset] = await Promise.all([
      api.query.assets.account(pgasAssetId, deployer.address),
      api.query.assets.asset(pgasAssetId),
    ]);
    if (asset.isSome) {
      const balance = account.isSome ? account.unwrap().balance.toBigInt() : 0n;
      const minBalance = asset.unwrap().minBalance.toBigInt();
      state.pgas = balance;
      state.pgasSpendable = balance > minBalance ? balance - minBalance : 0n;
    }
  }
  return state;
}

// Fee and deposit are each paid in PGAS when enough PGAS is spendable, otherwise in native (1:1 raw units).
function canAfford({ nativeSpendable, pgasSpendable }, fee, deposit) {
  const total = fee + deposit;
  return (
    nativeSpendable >= total ||
    pgasSpendable >= total ||
    (pgasSpendable >= deposit && nativeSpendable >= fee) ||
    (pgasSpendable >= fee && nativeSpendable >= deposit)
  );
}

function describeBalances(state) {
  const pgas = state.pgas === null ? "n/a (no PGAS asset)" : state.pgas.toString();
  return `native free=${state.free} reserved=${state.reserved} spendable=${state.nativeSpendable}; PGAS=${pgas} spendable=${state.pgasSpendable}`;
}

async function topUpFromAnvilDevAccount(api, network, deployer) {
  const provider = new JsonRpcProvider(process.env.LOCAL_ETH_RPC_URL || network.ethRpcUrl);
  const funder = new Wallet(process.env.LOCAL_FUNDER_PRIVATE_KEY || ANVIL_DEV_PRIVATE_KEY, provider);
  const runtimePallets = (await api.call.reviveApi.runtimePalletsAddress()).toString();
  const transfer = api.tx.balances.transferKeepAlive(deployer.address, LOCAL_TOP_UP);
  const tx = await funder.sendTransaction({ to: runtimePallets, data: transfer.method.toHex() });
  await tx.wait();
  provider.destroy();
  console.log(`  topped up ${LOCAL_TOP_UP} from anvil dev account ${funder.address} (tx ${tx.hash})`);
}

function writeDeployment(networkName, record) {
  const dir = path.join(ROOT, "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${networkName}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return path.relative(ROOT, file);
}

// Metadata v16 lists extensions per extension version and polkadot.js signs with all of them, but a
// v4 signed transaction carries only version 0's. The Polkadot Hub fork keeps the individuality
// extensions in version 1 only, so signing with the merged list is undecodable there.
function useV4TransactionExtensions(api) {
  const { extrinsic } = api.runtimeMetadata.asLatest;
  const version0 = [...(extrinsic.transactionExtensionsByVersion?.entries() ?? [])].find(([version]) => version.toNumber() === 0);
  if (!version0) return;
  const names = extrinsic.transactionExtensions.map((extension) => extension.identifier.toString());
  api.registry.setSignedExtensions(version0[1].map((index) => names[index.toNumber()]), INDIVIDUALITY_EXTENSIONS);
}

async function deployAccountDataStore({ networkName, wsUrl, suri, bytecode, dryRun, marginPercent, pgasAssetId }) {
  const network = NETWORKS[networkName] || {};
  const endpoint = wsUrl || network.wsUrl;
  pgasAssetId = pgasAssetId || network.pgasAssetId || "2000000000";
  if (!endpoint) throw new Error(`Unknown network ${networkName}; use one of ${Object.keys(NETWORKS).join(", ")} or set SUBSTRATE_WS_URL`);

  await cryptoWaitReady();
  const code = loadBytecode(bytecode);
  const api = await ApiPromise.create({
    provider: new WsProvider(endpoint),
    signedExtensions: INDIVIDUALITY_EXTENSIONS,
    noInitWarn: true,
  });
  useV4TransactionExtensions(api);

  try {
    if (network.genesisHash && api.genesisHash.toHex() !== network.genesisHash) {
      throw new Error(`${endpoint} is not ${networkName}: genesis ${api.genesisHash.toHex()}, expected ${network.genesisHash}`);
    }
    const chain = (await api.rpc.system.chain()).toString();
    const { specName, specVersion } = api.runtimeVersion;
    console.log(`network=${networkName} endpoint=${endpoint}`);
    console.log(`chain=${chain} spec=${specName}/${specVersion} bytecode=${bytecode} (${(code.length - 2) / 2} bytes)${dryRun ? " DRY_RUN" : ""}`);

    const deployer = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(suri);
    const h160 = (await api.call.reviveApi.address(deployer.address)).toString();
    const autoMap = api.consts.revive.autoMap ? api.consts.revive.autoMap.isTrue : false;
    let mapped = (await api.query.revive.originalAccount(h160)).isSome;
    let state = await readAccountState(api, deployer, pgasAssetId);

    console.log(`deployer ss58=${deployer.address} h160=${h160}`);
    console.log(`  ${describeBalances(state)}`);
    console.log(`  Revive.OriginalAccount mapped=${mapped} (runtime autoMap=${autoMap})`);
    if (api.query.sudo) {
      const sudoKey = await api.query.sudo.key();
      const isSudo = sudoKey.isSome && u8aEq(decodeAddress(sudoKey.unwrap().toString()), deployer.publicKey);
      console.log(`  sudo key=${sudoKey.isSome ? sudoKey.unwrap().toString() : "none"} deployerIsSudo=${isSudo}`);
    }

    if (networkName === "local" && state.nativeSpendable < LOCAL_TOP_UP / 10n) {
      if (dryRun) {
        console.log("  DRY_RUN: would top up the deployer from the anvil dev account");
      } else {
        await topUpFromAnvilDevAccount(api, network, deployer);
        state = await readAccountState(api, deployer, pgasAssetId);
        console.log(`  ${describeBalances(state)}`);
      }
    }

    if (!autoMap && !mapped) {
      if (dryRun) {
        console.log("DRY_RUN: would submit Revive.map_account first; this runtime cannot dry-run an unmapped origin, stopping here");
        return { status: "needs-mapping" };
      }
      await signAndWait(api, api.tx.revive.mapAccount(), deployer);
      mapped = true;
      state = await readAccountState(api, deployer, pgasAssetId);
      console.log(`  Revive.map_account submitted; ${describeBalances(state)}`);
    }

    const dryRunResult = await api.call.reviveApi.instantiate(deployer.address, 0, null, null, { Upload: code }, "0x", null);
    if (dryRunResult.result.isErr) {
      const reason = errorText(api, dryRunResult.result.asErr);
      if (FUNDS_ERRORS.has(reason)) {
        throw new InsufficientBalanceError(`Insufficient balance: the instantiate dry-run failed with ${reason}. Deployer has ${describeBalances(state)}.`);
      }
      throw new Error(`Instantiate dry-run failed: ${reason}`);
    }

    const deposit = dryRunResult.storageDeposit.isCharge ? dryRunResult.storageDeposit.asCharge.toBigInt() : 0n;
    const weightRequired = {
      refTime: dryRunResult.weightRequired.refTime.toBigInt(),
      proofSize: dryRunResult.weightRequired.proofSize.toBigInt(),
    };
    const weightLimit = {
      refTime: withMargin(weightRequired.refTime, marginPercent),
      proofSize: withMargin(weightRequired.proofSize, marginPercent),
    };
    const depositLimit = withMargin(deposit, marginPercent);
    const predictedAddress = dryRunResult.result.asOk.addr.toString();
    const tx = api.tx.revive.instantiateWithCode(0, weightLimit, depositLimit, code, "0x", null);
    const fee = (await tx.paymentInfo(deployer)).partialFee.toBigInt();

    console.log(`dry-run: predictedAddress=${predictedAddress}`);
    console.log(`  weightRequired refTime=${weightRequired.refTime} proofSize=${weightRequired.proofSize}`);
    console.log(`  storageDeposit=${deposit} estimatedFee=${fee} total=${deposit + fee}`);
    console.log(`  limits (+${marginPercent}%): refTime=${weightLimit.refTime} proofSize=${weightLimit.proofSize} storageDepositLimit=${depositLimit}`);

    if (!canAfford(state, fee, deposit)) {
      throw new InsufficientBalanceError(
        `Insufficient balance: need fee ${fee} + storage deposit ${deposit} = ${fee + deposit} raw units, ` +
          `deployer has native spendable ${state.nativeSpendable} and PGAS spendable ${state.pgasSpendable}.`,
      );
    }
    console.log("  balance check: OK");

    if (dryRun) {
      console.log("DRY_RUN=1: nothing submitted");
      return { status: "dry-run", predictedAddress };
    }

    const { events, txHash, blockHash } = await signAndWait(api, tx, deployer);
    const instantiated = events.find(({ event }) => api.events.revive.Instantiated.is(event));
    if (!instantiated) throw new Error("No Revive.Instantiated event in the inclusion block");
    const contract = instantiated.event.data.contract.toString();
    const block = await api.rpc.chain.getHeader(blockHash);

    const file = writeDeployment(networkName, {
      contract: "AccountDataStore",
      address: contract,
      network: networkName,
      chain,
      genesisHash: api.genesisHash.toHex(),
      specName: specName.toString(),
      specVersion: specVersion.toNumber(),
      bytecode,
      bytecodeKeccak256: keccakAsHex(code),
      deployer: { ss58: deployer.address, h160 },
      extrinsicHash: txHash.toHex(),
      blockHash: blockHash.toHex(),
      blockNumber: block.number.toNumber(),
      deployedAt: new Date().toISOString(),
    });
    console.log(`AccountDataStore deployed at ${contract}`);
    console.log(`  extrinsic=${txHash.toHex()} block=#${block.number} ${blockHash.toHex()}`);
    console.log(`  written to ${file}`);
    return { status: "deployed", address: contract };
  } finally {
    await api.disconnect();
  }
}

// A pending WebSocket subscription can keep the event loop alive after disconnect().
function runCli(main) {
  main()
    .catch((error) => {
      console.error(error instanceof InsufficientBalanceError ? `ABORT: ${error.message}` : error.message || error);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}

module.exports = { NETWORKS, ARTIFACTS, InsufficientBalanceError, loadBytecode, writeDeployment, deployAccountDataStore, runCli };
