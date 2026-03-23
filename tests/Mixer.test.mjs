import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, describe, it, beforeAll, afterAll } from 'vitest';

import { createPublicClient, createWalletClient, http, parseEther, decodeEventLog, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

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

function loadContract(contract) {
  const content = readFileSync(join('out', `${contract}.sol`, `${contract}.json`), "utf8");
  const artifact = JSON.parse(content);
  return { abi: artifact.abi, bytecode: artifact.bytecode.object };
}

describe("Mixer", function () {
    let depositor, withdrawer,
        contract;
    
    afterAll(async () =>{
        if (receipts.length === 0) return;

        console.log("\n=== Gas / ETH cost summary ===");
        
        for (const {label, receipt} of receipts){
            const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
            console.log(`• ${label}\n  gas: ${receipt.gasUsed} | cost: ${formatEther(costWei)} ETH`);
        }
        console.log("================================\n");
    });

    beforeAll(async () => {
        // create wallets
        [,,depositor, withdrawer] = await Promise.all(privateKeys.map(function(pk){
            return createWalletClient({ chain: foundry, transport: rpc , account: privateKeyToAccount(pk) });
        })); 
        // compile the contract
        const { abi, bytecode } = loadContract("Exchange");        
        // deploy contract
        const hash = await seller1.deployContract({
            abi,
            bytecode,
            args: []
        });
        // wait for the transaction to be confirmed
        const receipt = await client.waitForTransactionReceipt({ hash });
        receipts.push({label: "Deployment", receipt});
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        currentTime = BigInt(block.timestamp);
        const address = receipt.contractAddress;
        contract = {address, abi};
    });

    describe("Deposit", function () {
        it("Should allow deposits of exactly 0.1 ETH", async function () {
            //todo
        });
        it("Should not allow deposits of less than 0.1 ETH", async function () {
            //todo
        });
        it("Should not allow deposits of more than 0.1 ETH", async function () {
            //todo
        });
    });

    describe("Withdraw", function () {
        it("Should allow withdrawal", async function () {
            //todo
        });
        it("Should not allow withdrawal with improper secret", async function () {
            //todo
        });
        it("Should not allow withdrawal of duplicate nullifiers", async function () {
            //todo
        });
    });
});