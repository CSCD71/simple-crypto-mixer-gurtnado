pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "./lib/MerkleTree/MerkleTree.circom";

template ProofOfMembership(levels) {
    
    // private inputs
    signal input secret;
    signal input siblings[levels];
    signal input pathIndices[levels];
    
    // public inputs
    signal input nullifier;
    signal input nonce;
    
    // public outputs
    signal output root;
    signal output authHash;
    
    // compute the commitment hash
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs <== [secret, nullifier];
    
    // compute the merkle root from Merkle Proof values
    component tree = MerkleTreeInclusionProof(levels);
    tree.leaf <== commitmentHasher.out;
    for (var i = 0; i < levels; i++) {
        tree.siblings[i] <== siblings[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    
    root <== tree.root;
    
    // context binding
    component authHasher = Poseidon(3);
    authHasher.inputs <== [secret, nullifier, nonce];
    authHash <== authHasher.out;
}

component main {public [nullifier, nonce]} = ProofOfMembership(20);