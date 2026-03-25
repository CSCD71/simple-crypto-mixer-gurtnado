import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, describe, it, beforeAll, afterAll } from 'vitest';

import { createPublicClient, createWalletClient, http, parseEther, decodeEventLog, formatEther, encodeAbiParameters, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { proxy, PoseidonT6, PoseidonT3 } from 'poseidon-solidity';

import { randomBytes } from '@noble/ciphers/webcrypto';
import { poseidon2, poseidon5 } from 'poseidon-lite';

import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree";
import { poseidon } from "circomlibjs";

import { groth16 } from 'snarkjs';

const rpc = http("http://127.0.0.1:8545");
const client = await createPublicClient({ chain: foundry, transport: rpc });

const privateKeys = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

// const secret = BigInt('6767676767676767676767676767676767676767676767676767676767676767676767676767');
// const nullifier = BigInt('2121212121212121212121212121212121212121212121212121212121212121212121212121');
// const commitment = poseidon2([secret, nullifier]);
// const secret2 = BigInt('696969696969696969696969696969696969669696969696969696969696969696969696969');
// const nullifier2 = BigInt('420420420420420420420420420420420420420420420420420420420420420420420420420');
// const commitment2 = poseidon2([secret2, nullifier2]);
const TREE_DEPTH = 20;

const wasmFile = join("zk-data", "ProofOfMembership_js", "ProofOfMembership.wasm");
const zkeyFile = join("zk-data", "ProofOfMembership.zkey");
// const vKey = JSON.parse(readFileSync(join("zk-data", "ProofOfMembership.vkey")));

function loadContract(contract, libraries={}) {
  const content = readFileSync(join('out', `${contract}.sol`, `${contract}.json`), "utf8");
  const artifact = JSON.parse(content);
  const abi = artifact.abi;
  let bytecode = artifact.bytecode.object;
  const substitutions = {};
  const references = Object.assign({}, ...Object.values(artifact.bytecode.linkReferences))
  for (let reference in references){
      if (!(reference in libraries)) throw new Error(`Undefined address for library ${reference}`);
      const instance = references[reference][0];
      const from = instance.start*2 + 2;
      const to = from + instance.length * 2;
      const placeholder = bytecode.slice(from, to);
      substitutions[placeholder] = libraries[reference].slice(2).toLowerCase();
  }
  for (let substitution in substitutions){
      bytecode = bytecode.replaceAll(substitution, substitutions[substitution]);
  }
  return { abi, bytecode };
}

const p = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

function randomBigInt32ModP() {
  const bytes = randomBytes(32)
  
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return BigInt('0x' + hex) % p;
}

function computeZeroHashes(depth) {
    const zeros = [0n];
    for (let i = 1; i <= depth; i++) {
        zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
    }
    return zeros;
}

function buildMerkleTree(leaves) {
    const zeros = computeZeroHashes(TREE_DEPTH);
    let currentLevel = new Map();

    for (let i = 0; i < leaves.length; i++) {
        currentLevel.set(i, BigInt(leaves[i]));
    }

    const levels = [currentLevel];

    for (let d = 0; d < TREE_DEPTH; d++) {
        const nextLevel = new Map();
        const zeroAtLevel = zeros[d];
        const parentIndices = new Set();

        for (const idx of currentLevel.keys()) {
            parentIndices.add(Math.floor(idx / 2));
        }

        for (const pIdx of parentIndices) {
            const left = currentLevel.get(pIdx * 2) ?? zeroAtLevel;
            const right = currentLevel.get(pIdx * 2 + 1) ?? zeroAtLevel;
            nextLevel.set(pIdx, poseidon2([left, right]));
        }

        currentLevel = nextLevel;
        levels.push(currentLevel);
    }

    return { levels, zeros };
}

function getMerkleProof(levels, leafIndex, zeros) {
    const siblings = [];
    const pathIndices = [];
    let idx = leafIndex;

    for (let d = 0; d < TREE_DEPTH; d++) {
        const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
        siblings.push(levels[d].get(siblingIdx) ?? zeros[d]);
        pathIndices.push(idx % 2);
        idx = Math.floor(idx / 2);
    }

    return { siblings, pathIndices };
}

function encodeProofForContract(proof, publicSignals) {
    const pA = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
    const pB = [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ];
    const pC = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];
    const signals = publicSignals.map((s) => BigInt(s));

    return encodeAbiParameters(
        [
            { type: "uint256[2]", name: "pA" },
            { type: "uint256[2][2]", name: "pB" },
            { type: "uint256[2]", name: "pC" },
            { type: "uint256[7]", name: "pubSignals" },
        ],
        [pA, pB, pC, signals]
    );
}

