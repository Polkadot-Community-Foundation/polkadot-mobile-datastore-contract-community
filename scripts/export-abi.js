// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Copies the ABI from the compiled artifact into abi/ and prints selectors and event topics.
// Run `npm run build` first. The ABI is identical for the solc (EVM) and resolc (PolkaVM) builds.
const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const root = path.join(__dirname, "..");
const artifactPath = path.join(root, "artifacts/contracts/AccountDataStore.sol/AccountDataStore.json");
const abiPath = path.join(root, "abi/AccountDataStore.json");

const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
fs.mkdirSync(path.dirname(abiPath), { recursive: true });
fs.writeFileSync(abiPath, `${JSON.stringify(abi, null, 2)}\n`);
console.log(`ABI written to ${path.relative(root, abiPath)}\n`);

const iface = new Interface(abi);
iface.forEachFunction((fn) => console.log(`${fn.selector}  ${fn.format("sighash")}`));
iface.forEachError((err) => console.log(`${err.selector}  error ${err.format("sighash")}`));
iface.forEachEvent((event) => console.log(`${event.topicHash}  event ${event.format("sighash")}`));
