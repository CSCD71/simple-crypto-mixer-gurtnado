import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEther, encodeAbiParameters } from "viem";
import { foundry } from "viem/chains";

import { randomBytes } from '@noble/ciphers/webcrypto';
import { poseidon2, poseidon5 } from 'poseidon-lite';
import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree";
import { groth16 } from 'snarkjs';

const TREE_DEPTH = 20;

const wasmFile = join("zk-data", "ProofOfMembership_js", "ProofOfMembership.wasm");
const zkeyFile = join("zk-data", "ProofOfMembership.zkey");
const vKey = JSON.parse(readFileSync(join("zk-data", "ProofOfMembership.vkey")));

const p = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

export function randomBigInt32ModP() {
  const bytes = randomBytes(32)
  
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return BigInt('0x' + hex) % p;
}

export function generateMerkleProof(secret, nullifier, commitments) {
    // https://github.com/zk-kit/zk-kit/blob/main/packages/imt/src/types/index.ts
    const tree = new IncrementalMerkleTree(poseidon2, TREE_DEPTH, BigInt(0), 2, commitments)
    const commitment = poseidon2([secret, nullifier]);
    const imtProof = tree.createProof(tree.indexOf(commitment));
    return { imtProof: imtProof };
}

export async function generateZkProof(address, to, nonce, secret, nullifier, commitments) {
    const { imtProof } = generateMerkleProof(secret, nullifier, commitments);
    const zkNonce = poseidon5([BigInt(foundry.id), BigInt(address), BigInt(to), parseEther("0.1"), nonce]);
    const inputs = {
        secret: secret,
        siblings: imtProof.siblings,
        pathIndices: imtProof.pathIndices,
        nullifier: nullifier,
        nonce: zkNonce
    };
    const { proof, publicSignals } = await groth16.fullProve(inputs, wasmFile, zkeyFile);
    return { proof, publicSignals };
}

export async function verifyZkProof(proof, publicSignals) {
    const result = await groth16.verify(vKey, publicSignals, proof);
    return result;
}

export async function packProofArgs(proof, publicSignals) {
    const proofCalldata = await groth16.exportSolidityCallData(proof, publicSignals);
    const proofCalldataFormatted = JSON.parse("[" + proofCalldata + "]");
    const proofCalldataEncoded = encodeAbiParameters(
      [
        { type: 'uint256[2]' },
        { type: 'uint256[2][2]' },
        { type: 'uint256[2]' },
        { type: 'uint256[4]' },
      ],
      proofCalldataFormatted
    );
    return proofCalldataEncoded;
}
