// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.
pragma solidity ^0.8.28;

/// @title AccountDataStore
/// @notice Permissionless, immutable per-account store of coinage installation records.
/// Each record is an opaque, client-side encrypted blob (e.g. ChaCha20-Poly1305 nonce || ciphertext
/// of a 32-byte installId). An account can only append to its own list; nothing can be removed.
contract AccountDataStore {
    uint256 private constant MAX_INSTALLATION_LENGTH = 128;

    // One `bytes` per account holding `uint8 length || installation` records back to back. Packing
    // costs fewer storage items (and so less storage deposit) than `bytes[]`; the length prefix
    // fits in a byte because of MAX_INSTALLATION_LENGTH.
    mapping(address account => bytes records) private _coinageInstallations;

    error EmptyInstallation();
    error InstallationTooLong(uint256 length, uint256 maxLength);

    /// @notice Appends `installation` to the caller's list. Re-registering an identical blob is a no-op.
    function registerCoinageInstallation(bytes calldata installation) external {
        uint256 length = installation.length;
        if (length == 0) revert EmptyInstallation();
        if (length > MAX_INSTALLATION_LENGTH) revert InstallationTooLong(length, MAX_INSTALLATION_LENGTH);

        bytes memory records = _coinageInstallations[msg.sender];
        bytes32 installationHash = keccak256(installation);
        uint256 total = records.length;
        uint256 offset = 0;
        while (offset < total) {
            uint256 entryLength = uint8(records[offset]);
            if (entryLength == length && _hashAt(records, offset + 1, entryLength) == installationHash) return;
            offset += 1 + entryLength;
        }

        _coinageInstallations[msg.sender] = bytes.concat(records, bytes1(uint8(length)), installation);
    }

    /// @notice All installation blobs registered by `account`, in registration order.
    function getCoinageInstallations(address account) external view returns (bytes[] memory) {
        bytes memory records = _coinageInstallations[account];
        uint256 total = records.length;
        uint256 count = 0;
        for (uint256 offset = 0; offset < total; offset += 1 + uint8(records[offset])) {
            ++count;
        }

        bytes[] memory installations = new bytes[](count);
        uint256 cursor = 0;
        for (uint256 i = 0; i < count; ++i) {
            uint256 entryLength = uint8(records[cursor]);
            installations[i] = _sliceAt(records, cursor + 1, entryLength);
            cursor += 1 + entryLength;
        }
        return installations;
    }

    function _hashAt(bytes memory data, uint256 start, uint256 length) private pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := keccak256(add(add(data, 0x20), start), length)
        }
    }

    function _sliceAt(bytes memory data, uint256 start, uint256 length) private pure returns (bytes memory slice) {
        slice = new bytes(length);
        assembly ("memory-safe") {
            mcopy(add(slice, 0x20), add(add(data, 0x20), start), length)
        }
    }
}
