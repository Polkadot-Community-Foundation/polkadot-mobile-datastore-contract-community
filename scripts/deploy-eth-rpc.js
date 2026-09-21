// SPDX-License-Identifier: GPL-3.0-only

// Deploys the PolkaVM build of AccountDataStore through the chain's ETH-RPC with `cast send --create`,
// signed by a secp256k1 key: a Cloud KMS key (`cast --gcp`) in CI, a Foundry keystore for local rehearsals.
// Substrate RPC is read alongside (genesis pin, balances, block hash for the deployment record).
//
//   npm run build:pvm
//   DEPLOY_SIGNER=gcp DEPLOY_MODE=devnet NETWORK=pcf-devnet-ci npm run deploy:eth-rpc
//   DEPLOY_SIGNER=gcp DEPLOY_MODE=live NETWORK=production ETH_RPC_URL=http://127.0.0.1:8545 npm run deploy:eth-rpc
//
// On production the deployer key also deploys DotNS, whose CREATE3 factory must be the key's nonce 0. Deploying
// AccountDataStore first would take that nonce, so on the production chain (eth chain id 420420419 or its
// genesis, live or a fork of it) the script refuses unless create1(sender, 0) already holds code. Elsewhere
// (devnet) any nonce is fine and the check is a log line.
//
// Env:
//   NETWORK            devnet | pcf-devnet-ci | production | next | local (default production); names
//                      deployments/<NETWORK>.json. pcf-devnet-ci = the devnet chain under a CI-only record name.
//   ETH_RPC_URL        the chain's ETH-RPC (default: the preset's; Polkadot Asset Hub has no public one)
//   SUBSTRATE_WS_URL   overrides the network's Substrate endpoint
//   DEPLOY_MODE        devnet | live (default) | fork. devnet and live refuse a chopsticks endpoint, fork requires
//                      one; devnet also requires the devnet chain. KMS keys are bound to modes and chains
//                      (scripts/lib/key-guard.js): contract-deployer in live on 420420419 only, never on a fork;
//                      *-devnet in devnet or fork on 420420417 only; any other name refused.
//   DEPLOY_SIGNER      gcp | keystore | private-key
//     gcp              GCP_PROJECT_ID, GCP_LOCATION, GCP_KEY_RING, GCP_KEY_NAME, GCP_KEY_VERSION (default 1)
//     keystore         ETH_KEYSTORE (file) or ETH_KEYSTORE_ACCOUNT, ETH_PASSWORD (password file); never production live
//     private-key      DEPLOYER_PRIVATE_KEY; devnet and fork modes only
//   DRY_RUN=1          preflight and estimate, submit nothing
//   CONTRACT_ADDRESS   the environment's existing instance; a devnet or live deploy stops unless ALLOW_REDEPLOY=true
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { encodeAddress, keccakAsHex } = require("@polkadot/util-crypto");
const { hexToU8a } = require("@polkadot/util");
const { JsonRpcProvider, getCreateAddress, formatUnits, parseUnits } = require("ethers");
const { NETWORKS, InsufficientBalanceError, loadBytecode, writeDeployment, runCli } = require("./lib/revive-deploy");
const { keyGuard, keyModeGuard, POLKADOT_ETH_CHAIN_ID } = require("./lib/key-guard");

const ROOT = path.join(__dirname, "..");
const PVM_MAGIC = "0x50564d00";
const MIN_BALANCE = "1.5";
const SAME_CHAIN_TIMEOUT_MS = 90_000;
const GCP_ENV = ["GCP_PROJECT_ID", "GCP_LOCATION", "GCP_KEY_RING", "GCP_KEY_NAME", "GCP_KEY_VERSION"];

function refuse(message) {
  throw new Error(`REFUSED: ${message}`);
}

