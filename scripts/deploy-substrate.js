// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Deploys AccountDataStore with `Revive.instantiate_with_code` signed by an sr25519 substrate key,
// the same kind of account the mobile client uses. On Asset Hub Next the fee and the storage
// deposit are taken in PGAS when the deployer holds enough, otherwise in PAS.
//
//   npm run build:pvm
//   npm run deploy:substrate          # reads DEPLOYER_MNEMONIC from the git-ignored .env
//
// Env:
//   DEPLOYER_MNEMONIC  BIP-39 passphrase of the sr25519 deployer; checked before anything is derived.
//                      Kept out of DEPLOYER_SURI so deploy-alice.js, which reads the same .env, stays on //Alice.
//   DEPLOYER_DERIVATION optional derivation appended to the mnemonic, e.g. //deploy
//   DEPLOYER_SURI      fallback when DEPLOYER_MNEMONIC is unset: any sr25519 secret URI. Never commit either.
//   NETWORK            local | next | devnet | production (default next); names deployments/<NETWORK>.json
//   SUBSTRATE_WS_URL   overrides the network's endpoint
//   BYTECODE           pvm (default, resolc artifact) | evm (solc artifact; needs AllowEVMBytecode)
//   DRY_RUN=1          everything except submitting transactions
//   MARGIN_PERCENT     headroom added to the dry-run weight and deposit, default 20
//   PGAS_ASSET_ID      default from the network preset (2000000000 on Paseo, 49999999 on Polkadot)
require("dotenv").config({ quiet: true });
const { cryptoWaitReady, mnemonicValidate } = require("@polkadot/util-crypto");
const { deployAccountDataStore, runCli } = require("./lib/revive-deploy");

async function deployerSuri() {
  const mnemonic = (process.env.DEPLOYER_MNEMONIC || "").trim().split(/\s+/).filter(Boolean).join(" ");

  if (mnemonic) {
    await cryptoWaitReady();
    // A mistyped word still derives a key, just someone else's; refuse instead of deploying from it.
    if (!mnemonicValidate(mnemonic)) throw new Error("DEPLOYER_MNEMONIC is not a valid BIP-39 passphrase");

    return mnemonic + (process.env.DEPLOYER_DERIVATION || "");
  }

  if (process.env.DEPLOYER_SURI) return process.env.DEPLOYER_SURI;

  throw new Error("Set DEPLOYER_MNEMONIC in .env (or DEPLOYER_SURI in the environment)");
}

runCli(async () => {
  const suri = await deployerSuri();

  await deployAccountDataStore({
    networkName: process.env.NETWORK || "next",
    wsUrl: process.env.SUBSTRATE_WS_URL,
    suri,
    bytecode: process.env.BYTECODE || "pvm",
    dryRun: process.env.DRY_RUN === "1",
    marginPercent: BigInt(process.env.MARGIN_PERCENT || "20"),
    pgasAssetId: process.env.PGAS_ASSET_ID,
  });
});
