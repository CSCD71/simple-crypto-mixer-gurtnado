import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  parseAbiItem,
  parseEther,
  encodeAbiParameters,
} from "https://esm.sh/viem@2.19.4";
import * as chains from "https://esm.sh/viem@2.19.4/chains";
import { poseidon2 } from "https://esm.sh/poseidon-lite@0.3.0";
import { randomBytes } from '@noble/ciphers/webcrypto';

// ---------------------------------------------------------------------------
// ZK constants & helpers (browser-compatible replacements for @prifilabs/zk-toolbox)
// ---------------------------------------------------------------------------
const SNARK_FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TREE_DEPTH = 20;
const WASM_PATH = "zk-data/ProofOfMembership_js/ProofOfMembership.wasm";
const ZKEY_PATH = "zk-data/ProofOfMembership.zkey";
const VKEY_PATH = "zk-data/ProofOfMembership.vkey";

// ---------------------------------------------------------------------------
// Sourced from https://github.com/prifilabs/zk-toolbox/blob/master/src/Utils.ts
// ---------------------------------------------------------------------------
function randomBigInt32ModP() {
  const bytes = randomBytes(32)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return BigInt('0x' + hex) % p;
}

// ---------------------------------------------------------------------------
// Sparse incremental Merkle tree (matches @zk-kit/incremental-merkle-tree with Poseidon)
// ---------------------------------------------------------------------------
function computeZeroHashes(depth) {
  const zeros = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

function buildMerkleTree(leaves) {
  const zeros = computeZeroHashes(TREE_DEPTH);

  // Level 0: leaf values (sparse map)
  let currentLevel = new Map();
  for (let i = 0; i < leaves.length; i++) {
    currentLevel.set(i, leaves[i]);
  }

  const levels = [currentLevel];

  for (let d = 0; d < TREE_DEPTH; d++) {
    const nextLevel = new Map();
    const zeroAtLevel = zeros[d];

    // Collect parent indices that have at least one non-default child
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

  const root = currentLevel.get(0) ?? zeros[TREE_DEPTH];
  return { levels, root, zeros };
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

// ---------------------------------------------------------------------------
// Proof generation & encoding (using snarkjs loaded globally from CDN)
// ---------------------------------------------------------------------------
async function generateZkProof(secret, nullifier, nonce, commitments) {
  // Build the Merkle tree from on-chain commitments
  const commitment = poseidon2([secret, nullifier]);
  const leafIndex = commitments.findIndex((c) => c === commitment);
  if (leafIndex === -1) throw new Error("Commitment not found in the on-chain Merkle tree");

  const { levels, zeros } = buildMerkleTree(commitments);
  const { siblings, pathIndices } = getMerkleProof(levels, leafIndex, zeros);

  // Prepare circuit inputs (snarkjs expects string values)
  const circuitInputs = {
    secret: secret.toString(),
    siblings: siblings.map((s) => s.toString()),
    pathIndices: pathIndices.map((p) => p.toString()),
    nullifier: nullifier.toString(),
    nonce: nonce.toString(),
  };

  // Generate Groth16 proof via snarkjs (loaded as global from CDN)
  const { proof, publicSignals } = await window.snarkjs.groth16.fullProve(
    circuitInputs,
    WASM_PATH,
    ZKEY_PATH
  );

  return { proof, publicSignals };
}

async function verifyZkProofLocally(proof, publicSignals) {
  const vkey = await fetch(VKEY_PATH).then((r) => r.json());
  return window.snarkjs.groth16.verify(vkey, publicSignals, proof);
}

function encodeProofForContract(proof, publicSignals) {
  // Groth16 proof points (note: pi_b coordinates are swapped for Solidity verifier)
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
      { type: "uint256[4]", name: "pubSignals" },
    ],
    [pA, pB, pC, signals]
  );
}

// ---------------------------------------------------------------------------
// Mixer contract ABI fragments
// ---------------------------------------------------------------------------
const DEPOSIT_VALUE = parseEther("0.1");

const ABI_DEPOSIT = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [{ name: "commitment", type: "uint256" }],
    outputs: []
  }
];

