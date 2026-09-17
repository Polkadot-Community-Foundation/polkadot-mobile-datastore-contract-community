// SPDX-License-Identifier: GPL-3.0-only

// Fails unless the resolc build matches the PolkaVM bytecode hash published in README.md, which the clients verify.
//
//   npm run build:pvm && npm run check:bytecode
const { keccakAsHex } = require("@polkadot/util-crypto");
const { bytecode } = require("../artifacts-pvm/contracts/AccountDataStore.sol/AccountDataStore.json");

const EXPECTED_PVM_KECCAK = "0xb62b11767596ab2cc5fd611714d19598f6600906ed3abef721d6ac4084309aa8";

const hash = keccakAsHex(bytecode);
console.log(`bytes=${(bytecode.length - 2) / 2} keccak256=${hash}`);
if (hash !== EXPECTED_PVM_KECCAK) {
  console.error(`PolkaVM bytecode hash ${hash} does not match the published ${EXPECTED_PVM_KECCAK}`);
  process.exit(1);
}
