> [!WARNING]
> The following is a proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.
>
> Parity doesn't deploy the code but may update it based on community feedback.
>
> If you experience problems with any product or service that was built on or deployed from this code, you should contact the third party who deployed the code in its amended form, not Parity.

# AccountDataStore

AccountDataStore is a permissionless, immutable Solidity contract for pallet-revive (PolkaVM) on Polkadot Asset Hub, developed and published by Parity as reference code. It keeps a per-account, append-only list of small opaque blobs called coinage installation records. A wallet app that derives keys under a random per-install identifier (`installId`) can encrypt that identifier on the client and register it here from the user's account. After a reinstall, the app reads the list back, decrypts the records, and rediscovers the key subtrees of earlier installs. Only the client holding the key can decrypt a record; the contract never sees plaintext.

```
contract AccountDataStore
coinageInstallationStore: AccountId -> Bytes[]
fun registerCoinageInstallation(origin, installId: Bytes)
view fun getCoinageInstallations(account): Vec<Bytes>
```

What it does:
- Stores 1–128 byte blobs under `msg.sender`, in registration order, deduplicated per sender.
- Returns an account's blobs as `bytes[]` to anyone.
- Compiles to PolkaVM bytecode with `resolc`, and to EVM bytecode for revive's REVM backend. The tests pass on both.

What it doesn't do:
- No encryption, key management or validation of blob contents; that is the client's job.
- No deletion or editing of records, no owner, admin, pause or upgrade path.
- No events, pagination or per-account entry cap.
- No deployed instance is published or maintained by this repo.

## Prerequisites and quickstart