function signerArgs(signer, mode, networkName, network) {
  switch (signer) {
    case "gcp": {
      process.env.GCP_KEY_VERSION ||= "1";
      const missing = GCP_ENV.filter((name) => !process.env[name]);
      if (missing.length) refuse(`DEPLOY_SIGNER=gcp needs ${missing.join(", ")}`);
      // Name and mode checks before anything connects; the chain-based keyGuard runs again once the chain is known.
      const byMode = keyModeGuard(process.env.GCP_KEY_NAME, mode);
      if (byMode) refuse(byMode);
      if (network.ethChainId) {
        const early = keyGuard(process.env.GCP_KEY_NAME, { chainId: network.ethChainId, fork: mode === "fork" });
        if (early) refuse(early);
      }
      return ["--gcp"];
    }
    case "keystore":
      if (!process.env.ETH_KEYSTORE && !process.env.ETH_KEYSTORE_ACCOUNT) refuse("DEPLOY_SIGNER=keystore needs ETH_KEYSTORE or ETH_KEYSTORE_ACCOUNT");
      if (mode === "live" && networkName === "production") refuse("production live deploys sign with DEPLOY_SIGNER=gcp only");
      return [];
    case "private-key":
      if (mode === "live") refuse("DEPLOY_SIGNER=private-key is for devnet and fork runs only");
      if (!process.env.DEPLOYER_PRIVATE_KEY) refuse("DEPLOY_SIGNER=private-key needs DEPLOYER_PRIVATE_KEY");
      return ["--private-key", process.env.DEPLOYER_PRIVATE_KEY];
    default:
      refuse(`DEPLOY_SIGNER must be gcp, keystore or private-key, got ${signer || "(unset)"}`);
  }
}

