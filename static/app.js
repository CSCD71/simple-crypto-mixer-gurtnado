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
import { poseidon2, poseidon5 } from "https://esm.sh/poseidon-lite@0.3.0";
import { IncrementalMerkleTree } from "https://esm.sh/@zk-kit/incremental-merkle-tree@1.1.0";

// ---------------------------------------------------------------------------
// ZK Utility functions (browser-compatible reimplementations of utils/utils.js)
// ---------------------------------------------------------------------------
const TREE_DEPTH = 20;
const p = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

const wasmPath = "zk-data/ProofOfMembership_js/ProofOfMembership.wasm";
const zkeyPath = "zk-data/ProofOfMembership.zkey";

let vKeyCache = null;
async function loadVKey() {
  if (vKeyCache) return vKeyCache;
  const response = await fetch("zk-data/ProofOfMembership.vkey", { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to load verification key");
  vKeyCache = await response.json();
  return vKeyCache;
}

function randomBigInt32ModP() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return BigInt('0x' + hex) % p;
}

function generateMerkleProof(secret, nullifier, commitments) {
  const tree = new IncrementalMerkleTree(poseidon2, TREE_DEPTH, BigInt(0), 2, commitments);
  const commitment = poseidon2([secret, nullifier]);
  const imtProof = tree.createProof(tree.indexOf(commitment));
  return { imtProof };
}

async function generateZkProof(contractAddress, to, nonce, secret, nullifier, commitments, chainId) {
  const { imtProof } = generateMerkleProof(secret, nullifier, commitments);
  const zkNonce = poseidon5([BigInt(chainId), BigInt(contractAddress), BigInt(to), parseEther("0.1"), nonce]);
  const inputs = {
    secret: secret,
    siblings: imtProof.siblings,
    pathIndices: imtProof.pathIndices,
    nullifier: nullifier,
    nonce: zkNonce,
  };
  const { proof, publicSignals } = await window.snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  return { proof, publicSignals };
}

async function verifyZkProof(proof, publicSignals) {
  const vKey = await loadVKey();
  return window.snarkjs.groth16.verify(vKey, publicSignals, proof);
}

async function packProofArgs(proof, publicSignals) {
  const proofCalldata = await window.snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const proofCalldataFormatted = JSON.parse("[" + proofCalldata + "]");
  return encodeAbiParameters(
    [
      { type: 'uint256[2]' },
      { type: 'uint256[2][2]' },
      { type: 'uint256[2]' },
      { type: 'uint256[4]' },
    ],
    proofCalldataFormatted
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
  "event CommitmentDeposited(uint256 commitment)"
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

const ANIMATION_INTERVAL_MS = 450;

function createDotsAnimator(updateFn) {
  let timerId = null;
  let dots = 1;

  return {
    start(baseText) {
      this.stop();
      dots = 1;
      updateFn(`${baseText}${".".repeat(dots)}`);
      timerId = setInterval(() => {
        dots = dots % 3 + 1;
        updateFn(`${baseText}${".".repeat(dots)}`);
      }, ANIMATION_INTERVAL_MS);
    },
    stop() {
      if (!timerId) return;
      clearInterval(timerId);
      timerId = null;
    }
  };
}

const depositMessageAnimator = createDotsAnimator((text) => setDepositMessage(text));
const withdrawMessageAnimator = createDotsAnimator((text) => setWithdrawMessage(text));
const proofStatusAnimator = createDotsAnimator((text) => setProofStatus(text, true));

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

function copyTextToClipboard(text, buttonElement, defaultLabel = "Copy to Clipboard", copiedLabel = "Copied!") {
  const onCopied = () => {
    if (!buttonElement) return;
    buttonElement.textContent = copiedLabel;
    setTimeout(() => { buttonElement.textContent = defaultLabel; }, 2000);
  };

  return navigator.clipboard.writeText(text)
    .then(onCopied)
    .catch(() => {
      const fallback = document.createElement("textarea");
      fallback.value = text;
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.focus();
      fallback.select();
      document.execCommand("copy");
      document.body.removeChild(fallback);
      onCopied();
    });
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
// Deposit helpers
// ---------------------------------------------------------------------------
function recomputeDepositCommitment() {
  const secretVal = depositSecret?.value?.trim();
  const nullifierVal = depositNullifier?.value?.trim();
  if (!secretVal || !nullifierVal) {
    if (depositCommitment) depositCommitment.value = "";
    return;
  }

  try {
    const commitment = poseidon2([BigInt(secretVal), BigInt(nullifierVal)]);
    if (depositCommitment) depositCommitment.value = commitment.toString();
  } catch {
    if (depositCommitment) depositCommitment.value = "";
  }
}

function insertInlineGenerateButton(targetInput, onGenerate) {
  if (!targetInput || targetInput.dataset.hasGenerateBtn === "true") return;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Generate";
  button.className = "btn ghost inline-generate-btn";
  button.addEventListener("click", onGenerate);
  targetInput.insertAdjacentElement("afterend", button);
  targetInput.dataset.hasGenerateBtn = "true";
}

function initializeDepositGenerators() {
  insertInlineGenerateButton(depositSecret, () => {
    depositSecret.value = randomBigInt32ModP().toString();
    recomputeDepositCommitment();
    setDepositMessage("Secret generated. Generate nullifier as well to produce commitment.");
  });

  insertInlineGenerateButton(depositNullifier, () => {
    depositNullifier.value = randomBigInt32ModP().toString();
    recomputeDepositCommitment();
    setDepositMessage("Nullifier generated. Commitment updated.");
  });

  depositSecret?.addEventListener("input", recomputeDepositCommitment);
  depositNullifier?.addEventListener("input", recomputeDepositCommitment);
}

function openDepositConfirmedModal(hash, noteJson) {
  const explorer = currentExplorerBase;
  const shortHash = `${hash.slice(0, 6)}...${hash.slice(-4)}`;
  const txLink = explorer
    ? `<a href="${explorer}/tx/${hash}" target="_blank" rel="noreferrer">${shortHash}</a>`
    : shortHash;

  txBody.innerHTML = `
    <p>Deposit of 0.1 ETH confirmed!</p>
    <p>Tx: ${txLink}</p>
    <p><strong>Save your secret note before closing this modal.</strong></p>
    <textarea id="modalSecretNoteText" rows="8" class="secret-note-textarea" readonly></textarea>
    <div class="modal-note-actions">
      <button id="modalCopyNoteBtn" type="button" class="btn ghost modal-note-btn">Copy to Clipboard</button>
      <button id="modalDownloadNoteBtn" type="button" class="btn ghost modal-note-btn">Download Note</button>
    </div>
  `;

  const modalSecretNoteText = document.getElementById("modalSecretNoteText");
  const modalCopyNoteBtn = document.getElementById("modalCopyNoteBtn");
  const modalDownloadNoteBtn = document.getElementById("modalDownloadNoteBtn");

  if (modalSecretNoteText) modalSecretNoteText.value = noteJson;

  modalCopyNoteBtn?.addEventListener("click", () => {
    copyTextToClipboard(noteJson, modalCopyNoteBtn);
  });

  modalDownloadNoteBtn?.addEventListener("click", () => {
    const blob = new Blob([noteJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `GurtNado-Mixer-note-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  });

  txModal.hidden = false;
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
  // Each log.args.commitment is a uint256 commitment
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
      setDepositMessage("GurtNado Mixer contract not deployed on this chain.");
      contractLink.hidden = true;
      isConnected = true;
      connectButton.textContent = "Disconnect Wallet";
      setWalletUiState(true);
      return;
    }

    updateContractLink(chainId, chainConfig.address);
    setDepositMessage("Ready. Generate secrets to deposit 0.1 ETH into the GurtNado mixer.");
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
// Deposit form submission
// ---------------------------------------------------------------------------
depositForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  depositMessageAnimator.stop();

  if (!isConnected || !configCache || !currentChainId || !currentAccount) {
    setDepositMessage("Connect your wallet first.");
    return;
  }

  const chainConfig = configCache[String(currentChainId)];
  if (!chainConfig || !chainConfig.address) {
    setDepositMessage("GurtNado Mixer contract not deployed on this chain.");
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

    depositMessageAnimator.start("Transaction sent. Waiting for confirmation");
    await publicClient.waitForTransactionReceipt({ hash });
    depositMessageAnimator.stop();

    // Build and show the secret note inside the confirmation modal
    const note = {
      secret: secretVal,
      nullifier: nullifierVal,
      commitment: commitmentVal
    };
    const noteJson = JSON.stringify(note, null, 2);
    openDepositConfirmedModal(hash, noteJson);

    setDepositMessage("Deposit confirmed! Save your secret note securely.");

    // Clear the form inputs after successful deposit
    depositSecret.value = "";
    depositNullifier.value = "";
    depositCommitment.value = "";
  } catch (error) {
    depositMessageAnimator.stop();
    logDetailedError("deposit", error);
    setDepositMessage(`Error: ${getUiErrorMessage(error)}`);
  } finally {
    depositMessageAnimator.stop();
  }
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
  withdrawMessageAnimator.stop();
  proofStatusAnimator.stop();

  if (!isConnected || !configCache || !currentChainId || !currentAccount) {
    setWithdrawMessage("Connect your wallet first.");
    return;
  }

  const chainConfig = configCache[String(currentChainId)];
  if (!chainConfig || !chainConfig.address) {
    setWithdrawMessage("GurtNado Mixer contract not deployed on this chain.");
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
    withdrawMessageAnimator.start("Fetching on-chain commitments");
    proofStatusAnimator.start("Loading commitments from blockchain");

    const deploymentBlock = await resolveDeploymentBlock(chainConfig);
    const commitments = await fetchCommitments(chainConfig.address, deploymentBlock);
    withdrawMessageAnimator.stop();

    if (!commitments.length) {
      setWithdrawMessage("No commitments found on-chain. Has anyone deposited?");
      proofStatusAnimator.stop();
      setProofStatus("", false);
      return;
    }

    // Verify our commitment exists in the list
    const ourCommitment = poseidon2([secret, nullifier]);
    const commitmentIndex = commitments.findIndex((c) => c === ourCommitment);
    if (commitmentIndex === -1) {
      setWithdrawMessage("Your commitment was not found on-chain. Check your secret and nullifier.");
      proofStatusAnimator.stop();
      setProofStatus("", false);
      return;
    }

    // Step 2: Generate a random nonce (for context binding)
    withdrawMessageAnimator.start("Generating ZK proof, this may take a moment");
    proofStatusAnimator.start("Building Merkle tree and generating Groth16 proof");

    const nonce = randomBigInt32ModP();

    // Step 3: Generate the proof using snarkjs + local Merkle tree (browser-compatible)
    const { proof, publicSignals } = await generateZkProof(
      chainConfig.address,
      recipient,
      nonce,
      secret,
      nullifier,
      commitments,
      currentChainId
    );
    withdrawMessageAnimator.stop();

    // Step 3.5: Verify the proof locally (optional sanity check)
    proofStatusAnimator.start("Verifying proof locally");
    const verified = await verifyZkProof(proof, publicSignals);
    proofStatusAnimator.stop();
    if (!verified) {
      setWithdrawMessage("Local proof verification failed. Please try again.");
      setProofStatus("", false);
      return;
    }

    proofStatusAnimator.start("Proof generated and verified locally. Submitting transaction");
    withdrawMessageAnimator.start("Submitting withdraw transaction");

    // Step 4: Encode the proof for the Solidity verifier and submit
    const proofBytes = await packProofArgs(proof, publicSignals);
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
    proofStatusAnimator.stop();

    withdrawMessageAnimator.start("Transaction sent. Waiting for confirmation");
    await publicClient.waitForTransactionReceipt({ hash });
    withdrawMessageAnimator.stop();

    const explorer = currentExplorerBase;
    const shortHash = `${hash.slice(0, 6)}...${hash.slice(-4)}`;
    const linkHtml = explorer
      ? `<a href="${explorer}/tx/${hash}" target="_blank" rel="noreferrer">${shortHash}</a>`
      : shortHash;
    txBody.innerHTML = `Withdrawal of 0.1 ETH confirmed!<br/>Tx: ${linkHtml}<br/>Recipient: ${formatAddress(recipient)}`;
    txModal.hidden = false;

    setWithdrawMessage("Withdrawal confirmed! 0.1 ETH sent to the recipient.");
    proofStatusAnimator.stop();
    setProofStatus("", false);

    // Clear form
    withdrawForm.reset();
  } catch (error) {
    withdrawMessageAnimator.stop();
    proofStatusAnimator.stop();
    logDetailedError("withdraw", error);
    setWithdrawMessage(`Error: ${getUiErrorMessage(error)}`);
    setProofStatus("", false);
  } finally {
    withdrawMessageAnimator.stop();
    proofStatusAnimator.stop();
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
initializeDepositGenerators();
initNetworks();
resetUi();