- Node >= 22 and npm. The in-process tests need nothing else: no node, no funded account, no wallet extension.
- To run the suite against a real pallet-revive runtime, a local `anvil-polkadot` node (see [Build and test](#build-and-test)).
- To deploy to a public testnet, a funded account of your own on that network (see [Deploying](#deploying)).
- Target network: **Paseo Asset Hub Next**, the chain used by the public `paritytech/individuality-community` repo. Previewnet and Polkadot Hub TestNet are also configured.

```sh
git clone <this repo> && cd account-data-store-contract
npm ci
npm test               # 12 passing, Hardhat in-process EVM
```

## Interface

| Kind | Solidity signature | Selector |
|---|---|---|
| function | `registerCoinageInstallation(bytes installation)` | `0xe561868d` |
| view | `getCoinageInstallations(address account) returns (bytes[])` | `0x740204c6` |
| error | `EmptyInstallation()` | `0x00305b93` |
| error | `InstallationTooLong(uint256 length, uint256 maxLength)` | `0x0472a99d` |

- That is the whole ABI; the contract emits no events.
- Selectors were computed with ethers (`npm run abi` prints them) and cross-checked with `cast sig`.
- The ABI is committed at [`abi/AccountDataStore.json`](abi/AccountDataStore.json). It is identical for the solc and resolc builds.
- The four entries are byte-identical to the corresponding entries of an earlier, larger ABI, so client code written against them is unaffected.

### Semantics

- **Storage key.** `registerCoinageInstallation` stores under `msg.sender`. For an sr25519 account calling through `Revive.call`, that is `keccak256(accountId32)[12..32]`.
- **Accepted input.** An empty blob reverts with `EmptyInstallation`. A blob longer than 128 bytes reverts with `InstallationTooLong(length, 128)`.
- **Idempotent.** Registering a byte-identical blob again from the same sender is a successful no-op: no new entry and no revert. Dedupe is per sender, so the same bytes from another account are a separate entry.
- **Getter.** `getCoinageInstallations` returns the blobs in registration order. An unknown account gets an empty array.

## Design choices

- **Packed storage, one `bytes` per account.** Each record is stored as `uint8 length || installation`, back to back.
  - Revive charges a storage deposit per 32-byte storage item plus per byte, and the item count dominates.
  - With `bytes[]`, every entry pays for its own length slot as well as its data slots. A dedupe mapping would add one more flag slot per entry.
  - Packed, a 60-byte record (61 bytes with its prefix) adds 2 items, and about 1.9 on average. An earlier version took 4.
  - The getter splits the records back into `bytes[]`, so the external ABI is unchanged. Measurements are below.
- **Dedupe by linear scan, with no extra storage.** A register loads the caller's records, compares each record's length and then its keccak256 against the input, and returns early on a match. The scan costs weight that grows with the list, but lists hold a handful of entries and the deposit saving is much larger. The measurements put the break-even at around 115 entries per account.
- **Idempotency means byte-identical.** ChaCha20-Poly1305 with a random nonce produces a different blob each time for the same `installId`, so the contract cannot see that two such blobs are the same install. The client must reuse the exact bytes when it resubmits. See the client notes below.
- **Length bounded to 1..128 bytes.**
  - A record is 12 + 32 + 16 = 60 bytes (nonce, ciphertext, Poly1305 tag); 128 leaves room for a version byte or an XChaCha 24-byte nonce.
  - The upper bound matters for correctness: it is what lets the length prefix fit in one byte.
  - Both checks are nearly free. Removing them saved 155 bytes of PolkaVM code, about 0.2% of the deploy deposit, and made no measurable difference to registration weight or deposit.
- **No events.** Events add no storage deposit, only weight, and the client reads state rather than subscribing to logs.
- **No per-account entry cap.** Each account pays its own deposit and can only grow its own list, so a large list only harms its owner. See the size note in the risks section.
- **Custom errors instead of revert strings.** They are cheaper, and the client can match them by 4-byte selector.
- **No owner, admin, pause, upgrade, `selfdestruct`, or delegatecall.** No function deletes or edits a record. An account can only append to its own list.

## Storage deposit and weight

Measured with `scripts/measure-deposits.js` on a fresh anvil-polkadot 1.5.1 node, using 60-byte blobs.
- Deposits come from `ReviveApi` dry-runs, so they are exact for that runtime.
- The dev runtime charges `2e9` per child-trie item and `1e7` per byte, which is `2.64e9` per 32-byte storage item.
- The "Next" rows apply Next's constants (`2e8` per item and `1e5` per byte, so `2.064e8` per storage item) to the same item counts.

"Old" is an earlier version of the contract: `bytes[]` plus a `mapping(bytes32 => bool)` dedupe. "ArrayScan" was an intermediate candidate: `bytes[]` with a linear-scan dedupe. **Packed** is the current contract. The deposits are identical for PolkaVM and EVM bytecode.

| Registration deposit | Old | ArrayScan | **Packed** |
|---|---|---|---|
| 1st entry, local (raw) | 13.20e9 (5 items) | 10.56e9 (4) | **7.92e9 (3)** |
| each later entry, local (raw) | 10.56e9 (4) | 7.92e9 (3) | **5.28e9 (2)** |
| 1st entry, Next estimate | 1.032e9 | 8.26e8 | **6.19e8** (−40% vs Old) |
| each later entry, Next estimate | 8.26e8 | 6.19e8 | **4.13e8** (−50% vs Old) |
| no-op re-register | 0 | 0 | 0 |

Weight is shown as ref_time / proof_size for the PolkaVM build. The Next fee is a read-only `paymentInfo` quote for a `Revive.call` with that weight limit:

| Registration weight | Old | **Packed** | Next fee quote (raw), Old → Packed |
|---|---|---|---|
| 1st entry | 1.597e9 / 124k | 0.987e9 / 69k | 2.76e7 → 2.27e7 |
| 2nd entry | 1.597e9 / 124k | 1.630e9 / 110k | 2.76e7 → 2.63e7 |
| 5th entry | 1.597e9 / 124k | 3.418e9 / 233k | 2.76e7 → 3.72e7 |
| 10th entry | 1.597e9 / 124k | 6.398e9 / 439k | 2.76e7 → 5.54e7 |
| no-op, list of 10 | 0.247e9 / 32k | 2.336e9 / 234k | 1.94e7 → 3.72e7 |

- The weight grows with the list because a register loads and rewrites all of the caller's records. That adds about 3.6e6 raw of fee per existing entry, against a deposit saving of about 4.1e8 per later entry, so Packed stays cheaper up to roughly 115 entries per account.
- The EVM build has the same shape: Packed goes from 0.81e9 / 62k at the 1st entry to 5.39e9 / 432k at the 10th, while Old stays flat at 1.30e9 / 93k.
- ArrayScan's weight grows at a similar rate: 4.84e9 / 456k at the 10th entry, and a no-op on its last entry costs 4.35e9 / 436k.

### Deploy cost

| | Old PolkaVM | **New PolkaVM** | Old EVM | **New EVM** |
|---|---|---|---|---|
| Code size | 20,906 B | **17,081 B** | 2,684 B | **2,021 B** |
| Local deposit (raw, includes code upload) | 9.939e11 | **9.442e11** | 7.566e11 | **7.480e11** |
| Local fee (raw) | 2.121e11 | **1.738e11** | 2.95e10 | **2.28e10** |
| Next deposit (read-only dry-run) | 9.939e9 | **9.441e9** | 7.566e9 | **7.480e9** |
| Next fee (read-only `paymentInfo`) | 1.054e9 | **8.63e8** | 1.43e8 | **1.10e8** |
| Next total | 1.099 PAS | **1.030 PAS** | 0.771 PAS | **0.759 PAS** |

## Toolchain and versions

| Tool | Version |
|---|---|
| Hardhat | 2.29.1 (`@parity/hardhat-polkadot` 0.3.0 requires Hardhat 2) |
| `@nomicfoundation/hardhat-toolbox` | 6.1.2 (ethers 6.17) |
| `@parity/hardhat-polkadot` | 0.3.0 |
| resolc | 1.4.0 (`1.4.0+commit.ca3c770.llvm-22.1.5`); the plugin downloads the binary, `RESOLC_PATH` overrides it |
| solc | 0.8.30, optimizer on, `evmVersion: cancun` (the getter uses `mcopy`); resolc runs with `-Oz` |
| Local revive node | `anvil-polkadot` 1.5.1 from foundry-polkadot. It serves ETH-RPC on `:8545` and Substrate RPC on `:9944` |
| `@polkadot/api` | 16.5.6, for the Substrate-side scripts |
| Node | >= 22 |

PolkaVM build output: 17,081 bytes, `keccak256 = 0xb62b11767596ab2cc5fd611714d19598f6600906ed3abef721d6ac4084309aa8`, starting with `0x50564d00` (`PVM\0`). The EVM runtime is 1,993 bytes.

### Why Hardhat and not foundry-polkadot

`@parity/hardhat-polkadot` compiles with resolc and can run one test suite against three targets: the in-process EVM, anvil-polkadot with PolkaVM bytecode, and anvil-polkadot with EVM bytecode. The `@polkadot/api` scripts for the Substrate-signed path live in the same project. foundry-polkadot 1.5.1 also works, and its `anvil-polkadot` is the local node used here. Its `forge test` runs in a local EVM, and `forge script` is not supported on revive.

## Build and test

```sh
npm ci
npm run build          # solc: artifacts/
npm run build:pvm      # resolc: artifacts-pvm/ (network localNode selects the PolkaVM target)
npm run abi            # rebuild and rewrite abi/AccountDataStore.json, print selectors
npm test               # Hardhat in-process EVM (EDR)
```

To run the same suite on a real pallet-revive runtime, start `anvil-polkadot`:

```sh
curl -L https://raw.githubusercontent.com/paritytech/foundry-polkadot/refs/heads/master/foundryup/install | bash
foundryup-polkadot                   # installs forge, cast, anvil-polkadot
# or download a v1.5.1 release archive from paritytech/foundry-polkadot releases
anvil-polkadot --port 8545           # ETH-RPC :8545, Substrate RPC :9944

npm run test:pvm       # PolkaVM bytecode (resolc) on pallet-revive
npm run test:revm      # EVM bytecode on pallet-revive's REVM backend
npm run e2e:substrate  # sr25519 account -> Revive.call path (see below)
npx hardhat run scripts/measure-deposits.js --network localNode      # deposits and weights, PolkaVM
npx hardhat run scripts/measure-deposits.js --network localNodeEvm   # same, EVM bytecode
```

Run `measure-deposits.js` on a fresh node: the deploy deposit includes the code upload only if that code is not already on chain.

## Deploying

### Deployments and releases

- This repo does not publish or maintain deployed instances. Anyone who deploys the contract is responsible for their own deployment.
- The deploy scripts write `deployments/<network>.json` locally. The directory is git-ignored.
- Tagged releases, if any, are on the GitHub Releases page.
- To verify a build, compare the keccak256 of the PolkaVM bytecode: the value in [Toolchain and versions](#toolchain-and-versions), the `bytecodeKeccak256` field the Substrate deploy scripts record, and the code on chain, e.g. `cast keccak $(cast code <address> --rpc-url <eth-rpc>)`.

### Path A (recommended): sr25519 key through Substrate, `scripts/deploy-substrate.js`

This path uses `Revive.instantiate_with_code`, signed by an sr25519 key. It is the same kind of account and call path a Substrate client uses, and it can pay in PGAS.

```sh
npm ci && npm run build:pvm

# 1. Put the deployer's passphrase in the git-ignored .env (see .env.example); never on a shared command line.
cp .env.example .env && $EDITOR .env         # DEPLOYER_MNEMONIC="<12 or 24 words>", optional DEPLOYER_DERIVATION
export NETWORK=next                          # local | next; SUBSTRATE_WS_URL overrides the endpoint

# 2. Dry-run: prints the deployer's H160, PAS and PGAS balances, the mapping state,
#    the predicted contract address, weight, storage deposit and fee. Submits nothing.
DRY_RUN=1 npm run deploy:substrate

# 3. Deploy. Weight and deposit limits are the dry-run values plus MARGIN_PERCENT (default 20).
npm run deploy:substrate
#   -> "AccountDataStore deployed at 0x…", also written to deployments/next.json

# 4. Verify over ETH-RPC.
cast code <address> --rpc-url https://eth-rpc-paseo-next.polkadot.io | cut -c1-10    # 0x50564d00
cast call <address> "getCoinageInstallations(address)(bytes[])" 0x0000000000000000000000000000000000000000 \
  --rpc-url https://eth-rpc-paseo-next.polkadot.io                                    # []
```

The script (shared logic in `scripts/lib/revive-deploy.js`):
- Aborts with `ABORT: Insufficient balance …` when the deployer cannot cover fee plus storage deposit from PAS or PGAS. It checks this before submitting, and in `DRY_RUN` as well.
- Registers encodings for the individuality transaction extensions: `AsScarcity`, `AsPgas` and `AsDotnsGateway` as `None`, and `RestrictOrigins` as `false`. This encoding was validated against live Next metadata with `paymentInfo`, which decodes the full extrinsic.
- Signs with only the extensions listed for metadata v16 extension version 0, which is what a v4 signed transaction carries. Chains that list the individuality extensions only in version 1 can then still decode it.
- Calls `map_account` first only on chains without AutoMap, when the deployer is not yet mapped.
- Accepts `BYTECODE=evm` to deploy the solc build instead.

### Dev deploy from `//Alice`, `scripts/deploy-alice.js`

This is the same flow with the SURI defaulting to the public dev key `//Alice`; `DEPLOYER_SURI` overrides it. The network defaults to `local`.

```sh
npm run build:pvm
npm run deploy:alice                               # local: ws://127.0.0.1:9944 (anvil-polkadot / revive dev node)
DRY_RUN=1 npm run deploy:alice                     # everything except submitting
DRY_RUN=1 npm run deploy:alice -- --network next   # Paseo Asset Hub Next (or NETWORK=next)
BYTECODE=evm npm run deploy:alice                  # solc build instead of resolc
```

Before submitting, it prints:
- the deployer's SS58 address and H160
- free PAS and PGAS balances
- whether the deployer is mapped (`Revive.OriginalAccount`) and, on chains with `pallet-sudo`, whether it holds the sudo key
- the dry-run weight, storage deposit and fee

After a real deploy, it prints the contract address and writes `deployments/<network>.json`.

On `local`, anvil-polkadot does not endow `//Alice`. So unless `DRY_RUN` is set, the script tops her up from anvil's well-known dev account through the runtime-pallets precompile, then calls `map_account` because AutoMap is off there. With `DRY_RUN=1` on a fresh anvil-polkadot, it stops after reporting that funding and mapping would be needed: that runtime cannot dry-run an unmapped origin.

Local run, fresh anvil-polkadot 1.5.1:

```
deployer ss58=5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY h160=0x9621dde636de098b43efb0fa9b61facfe328f99d
  native free=0 reserved=0 spendable=0; PGAS=n/a (no PGAS asset) spendable=0
  Revive.OriginalAccount mapped=false (runtime autoMap=false)
  topped up 100000000000000 from anvil dev account 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  Revive.map_account submitted; native free=99797547610489 reserved=200520000000 ...
dry-run: predictedAddress=0x5801b439a678d9d3a68b8019da6a4abfa507de11
  weightRequired refTime=10199157 proofSize=0
  storageDeposit=944158000000 estimatedFee=173778475654 total=1117936475654
  balance check: OK
AccountDataStore deployed at 0x5801b439a678d9d3a68b8019da6a4abfa507de11
  written to deployments/local.json
```

**Do not use `//Alice` on public chains.** It is a public dev key: anyone can sign as `//Alice`, so on a public chain its balance is anyone's to spend. Do not fund it there, and do not treat a contract it deploys as trusted. It typically cannot afford a deploy on Next; a dry-run then aborts with `ABORT: Insufficient balance: the instantiate dry-run failed with revive.StorageDepositNotEnoughFunds.` The contract itself has no owner, so the deployer's identity does not matter afterwards. For public networks, use Path A with your own key.

### Path B: secp256k1 key through ETH-RPC, `scripts/deploy.js`

```sh
npm run build:pvm
DEPLOYER_PRIVATE_KEY=0x… npx hardhat run scripts/deploy.js --network paseoAssetHubNext
```

- Other configured networks: `previewnet`, `polkadotHubTestnet`.
- ETH-RPC transactions **cannot pay fees in PGAS** (they use `new_skip_pgas`). The deployer's Substrate account, `H160 ++ 0xEE × 12`, must hold PAS.
- Every Asset Hub testnet has chain id 420420417. An EVM-signed transaction can be replayed on another of these chains where the same key has the same nonce, so use a fresh key for each chain.

## Contributing

Issues and pull requests are welcome on GitHub.

## Security

Before deploying it for real use cases, you are responsible for:

- Reviewing the code yourself, we publish a reference, not a hardened production build
- Checking that the dependencies are up to date and free of known vulnerabilities
- Securing your own fork or deployment environment (keys, secrets, network configuration)
- Tracking the latest tagged release/commits for security fixes; older releases are not backported (exceptions might apply)

For Parity's security disclosure process, and Bug Bounty program, feel free to visit: https://parity.io/bug-bounty

## License

Copyright (C) 2026 Parity Technologies (UK) Ltd. Licensed under the GNU General Public License v3.0 only (GPL-3.0-only); see [LICENSE](LICENSE).
