// SPDX-License-Identifier: GPL-3.0-only

const { expect } = require("chai");
const { keyGuard, keyModeGuard, POLKADOT_ETH_CHAIN_ID, DEVNET_ETH_CHAIN_ID } = require("../scripts/lib/key-guard");

describe("KMS key guard", function () {
  const chains = {
    "polkadot live": { chainId: POLKADOT_ETH_CHAIN_ID, fork: false },
    "polkadot fork": { chainId: POLKADOT_ETH_CHAIN_ID, fork: true },
    "devnet live": { chainId: DEVNET_ETH_CHAIN_ID, fork: false },
    "devnet fork": { chainId: DEVNET_ETH_CHAIN_ID, fork: true },
    "other live": { chainId: 1, fork: false },
    "other fork": { chainId: 1, fork: true },
  };
  const allowed = {
    "contract-deployer": ["polkadot live"],
    "contract-deployer-devnet": ["devnet live", "devnet fork"],
    "contract-deployer-rehearsal": [],
    "some-other-key": [],
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

describe("KMS key mode guard", function () {
  const modes = ["devnet", "live", "fork"];
  const allowed = {
    "contract-deployer": ["live"],
    "contract-deployer-devnet": ["devnet", "fork"],
    "contract-deployer-rehearsal": [],
    "some-other-key": [],
  };

  for (const [key, where] of Object.entries(allowed)) {
    for (const mode of modes) {
      const ok = where.includes(mode);
      it(`${ok ? "allows" : "refuses"} ${key} in DEPLOY_MODE=${mode}`, function () {
        const reason = keyModeGuard(key, mode);
        if (ok) expect(reason).to.equal(null);
        else expect(reason).to.be.a("string");
      });
    }
  }
});
