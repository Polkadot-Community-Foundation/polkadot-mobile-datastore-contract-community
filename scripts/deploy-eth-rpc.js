// SPDX-License-Identifier: GPL-3.0-only

// Deploys the PolkaVM build of AccountDataStore through the chain's ETH-RPC with `cast send --create`,
// signed by a secp256k1 key: a Cloud KMS key (`cast --gcp`) in CI, a Foundry keystore for local rehearsals.
// Substrate RPC is read alongside (genesis pin, balances, inclusion block and cost for the deployment record).
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
// The transaction is pinned to the sender's nonce and sent with `cast send --async`; inclusion, the block and
// the cost are then read from Substrate, so a pruned, restarted or unreachable ETH-RPC after the send does not
// lose the deploy. A failed attempt (chain read, estimate or send) is retried DEPLOY_ATTEMPTS times; before each
// retry the script checks whether the pinned nonce was consumed and the contract sits at create1(sender, nonce):
// then the deploy landed and it proceeds to the record instead of sending again. Two sends with the same nonce
// cannot both land, so a retry never deploys twice.
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
//   DEPLOY_SIGNER      gcp | keystore | private-key | address
//     gcp              GCP_PROJECT_ID, GCP_LOCATION, GCP_KEY_RING, GCP_KEY_NAME, GCP_KEY_VERSION (default 1)
//     keystore         ETH_KEYSTORE (file) or ETH_KEYSTORE_ACCOUNT, ETH_PASSWORD (password file); never production live
//     private-key      DEPLOYER_PRIVATE_KEY; devnet and fork modes only
//     address          SENDER=0x… stands in for the key, DRY_RUN=1 only: preflight a key without access to it
//   DRY_RUN=1          preflight and estimate, submit nothing
//   DEPLOY_ATTEMPTS    attempts per run (default 3), 10 s then 30 s apart
//   ETH_TIMEOUT        seconds to wait for inclusion after a send (default 180); cast reads it too
//   CONTRACT_ADDRESS   the environment's existing instance; a devnet or live deploy stops unless ALLOW_REDEPLOY=true
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { keccakAsHex } = require("@polkadot/util-crypto");
const { hexToU8a } = require("@polkadot/util");
const { JsonRpcProvider, getCreateAddress, formatUnits, parseUnits, isAddress } = require("ethers");
const { NETWORKS, InsufficientBalanceError, loadBytecode, writeDeployment, runCli } = require("./lib/revive-deploy");
const { keyGuard, keyModeGuard, POLKADOT_ETH_CHAIN_ID } = require("./lib/key-guard");
const {
  FatalDeployError,
  describeAccount,
  nativeAccount,
  codeHashAt,
  codeHashesAt,
  firstBlockAfterNonce,
  findEthTransact,
  retryRead,
} = require("./lib/eth-rpc-deploy");

const ROOT = path.join(__dirname, "..");
const PVM_MAGIC = "0x50564d00";
const MIN_BALANCE = "1.5";
const SAME_CHAIN_TIMEOUT_MS = 90_000;
const DEPLOY_ATTEMPTS = Number(process.env.DEPLOY_ATTEMPTS || 3);
const RETRY_BACKOFF_MS = [10_000, 30_000];
const ETH_RPC_WAIT_MS = 120_000;
const INCLUSION_TIMEOUT_MS = Number(process.env.ETH_TIMEOUT || 180) * 1000;
const GCP_ENV = ["GCP_PROJECT_ID", "GCP_LOCATION", "GCP_KEY_RING", "GCP_KEY_NAME", "GCP_KEY_VERSION"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function refuse(message) {
  throw new FatalDeployError(`REFUSED: ${message}`);
}

function signerArgs(signer, mode, networkName, network, dryRun) {
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
    case "address":
      if (!dryRun) refuse("DEPLOY_SIGNER=address cannot sign: DRY_RUN=1 only");
      if (!isAddress(process.env.SENDER || "")) refuse("DEPLOY_SIGNER=address needs SENDER=0x… (H160)");
      return [];
    default:
      refuse(`DEPLOY_SIGNER must be gcp, keystore, private-key or address, got ${signer || "(unset)"}`);
  }
}

