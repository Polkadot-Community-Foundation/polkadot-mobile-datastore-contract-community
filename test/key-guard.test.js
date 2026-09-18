// SPDX-License-Identifier: GPL-3.0-only

const { expect } = require("chai");
const { keyGuard, POLKADOT_ETH_CHAIN_ID, DEVNET_ETH_CHAIN_ID } = require("../scripts/lib/key-guard");

describe("KMS key guard", function () {
  const chains = {
    "polkadot live": { chainId: POLKADOT_ETH_CHAIN_ID, fork: false },
    "polkadot fork": { chainId: POLKADOT_ETH_CHAIN_ID, fork: true },
    "devnet live": { chainId: DEVNET_ETH_CHAIN_ID, fork: false },
    "devnet fork": { chainId: DEVNET_ETH_CHAIN_ID, fork: true },
    "other live": { chainId: 1, fork: false },
  };
  const allowed = {
    "contract-deployer": ["polkadot live"],
    "contract-deployer-devnet": ["devnet live"],
    "contract-deployer-rehearsal": ["polkadot fork", "devnet fork"],
    "some-other-key": ["polkadot live"],
  };

  for (const [key, where] of Object.entries(allowed)) {
    for (const [chain, target] of Object.entries(chains)) {
      const ok = where.includes(chain);
      it(`${ok ? "allows" : "refuses"} ${key} on ${chain}`, function () {
        const reason = keyGuard(key, target);
        if (ok) expect(reason).to.equal(null);
        else expect(reason).to.be.a("string");
      });
    }
  }
});
