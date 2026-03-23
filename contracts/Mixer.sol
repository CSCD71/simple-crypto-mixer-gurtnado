// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.32;

import { PoseidonT6 } from "poseidon-solidity/PoseidonT6.sol";
import { ProofOfMembershipVerifier } from "./ProofOfMembershipVerifier.sol";
import "@zk-kit/incremental-merkle-tree.sol/IncrementalBinaryTree.sol";

contract Mixer {
    using IncrementalBinaryTree for IncrementalTreeData;
    
    ProofOfMembershipVerifier private immutable VERIFIER;

    IncrementalTreeData public tree;

    mapping(uint256 => bool) nullifiers;
    mapping(uint256 => bool) nonces;

    // Emitted when a commitment is deposited to the contract
    event CommitmentDeposited(
      uint256 commitment
    );
	
    constructor(ProofOfMembershipVerifier _verifier) {
		    VERIFIER = _verifier;
        tree.init(1, 0); // init 1 deep. will tree.insert() increase depth?
    }

    // https://www.npmjs.com/package/@zk-kit/incremental-merkle-tree.sol
    function insertLeaf(uint256 _leaf) internal {
        tree.insert(_leaf);
    }

    function deposit(uint256 commitment) payable public {
        require(msg.value == 0.1 ether, "Must send exactly 0.1 ETH");
        emit CommitmentDeposited(commitment);
        insertLeaf(commitment);
    }

    function getHash(address payable to, uint256 nonce) public view returns(uint256) {
        return PoseidonT6.hash([
            uint256(block.chainid),           // to prevent reuse across multiple chains
            uint256(uint160(address(this))),  // to prevent reused with another contract
            uint256(uint160(address(to))),
            100000,
            nonce
        ]);
    }

    function withdraw(bytes calldata proof, address payable to, uint256 nonce) public {
        // unwrap the proof (to extract signals)
        // check the proof
        // extract data from signals
        // check and update nullifier reuse
        // check hash
        // check and update nonce reuse
        // transfer 0.1 ETH
    }
}