const ABI_WITHDRAW = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "to", type: "address" },
      { name: "nonce", type: "uint256" }
    ],
    outputs: []
  }
];

const ABI_COMMITMENT_EVENT = parseAbiItem(
  "event CommitmentDeposited(bytes commitment)"
);

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const connectButton = document.getElementById("connectButton");
const networkSelect = document.getElementById("networkSelect");
const walletStatus = document.getElementById("walletStatus");
const contractLink = document.getElementById("contractLink");
const contractLinkUrl = document.getElementById("contractLinkUrl");
const txModal = document.getElementById("txModal");
const closeModal = document.getElementById("closeModal");
const txBody = document.getElementById("txBody");
const tabsNav = document.querySelector(".tabs-nav");
const tabPanels = document.querySelectorAll(".tab-panel");
const walletGate = document.getElementById("walletGate");

// deposit UI
const depositForm = document.getElementById("depositForm");
const depositMessage = document.getElementById("depositMessage");
const depositSecret = document.getElementById("depositSecret");
const depositNullifier = document.getElementById("depositNullifier");
const depositCommitment = document.getElementById("depositCommitment");
const generateSecretsBtn = document.getElementById("generateSecretsBtn");
const secretNoteSection = document.getElementById("secretNoteSection");
const secretNoteText = document.getElementById("secretNoteText");
const copyNoteBtn = document.getElementById("copyNoteBtn");
const downloadNoteBtn = document.getElementById("downloadNoteBtn");

// withdraw UI
const withdrawForm = document.getElementById("withdrawForm");
const withdrawMessage = document.getElementById("withdrawMessage");
const withdrawNoteInput = document.getElementById("withdrawNoteInput");
const parseNoteBtn = document.getElementById("parseNoteBtn");
const withdrawSecret = document.getElementById("withdrawSecret");
const withdrawNullifier = document.getElementById("withdrawNullifier");
const withdrawRecipient = document.getElementById("withdrawRecipient");
const proofStatus = document.getElementById("proofStatus");

// ---------------------------------------------------------------------------
// Tab system
// ---------------------------------------------------------------------------
function initializeTabs() {
  const tabButtons = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabName = button.getAttribute("data-tab");
      if (!tabName) return;
      tabButtons.forEach((btn) => btn.classList.remove("active"));
      panels.forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      const activePanel = document.querySelector(`.tab-panel[data-tab="${tabName}"]`);
      if (activePanel) activePanel.classList.add("active");
    });
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let isConnected = false;
let configCache = null;
let walletClient = null;
let publicClient = null;
let currentChainId = null;
let currentAccount = null;
let currentExplorerBase = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatAddress(value) {
  if (!value) return "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getUiErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error.shortMessage === "string" && error.shortMessage.trim())
    return error.shortMessage.trim();
  if (typeof error.message === "string" && error.message.trim())
    return error.message.split("\n")[0].trim();
  return String(error);
}

function logDetailedError(context, error) {
  console.error(`[${context}]`, error);
  if (error?.message) console.error(`[${context}] full message:`, error.message);
}

function setDepositMessage(text, tone = "info") {
  if (!depositMessage) return;
  depositMessage.textContent = text;
  depositMessage.dataset.tone = tone;
}

function setWithdrawMessage(text, tone = "info") {
  if (!withdrawMessage) return;
  withdrawMessage.textContent = text;
  withdrawMessage.dataset.tone = tone;
}

function setProofStatus(text, show = true) {
  if (!proofStatus) return;
  proofStatus.textContent = text;
  proofStatus.hidden = !show;
}

// ---------------------------------------------------------------------------
// Wallet UI state
// ---------------------------------------------------------------------------
function setWalletUiState(connected) {
  if (tabsNav) tabsNav.hidden = !connected;
  tabPanels.forEach((panel) => { panel.hidden = !connected; });
  if (walletGate) walletGate.hidden = connected;
  if (!connected) contractLink.hidden = true;
}

function resetUi() {
  isConnected = false;
  connectButton.textContent = "Connect Wallet";
  walletStatus.textContent = "";
  setDepositMessage("Please connect your wallet first.");
  setWithdrawMessage("");
  currentExplorerBase = null;
  currentAccount = null;
  setWalletUiState(false);
}

