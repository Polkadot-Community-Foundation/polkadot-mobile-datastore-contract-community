// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Deploys AccountDataStore through the chain's ETH-RPC with a secp256k1 key.
//
//   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network paseoAssetHubNext
//
// The key is read by hardhat.config.js from the environment (or an untracked .env); it is never
// stored in the repo. ETH-RPC transactions cannot pay fees in PGAS, so the deployer's account
// (H160 ++ 0xEE * 12 on the substrate side) must hold the native token.
const { ethers, network } = require("hardhat");

const PVM_MAGIC = "0x50564d00";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error(`No deployer account configured for network ${network.name}; set DEPLOYER_PRIVATE_KEY`);

  const { chainId } = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`network=${network.name} chainId=${chainId} deployer=${deployer.address} balance=${ethers.formatEther(balance)}`);

  const store = await ethers.deployContract("AccountDataStore");
  const receipt = await store.deploymentTransaction().wait();
  const code = await ethers.provider.getCode(store.target);

  console.log(`AccountDataStore deployed at ${store.target}`);
  console.log(`tx=${receipt.hash} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
  console.log(`code=${code.startsWith(PVM_MAGIC) ? "PolkaVM" : "EVM"} (${(code.length - 2) / 2} bytes)`);
  console.log(`getCoinageInstallations(deployer) -> ${(await store.getCoinageInstallations(deployer.address)).length} entries`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
