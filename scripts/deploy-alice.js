// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Deploys AccountDataStore from the public dev account //Alice via `Revive.instantiate_with_code`.
//
//   npm run deploy:alice                              # local node (ws://127.0.0.1:9944)
//   DRY_RUN=1 npm run deploy:alice -- --network next  # Paseo Asset Hub Next, estimate only
//
// //Alice is a publicly known key: anyone can sign as it, so never rely on it or its funds on a
// shared network. On `local`, a deployer with too little balance is topped up from anvil's dev
// account through the runtime-pallets precompile (anvil-polkadot does not endow //Alice).
//
// Env:
//   NETWORK            local (default) | next | devnet | production; `--network <name>` takes precedence
//   DEPLOYER_SURI      default //Alice
//   SUBSTRATE_WS_URL   overrides the network's endpoint
//   BYTECODE           pvm (default) | evm
//   DRY_RUN=1          everything except submitting transactions
//   MARGIN_PERCENT     default 20
require("dotenv").config({ quiet: true });
const { deployAccountDataStore, runCli } = require("./lib/revive-deploy");

const ALICE_SURI = "//Alice";

function networkFromArgs() {
  const flagIndex = process.argv.indexOf("--network");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
  return process.env.NETWORK || "local";
}

runCli(() =>
  deployAccountDataStore({
    networkName: networkFromArgs(),
    wsUrl: process.env.SUBSTRATE_WS_URL,
    suri: process.env.DEPLOYER_SURI || ALICE_SURI,
    bytecode: process.env.BYTECODE || "pvm",
    dryRun: process.env.DRY_RUN === "1",
    marginPercent: BigInt(process.env.MARGIN_PERCENT || "20"),
    pgasAssetId: process.env.PGAS_ASSET_ID,
  }),
);
