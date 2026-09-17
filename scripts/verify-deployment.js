// SPDX-License-Identifier: GPL-3.0-only

// Read-only checks that an AccountDataStore instance runs the locally built code, without ETH-RPC.
//
//   npm run build:pvm
//   NETWORK=devnet npm run verify:deployment             # address from deployments/devnet.json
//   NETWORK=devnet ADDRESS=0x… npm run verify:deployment
//
// Env:
//   NETWORK            a preset from scripts/lib/revive-deploy.js (default next)
//   ADDRESS            contract H160; default deployments/<NETWORK>.json .address
//   SUBSTRATE_WS_URL   overrides the network's endpoint
//   BYTECODE           pvm (default) | evm
const fs = require("fs");
const path = require("path");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { u8aToHex, u8aConcat, stringToU8a, hexToU8a } = require("@polkadot/util");
const { keccakAsHex } = require("@polkadot/util-crypto");
const { NETWORKS, ARTIFACTS, runCli } = require("./lib/revive-deploy");

const ROOT = path.join(__dirname, "..");
const GET_COINAGE_INSTALLATIONS = "0x740204c6";
// The mobile clients read from the Revive pallet account, so the check does too.
const REVIVE_PALLET_ACCOUNT = u8aToHex(u8aConcat(stringToU8a("modlpy/reviv"), new Uint8Array(20)));
const EMPTY_BYTES_ARRAY = `0x${"20".padStart(64, "0")}${"0".repeat(64)}`;

function check(ok, label, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: ${detail}`);
  return ok;
}

runCli(async () => {
  const networkName = process.env.NETWORK || "next";
  const network = NETWORKS[networkName] || {};
  const endpoint = process.env.SUBSTRATE_WS_URL || network.wsUrl;
  if (!endpoint) throw new Error(`Unknown network ${networkName}; set SUBSTRATE_WS_URL`);

  const recordPath = path.join(ROOT, "deployments", `${networkName}.json`);
  const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf8")) : null;
  const address = (process.env.ADDRESS || record?.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Set ADDRESS or provide ${path.relative(ROOT, recordPath)}`);

  const kind = process.env.BYTECODE || "pvm";
  const artifact = path.join(ROOT, ARTIFACTS[kind]);
  const expectedHash = keccakAsHex(hexToU8a(JSON.parse(fs.readFileSync(artifact, "utf8")).bytecode));

  const api = await ApiPromise.create({ provider: new WsProvider(endpoint), noInitWarn: true });
  try {
    const results = [];
    const genesis = api.genesisHash.toHex();
    results.push(check(!network.genesisHash || genesis === network.genesisHash, "genesis", `${genesis} (${endpoint})`));
    if (record) results.push(check(record.genesisHash === genesis, "record genesis", record.genesisHash));

    const code = await api.query.revive.pristineCode(expectedHash);
    results.push(check(code.isSome, "code on chain", `${expectedHash} ${code.isSome ? `${code.unwrap().length} bytes` : "absent"}`));

    const info = await api.query.revive.accountInfoOf(address);
    const contract = info.isSome && info.unwrap().accountType.isContract ? info.unwrap().accountType.asContract : null;
    const codeHash = contract ? contract.codeHash.toHex() : "not a contract";
    results.push(check(codeHash === expectedHash, "contract code hash", `${address} -> ${codeHash}`));

    const data = `${GET_COINAGE_INSTALLATIONS}${"0".repeat(64)}`;
    const call = await api.call.reviveApi.call(REVIVE_PALLET_ACCOUNT, address, 0, null, null, data);
    const ok = call.result.isOk && call.result.asOk.flags.bits.isZero();
    const returned = ok ? call.result.asOk.data.toHex() : call.result.toString();
    results.push(check(ok && returned === EMPTY_BYTES_ARRAY, "getCoinageInstallations(0x0)", returned === EMPTY_BYTES_ARRAY ? "empty bytes[]" : returned || "no data"));

    if (record) {
      results.push(check(record.bytecodeKeccak256 === expectedHash, "record bytecodeKeccak256", record.bytecodeKeccak256));
      const blockHash = await api.rpc.chain.getBlockHash(record.blockNumber);
      results.push(check(blockHash.toHex() === record.blockHash, "record block", `#${record.blockNumber} ${blockHash.toHex()}`));
    }

    if (results.includes(false)) throw new Error("verification failed");
    console.log(`AccountDataStore at ${address} on ${networkName} verified`);
  } finally {
    await api.disconnect();
  }
});
