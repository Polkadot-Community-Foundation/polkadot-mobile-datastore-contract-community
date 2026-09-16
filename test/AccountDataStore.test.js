// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const MAX_INSTALLATION_LENGTH = 128;

// Shape of a real record: 12-byte ChaCha20-Poly1305 nonce || 32-byte ciphertext || 16-byte tag.
function encryptedInstallation() {
  return ethers.hexlify(ethers.randomBytes(12 + 32 + 16));
}

function bytesOfLength(length) {
  return ethers.hexlify(ethers.randomBytes(length));
}

async function register(store, signer, installation) {
  const tx = await store.connect(signer).registerCoinageInstallation(installation);
  return tx.wait();
}

async function installationsOf(store, signer) {
  return (await store.getCoinageInstallations(signer.address)).toArray();
}

describe("AccountDataStore", function () {
  let store;
  let alice;
  let bob;

  before(async function () {
    [alice, bob] = await ethers.getSigners();
  });

  beforeEach(async function () {
    store = await ethers.deployContract("AccountDataStore");
    await store.waitForDeployment();
  });

  it("exposes only the two functions the client uses", async function () {
    const functions = [];
    store.interface.forEachFunction((fn) => functions.push(`${fn.selector} ${fn.format("sighash")}`));

    expect(functions.sort()).to.deep.equal([
      "0x740204c6 getCoinageInstallations(address)",
      "0xe561868d registerCoinageInstallation(bytes)",
    ]);
  });

  it("stores the blob under the sender", async function () {
    const installation = encryptedInstallation();

    await register(store, alice, installation);

    expect(await installationsOf(store, alice)).to.deep.equal([installation]);
  });

  it("is a no-op when the same blob is registered again", async function () {
    const installation = encryptedInstallation();
    await register(store, alice, installation);

    const receipt = await register(store, alice, installation);

    expect(receipt.status).to.equal(1);
    expect(receipt.logs).to.have.length(0);
    expect(await installationsOf(store, alice)).to.deep.equal([installation]);
  });

  it("appends distinct blobs in registration order and dedupes any of them", async function () {
    const installations = [encryptedInstallation(), encryptedInstallation(), encryptedInstallation()];

    for (const installation of installations) {
      await register(store, alice, installation);
    }
    for (const installation of installations) {
      await register(store, alice, installation);
    }

    expect(await installationsOf(store, alice)).to.deep.equal(installations);
  });

  it("keeps each sender's list isolated", async function () {
    const aliceInstallation = encryptedInstallation();
    const bobInstallation = encryptedInstallation();

    await register(store, alice, aliceInstallation);
    await register(store, bob, bobInstallation);

    expect(await installationsOf(store, alice)).to.deep.equal([aliceInstallation]);
    expect(await installationsOf(store, bob)).to.deep.equal([bobInstallation]);
  });

  it("dedupes per sender, not globally", async function () {
    const installation = encryptedInstallation();
    await register(store, alice, installation);

    await register(store, bob, installation);

    expect(await installationsOf(store, alice)).to.deep.equal([installation]);
    expect(await installationsOf(store, bob)).to.deep.equal([installation]);
  });

  it("returns an empty list for an unknown account", async function () {
    expect(await installationsOf(store, bob)).to.deep.equal([]);
  });

  it("round-trips mixed lengths, including the bounds", async function () {
    const installations = [1, 31, 32, 33, 60, 64, 80, MAX_INSTALLATION_LENGTH].map(bytesOfLength);

    for (const installation of installations) {
      await register(store, alice, installation);
    }
    await register(store, alice, installations[3]);
    await register(store, alice, installations[installations.length - 1]);

    expect(await installationsOf(store, alice)).to.deep.equal(installations);
  });

  it("treats blobs that share a prefix or look like length prefixes as distinct", async function () {
    const base = encryptedInstallation();
    const extended = ethers.concat([base, "0x00"]);
    const truncated = ethers.dataSlice(base, 0, 59);
    const sameLengthOther = ethers.hexlify(ethers.getBytes(base).map((b, i) => (i === 59 ? b ^ 0xff : b)));
    const prefixLike = ethers.dataSlice(ethers.concat(["0x3c", base]), 0, 40);
    const installations = [base, extended, truncated, sameLengthOther, prefixLike, "0x3c"];

    for (const installation of installations) {
      await register(store, alice, installation);
    }

    expect(await installationsOf(store, alice)).to.deep.equal(installations);
  });

  it("accepts a blob of exactly the max length", async function () {
    const installation = bytesOfLength(MAX_INSTALLATION_LENGTH);

    await register(store, alice, installation);

    expect(await installationsOf(store, alice)).to.deep.equal([installation]);
  });

  it("reverts on a blob longer than the max length", async function () {
    const installation = bytesOfLength(MAX_INSTALLATION_LENGTH + 1);

    await expect(store.connect(alice).registerCoinageInstallation(installation))
      .to.be.revertedWithCustomError(store, "InstallationTooLong")
      .withArgs(MAX_INSTALLATION_LENGTH + 1, MAX_INSTALLATION_LENGTH);
    expect(await installationsOf(store, alice)).to.deep.equal([]);
  });

  it("reverts on an empty blob", async function () {
    await expect(store.connect(alice).registerCoinageInstallation("0x")).to.be.revertedWithCustomError(
      store,
      "EmptyInstallation",
    );
    expect(await installationsOf(store, alice)).to.deep.equal([]);
  });
});