// ---------------------------------------------------------------------------
// Config / network helpers
// ---------------------------------------------------------------------------
async function loadConfig() {
  const response = await fetch("config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load config.json");
  return response.json();
}

function getChainName(chainId) {
  const id = Number(chainId);
  return Object.values(chains).find((c) => c && c.id === id)?.name ?? null;
}

function getChainById(chainId) {
  const id = Number(chainId);
  return Object.values(chains).find((c) => c && c.id === id) ?? null;
}

function getExplorerBase(chainId) {
  const id = Number(chainId);
  const chain = Object.values(chains).find((c) => c && c.id === id);
  return chain?.blockExplorers?.default?.url ?? null;
}

function populateNetworkSelect(config) {
  networkSelect.innerHTML = "";
  const ids = Object.keys(config);
  if (!ids.length) {
    const option = document.createElement("option");
    option.textContent = "No networks configured";
    option.value = "";
    networkSelect.appendChild(option);
    networkSelect.disabled = true;
    return;
  }
  ids.forEach((id) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = getChainName(id) ?? `Chain ${id}`;
    networkSelect.appendChild(option);
  });
}

function updateContractLink(chainId, address) {
  if (!chainId || !address) {
    contractLink.hidden = true;
    contractLinkUrl.href = "#";
    contractLinkUrl.textContent = "";
    return;
  }
  const explorerBase = getExplorerBase(chainId);
  if (explorerBase) {
    contractLinkUrl.href = `${explorerBase}/address/${address}`;
    contractLinkUrl.textContent = address;
    contractLink.hidden = false;
  } else {
    contractLink.hidden = true;
  }
}