async function buildWithdrawalProof({ secretValue, nullifierValue, nonce, commitments, mixerAddress, recipientAddress, chainId }) {
    const targetCommitment = poseidon2([secretValue, nullifierValue]);
    const leafIndex = commitments.findIndex((c) => BigInt(c) === targetCommitment);
    if (leafIndex === -1) throw new Error("Commitment not found in commitments array");

    const { levels, zeros } = buildMerkleTree(commitments);
    const { siblings, pathIndices } = getMerkleProof(levels, leafIndex, zeros);

    const inputs = {
        secret: secretValue.toString(),
        siblings: siblings.map((s) => s.toString()),
        pathIndices: pathIndices.map((p) => p.toString()),
        nullifier: nullifierValue.toString(),
        nonce: nonce.toString(),
        chainId: chainId.toString(),
        mixer: BigInt(mixerAddress).toString(),
        to: BigInt(recipientAddress).toString(),
    };

    const { proof, publicSignals } = await groth16.fullProve(inputs, wasmFile, zkeyFile);
    return { proof, publicSignals };
}

describe("Mixer", function () {

    let depositor, withdrawer // wallets
    let contract;

    let secret, nullifier;

    const depositedCommitments = [];
    const receipts = [];

    afterAll(async () => {
        if (receipts.length === 0) return;

        console.log("\n=== Gas / ETH cost summary ===");
        
        for (const {label, receipt} of receipts){
            const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
            console.log(`• ${label}\n  gas: ${receipt.gasUsed} | cost: ${formatEther(costWei)} ETH`);
        }
        console.log("================================\n");
    });

    beforeAll(async () => {

        // Create Accounts
        [depositor, withdrawer] = await Promise.all(privateKeys.map(function(pk){
            return createWalletClient({ chain: foundry, transport: rpc , account: privateKeyToAccount(pk) });
        })); 

        // Deploy Verifier
        const hash = await depositor.deployContract(loadContract("ProofOfMembershipVerifier"));
        const receipt = await client.waitForTransactionReceipt({ hash });
        receipts.push({label: "Verifier Deployment", receipt});
        const verifierAddress = receipt.contractAddress;
        
        // Deploy Poseidon T6 contract if needed
        const hasherCode = await client.getBytecode({ address: PoseidonT6.address })
        if (!hasherCode) {
            const hash2 = await depositor.sendTransaction({to: proxy.address, data: PoseidonT6.data})
            await client.waitForTransactionReceipt({ hash: hash2 });
        }

       // Deploy Poseidon T3 contract if needed
        const hasherCode2 = await client.getBytecode({ address: PoseidonT3.address })
        if (!hasherCode2) {
            const hash3 = await depositor.sendTransaction({to: proxy.address, data: PoseidonT3.data})
            await client.waitForTransactionReceipt({ hash: hash3 });
        }

        // Deploy IncrementalBinaryTree contract
        const { abi: abi, bytecode: bytecode } = loadContract("IncrementalBinaryTree", { PoseidonT3: PoseidonT3.address });
        const hash4 = await depositor.deployContract({ abi: abi, bytecode: bytecode });
        const receipt4 = await client.waitForTransactionReceipt({ hash: hash4 });
        receipts.push({label: "IncrementalBinaryTree Deployment", receipt: receipt4});
        const address = receipt4.contractAddress;

        // Deploy Mixer linked with PoseidonT6 & IncrementalBinaryTree
        const { abi: abi2, bytecode: bytecode2 } = loadContract("Mixer", { PoseidonT6: PoseidonT6.address, IncrementalBinaryTree: address });
        const hash5 = await depositor.deployContract({ abi: abi2, bytecode: bytecode2, args: [verifierAddress] });
        const receipt5 = await client.waitForTransactionReceipt({ hash: hash5 });
        receipts.push({label: "Wallet Deployment", receipt: receipt5});
        const address2 = receipt5.contractAddress;
        contract = { address: address2, abi: abi2 };
    });

    describe("Deposit", function () {

        let commitment;

        beforeAll(async () => {
            secret = randomBigInt32ModP();
            nullifier = randomBigInt32ModP();
            commitment = poseidon2([secret, nullifier]);
        })

        it("Should allow deposits of exactly 0.1 ETH", async function () {
            const { address, abi } = contract;
            const hash = await depositor.writeContract({ address, abi, functionName: "deposit", args: [commitment], value: parseEther("0.1") });
            let receipt = await client.waitForTransactionReceipt({ hash });
            receipts.push({label: "Deposit", receipt});
            depositedCommitments.push(commitment);
            // Check that the correct event was emitted
            expect(receipt.logs).toHaveLength(1);
            const log = receipt.logs[0];
            const { args, eventName } = decodeEventLog({abi, data: log.data, topics: log.topics });
            expect(eventName).to.equal('CommitmentDeposited');
            expect(args.commitment).to.equal(commitment);
        });

        it("Should not allow deposits of less than 0.1 ETH", async function () {
            const { address, abi } = contract;
            const request = depositor.writeContract({ address, abi, functionName: "deposit", args: [commitment], value: parseEther("0.05") });
            await expect(request).rejects.toThrow("Must send exactly 0.1 ETH");
        });

        it("Should not allow deposits of more than 0.1 ETH", async function () {
            const { address, abi } = contract;
            const request = depositor.writeContract({ address, abi, functionName: "deposit", args: [commitment], value: parseEther("0.15") });
            await expect(request).rejects.toThrow("Must send exactly 0.1 ETH");
        });
    });

    describe("Withdraw", function () {

        let to, amount, nonce, tree;
        let pi;

        beforeAll(async () => {
            to = withdrawer.account.address;
            amount = parseEther("0.1");
            nonce = randomBigInt32ModP();
            tree = new IncrementalMerkleTree(poseidon2, TREE_DEPTH, BigInt(0), 2, depositedCommitments)
            const commitment = poseidon2([secret, nullifier]);
            const imtProof = tree.createProof(tree.indexOf(commitment));

            // create the proof
            const inputs = {
                secret: secret,
                siblings: imtProof.siblings,
                pathIndices: imtProof.pathIndices,
                nullifier: nullifier,
                nonce: poseidon5([BigInt(foundry.id), BigInt(contract.address), BigInt(to), amount, nonce])
            };
            const { proof, publicSignals } = await groth16.fullProve(inputs, wasmFile, zkeyFile);
            pi = { proof, publicSignals };
        });
      
        it("Should allow withdrawal", async function () {
            const { address, abi } = contract;
            const recipient = getAddress(withdrawer.account.address);
            const nonce = 123456789n;
            const chainId = BigInt(foundry.id);
            const before = await client.getBalance({ address: recipient });

            const { proof, publicSignals } = await buildWithdrawalProof({
                secretValue: secret,
                nullifierValue: nullifier,
                nonce,
                commitments: depositedCommitments,
                mixerAddress: address,
                recipientAddress: recipient,
                chainId,
            });

            const proofBytes = encodeProofForContract(proof, publicSignals);
            const txHash = await withdrawer.writeContract({
                address,
                abi,
                functionName: "withdraw",
                args: [proofBytes, recipient, nonce],
            });

            const receipt = await client.waitForTransactionReceipt({ hash: txHash });
            receipts.push({ label: "Withdraw", receipt });
            expect(receipt.status).toBe("success");

            const after = await client.getBalance({ address: recipient });
            const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
            const netReceived = after + gasCost - before;
            expect(netReceived).toBe(parseEther("0.1"));
        });

        it("Should not allow withdrawal with improper secret", async function () {
            const { address, abi } = contract;
            const recipient = getAddress(withdrawer.account.address);
            const nonce = 222222222n;
            const chainId = BigInt(await client.getChainId());

            const { proof, publicSignals } = await buildWithdrawalProof({
                    secretValue: secret2,
                    nullifierValue: nullifier,
                    nonce,
                    commitments: depositedCommitments,
                    mixerAddress: address,
                    recipientAddress: recipient,
                    chainId,
            });
            const proofBytes = encodeProofForContract(proof, publicSignals);
            const request = withdrawer.writeContract({
                    address,
                    abi,
                    functionName: "withdraw",
                    args: [proofBytes, recipient, nonce],
            });
            await expect(request).rejects.toThrow("Proof verification failed");
        });

        it("Should not allow withdrawal to incorrect address", async function () {
            const { address, abi } = contract;
            const proofRecipient = getAddress(withdrawer.account.address);
            const wrongRecipient = getAddress(depositor.account.address);
            const nonce = 333333333n;
            const chainId = BigInt(await client.getChainId());

            const { proof, publicSignals } = await buildWithdrawalProof({
                secretValue: secret,
                nullifierValue: nullifier,
                nonce,
                commitments: depositedCommitments,
                mixerAddress: address,
                recipientAddress: proofRecipient,
                chainId,
            });
            const proofBytes = encodeProofForContract(proof, publicSignals);
            const request = withdrawer.writeContract({
                    address,
                    abi,
                    functionName: "withdraw",
                    args: [proofBytes, wrongRecipient, nonce],
            });
            await expect(request).rejects.toThrow("Recipient mismatch");
        });

        it("Should not allow withdrawal of duplicate nullifiers", async function () {
            const { address, abi } = contract;
            const recipient = getAddress(withdrawer.account.address);
            const nonce = 123456789n;
            const chainId = BigInt(foundry.id);
            const before = await client.getBalance({ address: recipient });

            const { proof, publicSignals } = await buildWithdrawalProof({
                secretValue: secret,
                nullifierValue: nullifier,
                nonce,
                commitments: depositedCommitments,
                mixerAddress: address,
                recipientAddress: recipient,
                chainId,
            });

            const proofBytes = encodeProofForContract(proof, publicSignals);
            const request = withdrawer.writeContract({
                address,
                abi,
                functionName: "withdraw",
                args: [proofBytes, recipient, nonce],
            });

            expect(request).rejects.toThrow("Nullifier already used");
        });
    });
});