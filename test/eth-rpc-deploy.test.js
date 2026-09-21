// SPDX-License-Identifier: GPL-3.0-only

const { expect } = require("chai");
const { Wallet, Transaction, getCreateAddress } = require("ethers");
const { keccakAsHex } = require("@polkadot/util-crypto");
const { describeAccount, fallbackAccount, firstBlockAfterNonce, findEthTransact, retryRead, FatalDeployError } = require("../scripts/lib/eth-rpc-deploy");

// The devnet CI deployer key, as recorded by deploy.yml run 35654640943.
const DEVNET_CI_KEY = "0xf04989ba6f5376fd90456f84f91bcb744c1ddf59";

describe("ETH-RPC deploy helpers", function () {
  it("derives the fallback account and its Polkadot-prefix address", function () {
    const { accountId, ss58 } = describeAccount(DEVNET_CI_KEY);
    expect(accountId).to.equal(`${DEVNET_CI_KEY}${"ee".repeat(12)}`);
    expect(fallbackAccount(DEVNET_CI_KEY.toUpperCase().replace("0X", "0x"))).to.equal(accountId);
    expect(ss58).to.match(/^1/); // prefix 0, not the generic 5…
    // 5HVmCFh3WWUvb6dJGfC4CFonzpMy3MRWMoJbUKr1vfAJMX3W (prefix 42) re-encoded with prefix 0
    expect(ss58).to.equal("16S4Lax7NHkQ2ddpEJF4LQdwrSMcjeyeSJ35dcqNUkBpXyQ8");
  });

  it("predicts create1 addresses the way the record expects", function () {
    expect(getCreateAddress({ from: DEVNET_CI_KEY, nonce: 109 }).toLowerCase()).to.equal("0xc708915e977f37c95c295feb79761a3098decb29");
  });

  describe("firstBlockAfterNonce", function () {
    const nonces = { 100: 5, 101: 5, 102: 5, 103: 6, 104: 6, 105: 7 };
    const nonceAt = async (n) => nonces[n];

    it("finds the block where the nonce passed", async function () {
      expect(await firstBlockAfterNonce(nonceAt, 100, 105, 5)).to.equal(103);
      expect(await firstBlockAfterNonce(nonceAt, 100, 105, 6)).to.equal(105);
      expect(await firstBlockAfterNonce(nonceAt, 103, 105, 6)).to.equal(105);
    });

    it("returns hi when the nonce moved in the first block after lo", async function () {
      expect(await firstBlockAfterNonce(nonceAt, 102, 103, 5)).to.equal(103);
      expect(await firstBlockAfterNonce(nonceAt, 103, 103, 5)).to.equal(103);
    });
  });

  describe("findEthTransact", function () {
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom();
    const extrinsicOf = (raw, hash) => ({
      method: { section: "revive", method: "ethTransact", args: [{ toHex: () => raw }] },
      hash: { toHex: () => hash },
    });
    const signed = async (signer, nonce) =>
      signer.signTransaction({ chainId: 420420419, nonce, type: 2, gasLimit: 500000, maxFeePerGas: 1000, maxPriorityFeePerGas: 0, data: "0x50564d00" });

    it("matches the sender's transaction by recovered sender and nonce", async function () {
      const raw = await signed(wallet, 7);
      const extrinsics = [
        { method: { section: "balances", method: "transferKeepAlive", args: [] }, hash: { toHex: () => "0x01" } },
        extrinsicOf(await signed(other, 7), "0x02"),
        extrinsicOf(await signed(wallet, 6), "0x03"),
        extrinsicOf(raw, "0x04"),
      ];
      const found = findEthTransact(extrinsics, wallet.address.toLowerCase(), 7);
      expect(found).to.deep.equal({ transactionHash: keccakAsHex(raw), extrinsicHash: "0x04" });
      expect(found.transactionHash).to.equal(Transaction.from(raw).hash);
      expect(findEthTransact(extrinsics, wallet.address, 8)).to.equal(null);
    });

    it("skips payloads that are not eth transactions", function () {
      expect(findEthTransact([extrinsicOf("0xdeadbeef", "0x05")], wallet.address, 0)).to.equal(null);
    });
  });

  describe("retryRead", function () {
    it("retries read errors and gives up with the last one", async function () {
      let calls = 0;
      const value = await retryRead("x", async () => {
        calls += 1;
        if (calls < 3) throw new Error(`boom ${calls}`);
        return "ok";
      }, { tries: 3, delayMs: 1 });
      expect(value).to.equal("ok");
      let message;
      await retryRead("y", async () => { throw new Error("nope"); }, { tries: 2, delayMs: 1 }).catch((error) => (message = error.message));
      expect(message).to.equal("y: nope");
    });

    it("does not retry a fatal error", async function () {
      let calls = 0;
      let caught;
      await retryRead("z", async () => { calls += 1; throw new FatalDeployError("fatal"); }, { tries: 5, delayMs: 1 }).catch((error) => (caught = error));
      expect(calls).to.equal(1);
      expect(caught).to.be.instanceOf(FatalDeployError);
    });
  });
});