function cast(args) {
  return execFileSync("cast", args, {
    encoding: "utf8",
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function fallbackAccount(h160) {
  return `${h160.toLowerCase()}${"ee".repeat(12)}`;
}

// Read from Substrate: ETH-RPC balances and nonces can lag behind a chopsticks fork.
async function nativeAccount(api, h160) {
  const { nonce, data } = await api.query.system.account(fallbackAccount(h160));
  return { nonce: nonce.toNumber(), free: data.free.toBigInt(), reserved: data.reserved.toBigInt() };
}

async function isContract(api, address) {
  const info = await api.query.revive.accountInfoOf(address);
  return info.isSome && info.unwrap().accountType.isContract;
}

async function isChopsticks(api) {
  const { methods } = await api.rpc.rpc.methods();
  return methods.some((method) => method.toString() === "dev_newBlock");
}

async function waitFor(what, fn) {
  const deadline = Date.now() + SAME_CHAIN_TIMEOUT_MS;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) refuse(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Ties the ETH-RPC to the Substrate endpoint: its block at height n must carry the eth hash Substrate
// stores for n (revive.blockHash). Live: n is a block produced after this call, which a fork of the same
// chain (identical history, frozen head) never reaches. Fork: n is the fork head, and the ETH-RPC must be there too.
async function assertSameChain(api, eth, fork, ethRpcUrl, wsUrl) {
  const headNumber = async () => (await api.rpc.chain.getHeader()).number.toNumber();
  const start = await headNumber();
  const target = fork ? start : await waitFor(`a new block on ${wsUrl}`, async () => {
    const n = await headNumber();
    return n > start ? n : undefined;
  });
  const ethHeight = await waitFor(`${ethRpcUrl} to reach block ${target}`, async () => {
    const n = Number(await eth.send("eth_blockNumber", []));
    return n >= target ? n : undefined;
  });
  if (fork && ethHeight !== target) refuse(`ETH-RPC ${ethRpcUrl} is at block ${ethHeight}, the fork ${wsUrl} at ${target}: not the fork`);
  const blockHash = await api.rpc.chain.getBlockHash(target);
  const expected = (await (await api.at(blockHash)).query.revive.blockHash(target)).toHex();
  const block = await eth.send("eth_getBlockByNumber", [`0x${target.toString(16)}`, false]);
  if (!block || block.hash !== expected) {
    refuse(`ETH-RPC ${ethRpcUrl} block ${target} is ${block && block.hash}, ${wsUrl} has ${expected}: not the same chain`);
  }
}

// Finds the Revive.eth_transact extrinsic that carried the transaction, to record its Substrate hash.
async function extrinsicHashOf(api, blockHash, txHash) {
  const block = await api.rpc.chain.getBlock(blockHash);
  const extrinsic = block.block.extrinsics.find(
    ({ method }) => method.section === "revive" && method.method === "ethTransact" && keccakAsHex(method.args[0].toU8a(true)) === txHash,
  );
  return extrinsic ? extrinsic.hash.toHex() : null;
}

runCli(async () => {
  const networkName = process.env.NETWORK || "production";
  const network = NETWORKS[networkName] || {};
  const mode = process.env.DEPLOY_MODE || "live";
  const signer = process.env.DEPLOY_SIGNER;
  const dryRun = process.env.DRY_RUN === "1";
  const wsUrl = process.env.SUBSTRATE_WS_URL || network.wsUrl;
  const ethRpcUrl = process.env.ETH_RPC_URL || network.ethRpcUrl;
  if (!["devnet", "live", "fork"].includes(mode)) refuse(`DEPLOY_MODE must be devnet, live or fork, got ${mode}`);
  if (!wsUrl) refuse(`Unknown network ${networkName}; set SUBSTRATE_WS_URL`);
  if (!ethRpcUrl) refuse("Set ETH_RPC_URL to the chain's ETH-RPC");

  const recordPath = path.join(ROOT, "deployments", `${networkName}.json`);
  if (!dryRun && process.env.ALLOW_REDEPLOY !== "true") {
    if (mode !== "fork" && process.env.CONTRACT_ADDRESS) refuse(`${networkName} already has CONTRACT_ADDRESS=${process.env.CONTRACT_ADDRESS}; set ALLOW_REDEPLOY=true only on purpose`);
    if (fs.existsSync(recordPath)) refuse(`${path.relative(ROOT, recordPath)} exists; move it out (a fork run writes one too) or set ALLOW_REDEPLOY=true`);
  }

  const castSigner = signerArgs(signer, mode, networkName, network);
  const code = loadBytecode("pvm");
  if (!code.startsWith(PVM_MAGIC)) refuse(`artifact is not PolkaVM bytecode (starts ${code.slice(0, 10)})`);
  const codeHash = keccakAsHex(hexToU8a(code));

  const eth = new JsonRpcProvider(ethRpcUrl, undefined, { staticNetwork: true });
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
  try {
    const genesisHash = api.genesisHash.toHex();
    if (network.genesisHash && genesisHash !== network.genesisHash) refuse(`${wsUrl} is not ${networkName}: genesis ${genesisHash}`);
    const chopsticks = await isChopsticks(api);
    if (mode === "fork" && !chopsticks) refuse(`DEPLOY_MODE=fork but ${wsUrl} is not a chopsticks fork`);
    if (mode !== "fork" && chopsticks) refuse(`DEPLOY_MODE=${mode} but ${wsUrl} is a chopsticks fork`);
    if (mode === "devnet" && genesisHash !== NETWORKS.devnet.genesisHash) refuse(`DEPLOY_MODE=devnet but ${wsUrl} is not devnet Asset Hub: genesis ${genesisHash}`);

    const chainId = Number(await eth.send("eth_chainId", []));
    if (network.ethChainId && chainId !== network.ethChainId) refuse(`ETH-RPC chain id ${chainId}, ${networkName} is ${network.ethChainId}`);
    // A fork keeps the chain id and genesis of what it forked: the nonce-0 rule holds on any copy of production.
    const productionChain = chainId === POLKADOT_ETH_CHAIN_ID || genesisHash === NETWORKS.production.genesisHash;
    if (signer === "gcp") {
      const reason = keyGuard(process.env.GCP_KEY_NAME, { chainId, fork: chopsticks });
      if (reason) refuse(reason);
      // Chain ids are shared (all Asset Hub testnets report 420420417): a live KMS signature needs a pinned genesis.
      if (!chopsticks && !network.genesisHash) refuse(`DEPLOY_SIGNER=gcp signs live only on a preset that pins the genesis, not ${networkName}`);
    } else if (productionChain && !chopsticks) {
      refuse(`DEPLOY_SIGNER=${signer} never signs on live Polkadot Asset Hub (eth chain id ${chainId}); use gcp`);
    }
    await assertSameChain(api, eth, chopsticks, ethRpcUrl, wsUrl);

    const chain = (await api.rpc.system.chain()).toString();
    const { specName, specVersion } = api.runtimeVersion;
    const decimals = api.registry.chainDecimals[0];
    const symbol = api.registry.chainTokens[0];
    const format = (value) => `${formatUnits(value, decimals)} ${symbol}`;
    console.log(`network=${networkName} mode=${mode} signer=${signer}${dryRun ? " DRY_RUN" : ""}`);
    console.log(`chain=${chain} spec=${specName}/${specVersion} ethChainId=${chainId} genesis=${genesisHash}`);
    console.log(`bytecode=pvm ${(code.length - 2) / 2} bytes keccak256=${codeHash}`);

    const sender = cast(["wallet", "address", ...castSigner]).toLowerCase();
    const before = await nativeAccount(api, sender);
    const { nonce } = before;
    const nonceZeroAddress = getCreateAddress({ from: sender, nonce: 0 });
    const predictedAddress = getCreateAddress({ from: sender, nonce });
    console.log(`deployer h160=${sender} account=${encodeAddress(fallbackAccount(sender), api.registry.chainSS58)} nonce=${nonce}`);
    console.log(`  free=${format(before.free)} reserved=${format(before.reserved)}`);

    if (await isContract(api, nonceZeroAddress)) {
      console.log(`  nonce 0 used: ${nonceZeroAddress} holds code`);
    } else if (productionChain) {
      refuse(`create1(${sender}, 0) = ${nonceZeroAddress} has no code: nonce 0 belongs to the DotNS CREATE3 factory, deploy DotNS first`);
    } else {
      console.log(`  nonce 0 free: ${nonceZeroAddress} has no code (the DotNS-first rule applies on production only)`);
    }

    const minBalance = parseUnits(MIN_BALANCE, decimals);
    if (mode !== "fork" && before.free < minBalance) {
      throw new InsufficientBalanceError(`free ${format(before.free)} is below the ${MIN_BALANCE} ${symbol} a ${mode} deploy requires`);
    }

    const gas = await eth.estimateGas({ from: sender, data: code });
    const gasPrice = BigInt(await eth.send("eth_gasPrice", []));
    // ETH-RPC reports balances in 18 decimals; the native token has `decimals`.
    const maxCost = (gas * gasPrice) / 10n ** BigInt(18 - decimals);
    console.log(`estimate: predictedAddress=${predictedAddress} gas=${gas} gasPrice=${gasPrice} maxCost=${format(maxCost)}`);
    if (before.free < maxCost) throw new InsufficientBalanceError(`free ${format(before.free)} cannot cover gas × gasPrice ${format(maxCost)}`);
    console.log("  preflight: OK");

    if (dryRun) {
      console.log("DRY_RUN=1: nothing submitted");
      return;
    }

    const receipt = JSON.parse(cast(["send", "--rpc-url", ethRpcUrl, "--json", "--nonce", String(nonce), ...castSigner, "--create", code]));
    if (Number(receipt.status) !== 1) throw new Error(`deploy transaction ${receipt.transactionHash} failed: status ${receipt.status}`);
    const address = receipt.contractAddress.toLowerCase();
    if (address !== predictedAddress.toLowerCase()) throw new Error(`contract at ${address}, expected ${predictedAddress}`);
    if (!(await isContract(api, address))) throw new Error(`${address} holds no contract after the deploy`);

    const blockNumber = Number(receipt.blockNumber);
    const blockHash = (await api.rpc.chain.getBlockHash(blockNumber)).toHex();
    const after = await nativeAccount(api, sender);
    const spent = before.free + before.reserved - after.free - after.reserved;
    const file = writeDeployment(networkName, {
      contract: "AccountDataStore",
      address,
      network: networkName,
      mode,
      chain,
      genesisHash,
      ethChainId: chainId,
      specName: specName.toString(),
      specVersion: specVersion.toNumber(),
      bytecode: "pvm",
      bytecodeKeccak256: codeHash,
      deployer: { ss58: encodeAddress(fallbackAccount(sender), api.registry.chainSS58), h160: sender, nonce },
      signer: signer === "gcp" ? { kind: "gcp", key: `${process.env.GCP_KEY_RING}/${process.env.GCP_KEY_NAME}/${process.env.GCP_KEY_VERSION}` } : { kind: signer },
      transactionHash: receipt.transactionHash,
      extrinsicHash: await extrinsicHashOf(api, blockHash, receipt.transactionHash),
      blockHash,
      blockNumber,
      cost: { before: before.free.toString(), after: after.free.toString(), spent: spent.toString(), decimals },
      deployedAt: new Date().toISOString(),
    });
    console.log(`AccountDataStore deployed at ${address}`);
    console.log(`  tx=${receipt.transactionHash} block=#${blockNumber} ${blockHash} gasUsed=${BigInt(receipt.gasUsed)}`);
    console.log(`  spent=${format(spent)} (free ${format(before.free)} -> ${format(after.free)})`);
    console.log(`  written to ${file}`);
  } finally {
    eth.destroy();
    await api.disconnect();
  }
});