// cast's own diagnostics go to stderr; the thrown message stays short (the command line carries the bytecode
// and, with DEPLOY_SIGNER=private-key, the key).
function cast(args) {
  try {
    return execFileSync("cast", args, {
      encoding: "utf8",
      env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
      stdio: ["inherit", "pipe", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(`cast ${args[0]} failed (${error.status != null ? `exit ${error.status}` : error.signal || error.code})`);
  }
}

async function isChopsticks(api) {
  const { methods } = await api.rpc.rpc.methods();
  return methods.some((method) => method.toString() === "dev_newBlock");
}

async function waitFor(what, fn, timeoutMs = SAME_CHAIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) refuse(`timed out waiting for ${what}`);
    await sleep(1000);
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

// Bounded wait for the ETH-RPC to answer again after a failed attempt.
async function waitForEthRpc(eth, ethRpcUrl) {
  const deadline = Date.now() + ETH_RPC_WAIT_MS;
  for (;;) {
    try {
      await eth.send("eth_chainId", []);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`${ethRpcUrl} did not answer eth_chainId within ${ETH_RPC_WAIT_MS / 1000} s: ${error.message}`);
      await sleep(2000);
    }
  }
}

function isFatal(error) {
  return error instanceof FatalDeployError || error instanceof InsufficientBalanceError;
}

// The pinned nonce was consumed: the deploy landed if create1(sender, nonce) now runs this bytecode. Any
// other outcome (reverted, or another transaction took the nonce) leaves nothing to retry.
async function assertLanded(api, plan, codeHash) {
  const deployed = await codeHashAt(api, plan.predictedAddress);
  if (deployed === codeHash) return;
  throw new FatalDeployError(
    `nonce ${plan.nonce} of ${plan.sender} was consumed but ${plan.predictedAddress} holds ${deployed || "no contract"}, not ${codeHash}: check the key's transactions`,
  );
}

// Polls Substrate until the pinned nonce is consumed; a transaction the pool dropped never advances it.
async function awaitInclusion(api, plan) {
  const deadline = Date.now() + INCLUSION_TIMEOUT_MS;
  for (;;) {
    const { nonce } = await nativeAccount(api, plan.sender);
    if (nonce > plan.nonce) return;
    if (Date.now() > deadline) throw new Error(`nonce ${plan.nonce} not consumed within ${INCLUSION_TIMEOUT_MS / 1000} s of the send`);
    await sleep(2000);
  }
}

// Locates the inclusion block from Substrate alone: the first block after plan.startBlock where the sender's nonce
// passed plan.nonce, then the Revive.eth_transact extrinsic in it. The cost is System.Account free + reserved at
// the block's parent minus at the block, so it is exact whatever else happens to the account around the deploy.
async function locateDeploy(api, plan) {
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  const nonceAt = (n) =>
    retryRead(`nonce at block ${n}`, async () => (await nativeAccount(api, plan.sender, await api.rpc.chain.getBlockHash(n))).nonce);
  const blockNumber = await firstBlockAfterNonce(nonceAt, plan.startBlock, head, plan.nonce);
  return retryRead(`block ${blockNumber}`, async () => {
    const blockHash = (await api.rpc.chain.getBlockHash(blockNumber)).toHex();
    const { block } = await api.rpc.chain.getBlock(blockHash);
    const found = findEthTransact(block.extrinsics, plan.sender, plan.nonce);
    if (!found) throw new FatalDeployError(`block #${blockNumber} ${blockHash} consumed nonce ${plan.nonce} of ${plan.sender} without a Revive.eth_transact from it`);
    const parentHash = block.header.parentHash.toHex();
    const [before, after] = await Promise.all([nativeAccount(api, plan.sender, parentHash), nativeAccount(api, plan.sender, blockHash)]);
    const ethBlockHash = (await (await api.at(blockHash)).query.revive.blockHash(blockNumber)).toHex();
    return { ...found, blockNumber, blockHash, parentHash, ethBlockHash, before, after, spent: before.total - after.total };
  });
}

async function receiptGasUsed(eth, transactionHash) {
  try {
    const receipt = await eth.send("eth_getTransactionReceipt", [transactionHash]);
    return receipt ? BigInt(receipt.gasUsed).toString() : "n/a (receipt not served by the ETH-RPC)";
  } catch (error) {
    return `n/a (${error.message})`;
  }
}

runCli(async () => {
  const networkName = process.env.NETWORK || "production";
  const network = NETWORKS[networkName] || {};
  const mode = process.env.DEPLOY_MODE || "live";
  const signer = process.env.DEPLOY_SIGNER;
  const dryRun = process.env.DRY_RUN === "1";
  const allowRedeploy = process.env.ALLOW_REDEPLOY === "true";
  const wsUrl = process.env.SUBSTRATE_WS_URL || network.wsUrl;
  const ethRpcUrl = process.env.ETH_RPC_URL || network.ethRpcUrl;
  if (!["devnet", "live", "fork"].includes(mode)) refuse(`DEPLOY_MODE must be devnet, live or fork, got ${mode}`);
  if (!wsUrl) refuse(`Unknown network ${networkName}; set SUBSTRATE_WS_URL`);
  if (!ethRpcUrl) refuse("Set ETH_RPC_URL to the chain's ETH-RPC");
  if (!(DEPLOY_ATTEMPTS >= 1)) refuse(`DEPLOY_ATTEMPTS must be at least 1, got ${process.env.DEPLOY_ATTEMPTS}`);

  const recordPath = path.join(ROOT, "deployments", `${networkName}.json`);
  if (!dryRun && !allowRedeploy) {
    if (mode !== "fork" && process.env.CONTRACT_ADDRESS) refuse(`${networkName} already has CONTRACT_ADDRESS=${process.env.CONTRACT_ADDRESS}; set ALLOW_REDEPLOY=true only on purpose`);
    if (fs.existsSync(recordPath)) refuse(`${path.relative(ROOT, recordPath)} exists; move it out (a fork run writes one too) or set ALLOW_REDEPLOY=true`);
  }

  const castSigner = signerArgs(signer, mode, networkName, network, dryRun);
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
    } else if (productionChain && !chopsticks && signer !== "address") {
      refuse(`DEPLOY_SIGNER=${signer} never signs on live Polkadot Asset Hub (eth chain id ${chainId}); use gcp`);
    }
    await assertSameChain(api, eth, chopsticks, ethRpcUrl, wsUrl);

    const chain = (await api.rpc.system.chain()).toString();
    const { specName, specVersion } = api.runtimeVersion;
    const decimals = api.registry.chainDecimals[0];
    const symbol = api.registry.chainTokens[0];
    const format = (value) => `${formatUnits(value, decimals)} ${symbol}`;
    const minBalance = parseUnits(MIN_BALANCE, decimals);
    console.log(`network=${networkName} mode=${mode} signer=${signer}${dryRun ? " DRY_RUN" : ""} attempts=${DEPLOY_ATTEMPTS}`);
    console.log(`chain=${chain} spec=${specName}/${specVersion} ethChainId=${chainId} genesis=${genesisHash}`);
    console.log(`bytecode=pvm ${(code.length - 2) / 2} bytes keccak256=${codeHash}`);

    const sender = (signer === "address" ? process.env.SENDER : cast(["wallet", "address", ...castSigner])).toLowerCase();
    const { accountId, ss58 } = describeAccount(sender);
    const nonceZeroAddress = getCreateAddress({ from: sender, nonce: 0 });

    // Fixed by the first successful preflight: the nonce pins every send of this run to one address.
    let plan = null;
    let transactionHash = null;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        // Preflight reads: the head first, so plan.startBlock is at or before the block the nonce was read at.
        const startBlock = (await api.rpc.chain.getHeader()).number.toNumber();
        const before = await nativeAccount(api, sender);
        if (plan === null) {
          const { nonce } = before;
          plan = { sender, nonce, startBlock, predictedAddress: getCreateAddress({ from: sender, nonce }).toLowerCase() };
          console.log(`deployer h160=${sender} account=${ss58} (${accountId}) nonce=${nonce}`);
          console.log(`  free=${format(before.free)} reserved=${format(before.reserved)}`);

          if (await codeHashAt(api, nonceZeroAddress)) {
            console.log(`  nonce 0 used: ${nonceZeroAddress} holds code`);
          } else if (productionChain) {
            refuse(`create1(${sender}, 0) = ${nonceZeroAddress} has no code: nonce 0 belongs to the DotNS CREATE3 factory, deploy DotNS first`);
          } else {
            console.log(`  nonce 0 free: ${nonceZeroAddress} has no code (the DotNS-first rule applies on production only)`);
          }

          // A deploy that landed after an earlier run gave up on it must be recorded, not repeated.
          const earlier = nonce === 0 ? [] : await codeHashesAt(api, Array.from({ length: nonce }, (_, k) => getCreateAddress({ from: sender, nonce: k })));
          const instances = earlier.flatMap((hash, k) => (hash === codeHash ? [`nonce ${k}: ${getCreateAddress({ from: sender, nonce: k }).toLowerCase()}`] : []));
          if (instances.length) {
            console.log(`  this key already deployed AccountDataStore: ${instances.join(", ")}`);
            if (!dryRun && mode !== "fork" && !allowRedeploy) refuse("this key already deployed this bytecode (above); record that instance, or set ALLOW_REDEPLOY=true for a second one");
          }

          if (mode !== "fork" && before.free < minBalance) {
            throw new InsufficientBalanceError(`free ${format(before.free)} is below the ${MIN_BALANCE} ${symbol} a ${mode} deploy requires`);
          }
        } else if (before.nonce > plan.nonce) {
          await assertLanded(api, plan, codeHash);
          console.log(`attempt ${attempt}: nonce ${plan.nonce} consumed, ${plan.predictedAddress} holds the contract: the earlier send landed`);
          break;
        } else {
          console.log(`attempt ${attempt}: nonce still ${plan.nonce}, free=${format(before.free)}`);
        }

        const gas = await eth.estimateGas({ from: sender, data: code });
        const gasPrice = BigInt(await eth.send("eth_gasPrice", []));
        // ETH-RPC reports balances in 18 decimals; the native token has `decimals`.
        const maxCost = (gas * gasPrice) / 10n ** BigInt(18 - decimals);
        console.log(`estimate: predictedAddress=${plan.predictedAddress} gas=${gas} gasPrice=${gasPrice} maxCost=${format(maxCost)}`);
        if (before.free < maxCost) throw new InsufficientBalanceError(`free ${format(before.free)} cannot cover gas × gasPrice ${format(maxCost)}`);
        console.log("  preflight: OK");

        if (dryRun) {
          console.log("DRY_RUN=1: nothing submitted");
          return;
        }

        const sent = cast(["send", "--rpc-url", ethRpcUrl, "--async", "--nonce", String(plan.nonce), ...castSigner, "--create", code]);
        const hash = sent.match(/0x[0-9a-fA-F]{64}/);
        if (!hash) throw new Error(`cast send printed no transaction hash: ${sent}`);
        transactionHash = hash[0].toLowerCase();
        console.log(`sent tx=${transactionHash} nonce=${plan.nonce}, waiting for inclusion on ${wsUrl}`);
        await awaitInclusion(api, plan);
        await assertLanded(api, plan, codeHash);
        break;
      } catch (error) {
        if (isFatal(error)) throw error;
        console.error(`attempt ${attempt} of ${DEPLOY_ATTEMPTS} failed: ${error.message}`);
        if (attempt >= DEPLOY_ATTEMPTS) throw new Error(`deploy failed after ${attempt} attempts: ${error.message}`);
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1];
        console.error(`  retrying in ${backoff / 1000} s`);
        await sleep(backoff);
        await waitForEthRpc(eth, ethRpcUrl);
        // A send whose answer was lost may have landed: the next attempt's preflight sees the consumed nonce.
      }
    }

    const located = await locateDeploy(api, plan);
    if (transactionHash && located.transactionHash !== transactionHash) {
      throw new FatalDeployError(`block #${located.blockNumber} carries ${located.transactionHash} for nonce ${plan.nonce}, cast sent ${transactionHash}`);
    }
    transactionHash = located.transactionHash;
    const address = plan.predictedAddress;
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
      deployer: { ss58, accountId, h160: sender, nonce: plan.nonce },
      signer: signer === "gcp" ? { kind: "gcp", key: `${process.env.GCP_KEY_RING}/${process.env.GCP_KEY_NAME}/${process.env.GCP_KEY_VERSION}` } : { kind: signer },
      transactionHash,
      extrinsicHash: located.extrinsicHash,
      blockHash: located.blockHash,
      blockNumber: located.blockNumber,
      ethBlockHash: located.ethBlockHash,
      attempts: attempt,
      cost: {
        basis: "System.Account free + reserved of the deployer, at the parent of the inclusion block minus at the inclusion block",
        before: located.before.total.toString(),
        after: located.after.total.toString(),
        spent: located.spent.toString(),
        decimals,
      },
      deployedAt: new Date().toISOString(),
    });
    console.log(`AccountDataStore deployed at ${address}`);
    console.log(`  tx=${transactionHash} block=#${located.blockNumber} ${located.blockHash} gasUsed=${await receiptGasUsed(eth, transactionHash)}`);
    console.log(`  spent=${format(located.spent)} (free+reserved ${format(located.before.total)} -> ${format(located.after.total)}) attempts=${attempt}`);
    console.log(`  written to ${file}`);
  } finally {
    eth.destroy();
    await api.disconnect();
  }
});