async function initNetworks() {
  try {
    configCache = await loadConfig();
    populateNetworkSelect(configCache);
    const [firstChainId] = Object.keys(configCache);
    if (firstChainId && configCache[firstChainId]?.address) {
      updateContractLink(Number(firstChainId), configCache[firstChainId].address);
    }
  } catch (error) {
    logDetailedError("initNetworks", error);
    setDepositMessage(`Error: ${getUiErrorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Viem clients
// ---------------------------------------------------------------------------
function ensureClients() {
  if (!window.ethereum) throw new Error("No wallet detected. Install MetaMask or another provider.");
  if (!walletClient) walletClient = createWalletClient({ transport: custom(window.ethereum) });
  if (!publicClient) publicClient = createPublicClient({ transport: custom(window.ethereum) });
}

// ---------------------------------------------------------------------------
// Gas estimation helper
// ---------------------------------------------------------------------------
async function estimateGasForContract({ address, abi, functionName, args = [], value }) {
  const chain = getChainById(currentChainId);
  return publicClient.estimateContractGas({
    account: currentAccount,
    address: getAddress(address),
    abi,
    functionName,
    args,
    value,
    chain: chain ?? undefined
  });
}

// ---------------------------------------------------------------------------
// Resolve deployment block from config
// ---------------------------------------------------------------------------
async function resolveDeploymentBlock(chainConfig) {
  if (chainConfig.hash) {
    const receipt = await publicClient.getTransactionReceipt({ hash: chainConfig.hash });
    return Number(receipt.blockNumber);
  }
  return Number(chainConfig.deploymentBlock ?? 0);
}

// ---------------------------------------------------------------------------
// Fetch on-chain commitments (to build the Merkle tree for proof generation)
// ---------------------------------------------------------------------------
async function fetchCommitments(contractAddress, fromBlock) {
  const logs = await publicClient.getLogs({
    address: getAddress(contractAddress),
    event: ABI_COMMITMENT_EVENT,
    fromBlock: BigInt(fromBlock),
    toBlock: "latest"
  });
  // Each log.args.commitment is a bytes-encoded uint256 commitment
  return logs.map((log) => BigInt(log.args.commitment));
}

// ---------------------------------------------------------------------------
// Connect / disconnect wallet
// ---------------------------------------------------------------------------
async function connectWallet() {
  if (isConnected) {
    resetUi();
    return;
  }

  try {
    connectButton.disabled = true;
    setDepositMessage("Connecting to wallet...");

    ensureClients();
    const accounts = await walletClient.requestAddresses();
    const address = accounts[0];
    if (!address) {
      setDepositMessage("No account selected.");
      return;
    }
    currentAccount = address;
    walletStatus.textContent = `Connected: ${formatAddress(address)}`;

    const chainId = await walletClient.getChainId();
    currentChainId = chainId;
    currentExplorerBase = getExplorerBase(chainId);

    if (!configCache) {
      configCache = await loadConfig();
      populateNetworkSelect(configCache);
    }
    networkSelect.value = String(chainId);

    const chainConfig = configCache[String(chainId)];
    if (!chainConfig || !chainConfig.address) {
      setDepositMessage("Mixer contract not deployed on this chain.");
      contractLink.hidden = true;
      isConnected = true;
      connectButton.textContent = "Disconnect Wallet";
      setWalletUiState(true);
      return;
    }

    updateContractLink(chainId, chainConfig.address);
    setDepositMessage("Ready. Generate secrets to deposit 0.1 ETH into the mixer.");
    isConnected = true;
    connectButton.textContent = "Disconnect Wallet";
    setWalletUiState(true);
  } catch (error) {
    logDetailedError("connectWallet", error);
    setDepositMessage(`Error: ${getUiErrorMessage(error)}`);
  } finally {
    connectButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Generate secrets for deposit
// ---------------------------------------------------------------------------
generateSecretsBtn?.addEventListener("click", () => {
  const secret = randomBigInt32ModP();
  const nullifier = randomBigInt32ModP();
  const commitment = poseidon2([secret, nullifier]);

  depositSecret.value = secret.toString();
  depositNullifier.value = nullifier.toString();
  depositCommitment.value = commitment.toString();

  // hide previous note
  secretNoteSection.hidden = true;
  secretNoteText.value = "";
  setDepositMessage("Secrets generated. Review and click Deposit to send 0.1 ETH.");
});

// ---------------------------------------------------------------------------
// Deposit form submission
// ---------------------------------------------------------------------------
depositForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isConnected || !configCache || !currentChainId || !currentAccount) {
    setDepositMessage("Connect your wallet first.");
    return;
  }

  const chainConfig = configCache[String(currentChainId)];
  if (!chainConfig || !chainConfig.address) {
    setDepositMessage("Mixer contract not deployed on this chain.");
    return;
  }

  const secretVal = depositSecret.value.trim();
  const nullifierVal = depositNullifier.value.trim();
  const commitmentVal = depositCommitment.value.trim();

  if (!secretVal || !nullifierVal || !commitmentVal) {
    setDepositMessage("Please generate secrets first.");
    return;
  }

  try {
    setDepositMessage("Submitting deposit transaction (0.1 ETH)...");

    const commitment = BigInt(commitmentVal);
    const chain = getChainById(currentChainId);

    const hash = await walletClient.writeContract({
      account: currentAccount,
      address: getAddress(chainConfig.address),
      abi: ABI_DEPOSIT,
      functionName: "deposit",
      args: [commitment],
      value: DEPOSIT_VALUE,
      chain: chain ?? undefined,
      gas: await estimateGasForContract({
        address: chainConfig.address,
        abi: ABI_DEPOSIT,
        functionName: "deposit",
        args: [commitment],
        value: DEPOSIT_VALUE
      })
    });

    setDepositMessage("Transaction sent. Waiting for confirmation...");
    await publicClient.waitForTransactionReceipt({ hash });

    // Build and show the secret note
    const note = {
      secret: secretVal,
      nullifier: nullifierVal,
      commitment: commitmentVal
    };
    const noteJson = JSON.stringify(note, null, 2);
    secretNoteText.value = noteJson;
    secretNoteSection.hidden = false;

    const explorer = currentExplorerBase;
    const shortHash = `${hash.slice(0, 6)}...${hash.slice(-4)}`;
    const linkHtml = explorer
      ? `<a href="${explorer}/tx/${hash}" target="_blank" rel="noreferrer">${shortHash}</a>`
      : shortHash;
    txBody.innerHTML = `Deposit of 0.1 ETH confirmed!<br/>Tx: ${linkHtml}<br/><br/><strong>Save your secret note below before closing this page.</strong>`;
    txModal.hidden = false;

    setDepositMessage("Deposit confirmed! Save your secret note securely.");

    // Clear the form inputs after successful deposit
    depositSecret.value = "";
    depositNullifier.value = "";
    depositCommitment.value = "";
  } catch (error) {
    logDetailedError("deposit", error);
    setDepositMessage(`Error: ${getUiErrorMessage(error)}`);
  }
});

// ---------------------------------------------------------------------------
// Copy / download note helpers
// ---------------------------------------------------------------------------
copyNoteBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(secretNoteText.value);
    copyNoteBtn.textContent = "Copied!";
    setTimeout(() => { copyNoteBtn.textContent = "Copy to Clipboard"; }, 2000);
  } catch (_) {
    // fallback
    secretNoteText.select();
    document.execCommand("copy");
    copyNoteBtn.textContent = "Copied!";
    setTimeout(() => { copyNoteBtn.textContent = "Copy to Clipboard"; }, 2000);
  }
});

downloadNoteBtn?.addEventListener("click", () => {
  const blob = new Blob([secretNoteText.value], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mixer-note-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Parse note for withdraw
// ---------------------------------------------------------------------------
parseNoteBtn?.addEventListener("click", () => {
  try {
    const raw = withdrawNoteInput.value.trim();
    if (!raw) {
      setWithdrawMessage("Please paste a secret note first.");
      return;
    }
    const note = JSON.parse(raw);
    if (!note.secret || !note.nullifier) {
      setWithdrawMessage("Invalid note: missing secret or nullifier.");
      return;
    }
    withdrawSecret.value = note.secret;
    withdrawNullifier.value = note.nullifier;
    setWithdrawMessage("Note parsed successfully. Enter recipient address and submit.");
  } catch (e) {
    setWithdrawMessage(`Failed to parse note: ${e.message}`);
  }
});

// ---------------------------------------------------------------------------
// Withdraw form – generate ZK proof and call contract
// ---------------------------------------------------------------------------
withdrawForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isConnected || !configCache || !currentChainId || !currentAccount) {
    setWithdrawMessage("Connect your wallet first.");
    return;
  }

  const chainConfig = configCache[String(currentChainId)];
  if (!chainConfig || !chainConfig.address) {
    setWithdrawMessage("Mixer contract not deployed on this chain.");
    return;
  }

  const secretVal = withdrawSecret.value.trim();
  const nullifierVal = withdrawNullifier.value.trim();
  const recipientVal = withdrawRecipient.value.trim();

  if (!secretVal || !nullifierVal) {
    setWithdrawMessage("Please provide secret and nullifier (paste a note or enter manually).");
    return;
  }
  if (!recipientVal || !/^0x[0-9a-fA-F]{40}$/.test(recipientVal)) {
    setWithdrawMessage("Please enter a valid recipient Ethereum address.");
    return;
  }

  try {
    const secret = BigInt(secretVal);
    const nullifier = BigInt(nullifierVal);
    const recipient = getAddress(recipientVal);

    // Step 1: Fetch all on-chain commitments to build the Merkle tree
    setWithdrawMessage("Fetching on-chain commitments...");
    setProofStatus("Loading commitments from blockchain...", true);

    const deploymentBlock = await resolveDeploymentBlock(chainConfig);
    const commitments = await fetchCommitments(chainConfig.address, deploymentBlock);

    if (!commitments.length) {
      setWithdrawMessage("No commitments found on-chain. Has anyone deposited?");
      setProofStatus("", false);
      return;
    }

    // Verify our commitment exists in the list
    const ourCommitment = poseidon2([secret, nullifier]);
    const commitmentIndex = commitments.findIndex((c) => c === ourCommitment);
    if (commitmentIndex === -1) {
      setWithdrawMessage("Your commitment was not found on-chain. Check your secret and nullifier.");
      setProofStatus("", false);
      return;
    }

    // Step 2: Generate a random nonce (for context binding)
    setWithdrawMessage("Generating ZK proof... this may take a moment.");
    setProofStatus("Building Merkle tree and generating Groth16 proof...", true);

    const nonce = randomBigInt32ModP();

    // Step 3: Generate the proof using snarkjs + local Merkle tree (browser-compatible)
    const { proof, publicSignals } = await generateZkProof(secret, nullifier, nonce, commitments);

    // Step 3.5: Verify the proof locally (optional sanity check)
    setProofStatus("Verifying proof locally...", true);
    const verified = await verifyZkProofLocally(proof, publicSignals);
    if (!verified) {
      setWithdrawMessage("Local proof verification failed. Please try again.");
      setProofStatus("", false);
      return;
    }

    setProofStatus("Proof generated and verified locally. Submitting transaction...", true);
    setWithdrawMessage("Submitting withdraw transaction...");

    // Step 4: Encode the proof for the Solidity verifier and submit
    const proofBytes = encodeProofForContract(proof, publicSignals);
    const chain = getChainById(currentChainId);

    const hash = await walletClient.writeContract({
      account: currentAccount,
      address: getAddress(chainConfig.address),
      abi: ABI_WITHDRAW,
      functionName: "withdraw",
      args: [proofBytes, recipient, nonce],
      chain: chain ?? undefined,
      gas: await estimateGasForContract({
        address: chainConfig.address,
        abi: ABI_WITHDRAW,
        functionName: "withdraw",
        args: [proofBytes, recipient, nonce]
      })
    });

    setWithdrawMessage("Transaction sent. Waiting for confirmation...");
    await publicClient.waitForTransactionReceipt({ hash });

    const explorer = currentExplorerBase;
    const shortHash = `${hash.slice(0, 6)}...${hash.slice(-4)}`;
    const linkHtml = explorer
      ? `<a href="${explorer}/tx/${hash}" target="_blank" rel="noreferrer">${shortHash}</a>`
      : shortHash;
    txBody.innerHTML = `Withdrawal of 0.1 ETH confirmed!<br/>Tx: ${linkHtml}<br/>Recipient: ${formatAddress(recipient)}`;
    txModal.hidden = false;

    setWithdrawMessage("Withdrawal confirmed! 0.1 ETH sent to the recipient.");
    setProofStatus("", false);

    // Clear form
    withdrawForm.reset();
  } catch (error) {
    logDetailedError("withdraw", error);
    setWithdrawMessage(`Error: ${getUiErrorMessage(error)}`);
    setProofStatus("", false);
  }
});

// ---------------------------------------------------------------------------
// Network switch
// ---------------------------------------------------------------------------
networkSelect.addEventListener("change", async (event) => {
  if (!window.ethereum) {
    setDepositMessage("No wallet detected. Install MetaMask or another provider.", "warn");
    return;
  }
  const chainId = event.target.value;
  if (!chainId) return;
  try {
    await walletClient.switchChain({ id: Number(chainId) });
  } catch (error) {
    if (error && error.code === 4902) {
      setDepositMessage("This network is not available in your wallet.");
      return;
    }
    logDetailedError("switchChain", error);
    setDepositMessage(`Error: ${getUiErrorMessage(error)}`);
  }
});

// ---------------------------------------------------------------------------
// Modal close
// ---------------------------------------------------------------------------
closeModal.addEventListener("click", () => {
  txModal.hidden = true;
});

// ---------------------------------------------------------------------------
// Wallet connection button
// ---------------------------------------------------------------------------
connectButton.addEventListener("click", connectWallet);

// ---------------------------------------------------------------------------
// MetaMask event listeners
// ---------------------------------------------------------------------------
if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts) => {
    if (!accounts || accounts.length === 0) {
      resetUi();
    } else if (isConnected) {
      resetUi();
      connectWallet();
    }
  });

  window.ethereum.on("chainChanged", () => {
    if (isConnected) {
      resetUi();
      connectWallet();
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
txModal.hidden = true;
initializeTabs();
initNetworks();
resetUi();
