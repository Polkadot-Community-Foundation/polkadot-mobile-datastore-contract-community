// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

require("@nomicfoundation/hardhat-toolbox");
require("@parity/hardhat-polkadot");
require("dotenv").config({ quiet: true });

const LOCAL_ETH_RPC_URL = process.env.LOCAL_ETH_RPC_URL || "http://127.0.0.1:8545";

function selectedNetwork() {
  const flagIndex = process.argv.indexOf("--network");
  if (flagIndex !== -1) return process.argv[flagIndex + 1];
  return process.env.HARDHAT_NETWORK || "hardhat";
}

// resolc (PolkaVM) and solc (EVM) artifacts share contract names, so keep them in separate trees.
const PVM_NETWORKS = new Set(["localNode", "paseoAssetHubNext", "previewnet", "polkadotHubTestnet"]);
const isPvmBuild = PVM_NETWORKS.has(selectedNetwork());

function deployerAccounts() {
  return process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];
}

// All three Asset Hub testnets report the same EVM chain id, so the RPC URL is what selects the chain.
const ASSET_HUB_TESTNET_CHAIN_ID = 420420417;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  resolc: {
    compilerSource: "binary",
    version: "1.4.0",
    settings: {
      optimizer: { enabled: true, parameters: "z" },
      ...(process.env.RESOLC_PATH ? { resolcPath: process.env.RESOLC_PATH } : {}),
    },
  },
  paths: {
    artifacts: isPvmBuild ? "./artifacts-pvm" : "./artifacts",
    cache: isPvmBuild ? "./cache-pvm" : "./cache",
  },
  networks: {
    hardhat: {},
    // anvil-polkadot (or revive-dev-node + eth-rpc) listening on LOCAL_ETH_RPC_URL.
    localNode: {
      polkadot: { target: "pvm" },
      url: LOCAL_ETH_RPC_URL,
    },
    localNodeEvm: {
      polkadot: { target: "evm" },
      url: LOCAL_ETH_RPC_URL,
    },
    // Paseo Asset Hub Next: the individuality-community "next" stack (PGAS, AutoMap).
    paseoAssetHubNext: {
      polkadot: { target: "pvm" },
      url: process.env.PASEO_NEXT_ETH_RPC_URL || "https://eth-rpc-paseo-next.polkadot.io",
      chainId: ASSET_HUB_TESTNET_CHAIN_ID,
      accounts: deployerAccounts(),
    },
    previewnet: {
      polkadot: { target: "pvm" },
      url: process.env.PREVIEWNET_ETH_RPC_URL || "https://previewnet.substrate.dev/eth-rpc",
      chainId: ASSET_HUB_TESTNET_CHAIN_ID,
      accounts: deployerAccounts(),
    },
    // Public Paseo Asset Hub ("Polkadot Hub TestNet"), para 1000.
    polkadotHubTestnet: {
      polkadot: { target: "pvm" },
      url: process.env.POLKADOT_HUB_TESTNET_ETH_RPC_URL || "https://services.polkadothub-rpc.com/testnet",
      chainId: ASSET_HUB_TESTNET_CHAIN_ID,
      accounts: deployerAccounts(),
    },
  },
};
