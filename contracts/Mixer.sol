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

    // currently not in use, the checks are happening manually lol
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
        ( uint256[2] memory pia, uint256[2][2] memory pib, uint256[2] memory pic, uint256[7] memory signals)
            = abi.decode(proof, (uint256[2], uint256[2][2], uint256[2], uint256[7]));
        // check the proof
        (bool valid, ) = address(VERIFIER).staticcall(abi.encodeWithSelector(ProofOfMembershipVerifier.verifyProof.selector, pia, pib, pic, signals));
        require(valid, "Proof verification failed"); 
        // extract data from signals
        uint256 nullifier = signals[0];
        uint256 proofNonce = signals[1];
        uint256 proofChainId = signals[2];
        uint256 proofMixer = signals[3];
        uint256 proofTo = signals[4];
        uint256 root = signals[5];
        uint256 authHash = signals[6];

        require(proofNonce == nonce, "Nonce mismatch");
        require(proofChainId == block.chainid, "Chain mismatch");
        require(proofMixer == uint256(uint160(address(this))), "Mixer mismatch");
        require(proofTo == uint256(uint160(address(to))), "Recipient mismatch");

        // check and update nullifier reuse
        require(!nullifiers[nullifier], "Nullifier already used");
        nullifiers[nullifier] = true;

        // check and update nonce reuse
        require(!nonces[nonce], "Nonce already used");
        nonces[nonce] = true;

        // transfer 0.1 ETH
        (bool sent, ) = to.call{value: 0.1 ether}("");
        require(sent, "Failed to send Ether");
    }
}
