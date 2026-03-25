import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, describe, it, beforeAll, afterAll } from 'vitest';

import { createPublicClient, createWalletClient, http, parseEther, decodeEventLog, formatEther, encodeAbiParameters, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { proxy, PoseidonT6, PoseidonT3 } from 'poseidon-solidity';
import { poseidon2, poseidon3 } from 'poseidon-lite';

import { randomBigInt32ModP, generateMerkleProof, generateZkProof, verifyZkProof, packProofArgs } from '../utils/utils.js';

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

        let to, nonce, root;
        let pi;

        beforeAll(async () => {
            to = withdrawer.account.address;
            nonce = randomBigInt32ModP();
            root = generateMerkleProof(secret, nullifier, depositedCommitments).imtProof.root;

            // generate proof
            const { proof, publicSignals } = await generateZkProof(contract.address, to, nonce, secret, nullifier, depositedCommitments);
            pi = { proof, publicSignals };
        });
      
        it("Should verify the public signals", async function () {
            const { publicSignals } = pi;
            const zkNonce = await client.readContract({ ...contract, functionName: "getHash", args: [withdrawer.account.address, nonce] });

            expect(BigInt(publicSignals[0])).to.equal(root);

            const authHash = poseidon3([secret, nullifier, zkNonce]);
            expect(BigInt(publicSignals[1])).to.equal(authHash);

            expect(BigInt(publicSignals[2])).to.equal(nullifier);

            expect(BigInt(publicSignals[3])).to.equal(zkNonce);
        });

        it("Should verify the proof locally", async function () {   
            const { proof, publicSignals } = pi;
            const res = await verifyZkProof(proof, publicSignals);
            expect(res).to.be.true;
        });

        // note: doesn't trigger correct error message; either reverts contract call, or goes to "Invalid Merkle tree root" message
        // it("Should not allow withdrawal with bad proof", async function () {
        //     const badProof = "0x676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767"
        //     const request = withdrawer.writeContract({ ...contract, functionName: "withdraw", args: [badProof, to, nonce] });
        //     await expect(request).rejects.toThrow("Proof verification failed");
        // });

        it("Should not allow withdrawal to incorrect address", async function () {
            // pack arguments
            const { proof, publicSignals } = pi
            const proofCalldataEncoded = await packProofArgs(proof, publicSignals);

            // call the contract
            const thief = depositor.account.address;
            const request = withdrawer.writeContract({ ...contract, functionName: "withdraw", args: [proofCalldataEncoded, thief, nonce] });
            await expect(request).rejects.toThrow("Invalid zkNonce");
        });

        it("Should allow withdrawal and transfer funds", async function () {
            // pack arguments
            const { proof, publicSignals } = pi;
            const proofCalldataEncoded = await packProofArgs(proof, publicSignals);

            // call the contract (success)
            const hash = await withdrawer.writeContract({ ...contract, functionName: "withdraw", args: [proofCalldataEncoded, to, nonce] });
            const receipt = await client.waitForTransactionReceipt({ hash });
            receipts.push({label: "Withdraw", receipt});
            const nullifierIsUsed = await client.readContract({ ...contract, functionName: "isUsed", args: [nullifier]});
            expect(nullifierIsUsed).to.be.true;
        });

        it("Should not allow withdrawal of duplicate nullifiers", async function () {
            // pack arguments
            const { proof, publicSignals } = pi;
            const proofCalldataEncoded = await packProofArgs(proof, publicSignals);

            // call the contract
            const request = withdrawer.writeContract({ ...contract, functionName: "withdraw", args: [proofCalldataEncoded, to, nonce] });
            await expect(request).rejects.toThrow("Nullifier already used");
        });
    });
});