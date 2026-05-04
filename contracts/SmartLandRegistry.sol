// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * SmartLandRegistry (v2)
 *
 * Fraud-resistant primitives:
 * - Immutable event log for parcel registration + ownership transfers
 * - On-chain ownerOf (prevents duplicate sales by enforcing current owner)
 * - Threshold approvals for transfers (Lands Commission + neutral party, configurable)
 *
 * Notes:
 * - The backend can remain the workflow engine (uploads/review/escrow),
 *   but the *final* ownership commit is executed on-chain once signatures are collected.
 */
contract SmartLandRegistry is AccessControl {
    using ECDSA for bytes32;

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");

    // EIP-712
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TRANSFER_TYPEHASH =
        keccak256("Transfer(bytes32 transferId,bytes32 parcelId,address from,address to,uint256 nonce,uint256 deadline,bytes32 metadataHash)");

    string public constant NAME = "SmartLandRegistry";
    string public constant VERSION = "2";

    struct Parcel {
        address owner;
        bytes32 metadataHash; // e.g., hash of off-chain dossier (IPFS CID hash or DB snapshot hash)
        uint256 nonce; // increments on each transfer (replay protection)
        bool exists;
    }

    mapping(bytes32 => Parcel) private parcels;

    uint256 public approvalThreshold;

    event ParcelRegistered(bytes32 indexed parcelId, address indexed owner, bytes32 metadataHash);
    event ParcelMetadataUpdated(bytes32 indexed parcelId, bytes32 metadataHash);
    event TransferExecuted(
        bytes32 indexed transferId,
        bytes32 indexed parcelId,
        address indexed from,
        address to,
        uint256 nonce,
        bytes32 metadataHash
    );
    event ApprovalThresholdUpdated(uint256 threshold);

    constructor(address admin, uint256 threshold) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        approvalThreshold = threshold == 0 ? 2 : threshold;
        emit ApprovalThresholdUpdated(approvalThreshold);
    }

    function setApprovalThreshold(uint256 threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(threshold > 0, "threshold=0");
        approvalThreshold = threshold;
        emit ApprovalThresholdUpdated(threshold);
    }

    function parcelExists(bytes32 parcelId) external view returns (bool) {
        return parcels[parcelId].exists;
    }

    function ownerOf(bytes32 parcelId) external view returns (address) {
        require(parcels[parcelId].exists, "parcel_missing");
        return parcels[parcelId].owner;
    }

    function parcelNonce(bytes32 parcelId) external view returns (uint256) {
        require(parcels[parcelId].exists, "parcel_missing");
        return parcels[parcelId].nonce;
    }

    function registerParcel(bytes32 parcelId, address owner, bytes32 metadataHash) external onlyRole(REGISTRAR_ROLE) {
        require(parcelId != bytes32(0), "parcelId=0");
        require(owner != address(0), "owner=0");
        require(!parcels[parcelId].exists, "parcel_exists");
        parcels[parcelId] = Parcel({owner: owner, metadataHash: metadataHash, nonce: 0, exists: true});
        emit ParcelRegistered(parcelId, owner, metadataHash);
    }

    function updateParcelMetadata(bytes32 parcelId, bytes32 metadataHash) external onlyRole(REGISTRAR_ROLE) {
        require(parcels[parcelId].exists, "parcel_missing");
        parcels[parcelId].metadataHash = metadataHash;
        emit ParcelMetadataUpdated(parcelId, metadataHash);
    }

    struct Transfer {
        bytes32 transferId;
        bytes32 parcelId;
        address from;
        address to;
        uint256 nonce;
        uint256 deadline;
        bytes32 metadataHash;
    }

    function executeTransfer(Transfer calldata t, bytes[] calldata signatures) external onlyRole(REGISTRAR_ROLE) {
        require(block.timestamp <= t.deadline, "expired");
        require(parcels[t.parcelId].exists, "parcel_missing");
        Parcel storage p = parcels[t.parcelId];
        require(p.owner == t.from, "not_owner");
        require(t.to != address(0), "to=0");
        require(t.nonce == p.nonce, "bad_nonce");
        require(t.transferId != bytes32(0), "transferId=0");

        bytes32 digest = _hashTransfer(t);
        uint256 approvals = _countValidApprovals(digest, signatures);
        require(approvals >= approvalThreshold, "insufficient_approvals");

        // state transition
        p.owner = t.to;
        p.nonce = p.nonce + 1;
        p.metadataHash = t.metadataHash;

        emit TransferExecuted(t.transferId, t.parcelId, t.from, t.to, t.nonce, t.metadataHash);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTransfer(Transfer calldata t) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_TYPEHASH,
                t.transferId,
                t.parcelId,
                t.from,
                t.to,
                t.nonce,
                t.deadline,
                t.metadataHash
            )
        );
        return MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash);
    }

    function _countValidApprovals(bytes32 digest, bytes[] calldata signatures) internal view returns (uint256) {
        // Count unique approver signers with APPROVER_ROLE.
        // Prevent duplicate counting by tracking recovered addresses in memory.
        address[] memory seen = new address[](signatures.length);
        uint256 seenCount = 0;
        uint256 approvals = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = digest.recover(signatures[i]);
            if (!hasRole(APPROVER_ROLE, signer)) continue;

            bool already = false;
            for (uint256 j = 0; j < seenCount; j++) {
                if (seen[j] == signer) {
                    already = true;
                    break;
                }
            }
            if (already) continue;
            seen[seenCount] = signer;
            seenCount++;
            approvals++;
        }
        return approvals;
    }
}

