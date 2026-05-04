import { ethers } from "ethers";

const REGISTRY_ABI = [
  "function registerParcel(bytes32 parcelId,address owner,bytes32 metadataHash) external",
  "function executeTransfer((bytes32 transferId,bytes32 parcelId,address from,address to,uint256 nonce,uint256 deadline,bytes32 metadataHash) t, bytes[] signatures) external",
  "function ownerOf(bytes32 parcelId) view returns (address)",
  "function parcelNonce(bytes32 parcelId) view returns (uint256)",
];

function chainEnv() {
  const rpc = process.env.CHAIN_RPC_URL?.trim();
  const registrarKey = process.env.CHAIN_REGISTRAR_PRIVATE_KEY?.trim();
  const registry = process.env.CHAIN_REGISTRY_CONTRACT_ADDRESS?.trim();
  if (!rpc || !registrarKey || !registry) return null;
  return { rpc, registrarKey, registry };
}

function parseAddr(a) {
  try {
    const v = String(a || "").trim();
    return ethers.getAddress(v);
  } catch {
    return null;
  }
}

export function parcelIdToBytes32(parcelId) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(parcelId)));
}

export function transferIdToBytes32(transferId) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(transferId)));
}

export function metadataToBytes32(metadata) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(metadata || "")));
}

export async function getRegistryContract() {
  const env = chainEnv();
  if (!env) return null;
  const provider = new ethers.JsonRpcProvider(env.rpc);
  const wallet = new ethers.Wallet(env.registrarKey, provider);
  const contract = new ethers.Contract(env.registry, REGISTRY_ABI, wallet);
  return { contract, provider, wallet };
}

export async function maybeRegisterParcelOnChain({ parcel, ownerAddress, metadataHash }) {
  const ctx = await getRegistryContract();
  if (!ctx) return { skipped: true, reason: "missing_chain_env" };

  const owner = parseAddr(ownerAddress);
  if (!owner) return { skipped: true, reason: "missing_owner_address" };

  const pid = parcelIdToBytes32(parcel.id);
  const mh = metadataHash ? parseBytes32(metadataHash) : metadataToBytes32(JSON.stringify(parcel));

  try {
    // If already registered, just skip
    await ctx.contract.ownerOf(pid);
    return { skipped: true, reason: "already_registered" };
  } catch {
    // continue to register
  }

  const tx = await ctx.contract.registerParcel(pid, owner, mh);
  const receipt = await tx.wait();
  return { skipped: false, txHash: receipt?.hash || tx.hash, parcelIdBytes32: pid, metadataHash: mh };
}

function parseBytes32(x) {
  const v = String(x || "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v;
  return null;
}

export async function buildTransferTypedData({ chainId, verifyingContract, transfer }) {
  return {
    domain: {
      name: "SmartLandRegistry",
      version: "2",
      chainId: Number(chainId),
      verifyingContract,
    },
    types: {
      Transfer: [
        { name: "transferId", type: "bytes32" },
        { name: "parcelId", type: "bytes32" },
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "metadataHash", type: "bytes32" },
      ],
    },
    primaryType: "Transfer",
    message: transfer,
  };
}

export async function signTransferApproval({ role, privateKey, typedData }) {
  const wallet = new ethers.Wallet(String(privateKey).trim());
  const sig = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  return { role, signer: wallet.address, signature: sig };
}

export async function executeTransferOnChain({ transfer, parcel, approvals, buyerAddress, sellerAddress, deadlineSeconds = 15 * 60 }) {
  const ctx = await getRegistryContract();
  if (!ctx) return { skipped: true, reason: "missing_chain_env" };

  const from = parseAddr(sellerAddress);
  const to = parseAddr(buyerAddress);
  if (!from || !to) return { skipped: true, reason: "missing_party_address" };

  const parcelId = parcelIdToBytes32(parcel.id);
  const transferId = transferIdToBytes32(transfer.id);
  const nonce = await ctx.contract.parcelNonce(parcelId);
  const deadline = Math.floor(Date.now() / 1000) + Number(deadlineSeconds);
  const metadataHash = metadataToBytes32(JSON.stringify({ parcelId: parcel.id, transferId: transfer.id, paystack: transfer.paystackReference }));

  const network = await ctx.provider.getNetwork();
  const typed = await buildTransferTypedData({
    chainId: Number(network.chainId),
    verifyingContract: await ctx.contract.getAddress(),
    transfer: {
      transferId,
      parcelId,
      from,
      to,
      nonce: BigInt(nonce),
      deadline,
      metadataHash,
    },
  });

  const signatures = [];
  const metaSigs = [];
  for (const a of approvals || []) {
    if (a?.signature) {
      signatures.push(a.signature);
      metaSigs.push({ role: a.role, signer: a.signer, source: "stored" });
    }
  }

  if (!signatures.length) return { skipped: true, reason: "missing_signatures" };

  const tx = await ctx.contract.executeTransfer(typed.message, signatures);
  const receipt = await tx.wait();

  return {
    skipped: false,
    chainTxHash: receipt?.hash || tx.hash,
    chainNetwork: process.env.CHAIN_NETWORK_NAME || String(network.chainId),
    chainTransferId: transferId,
    chainParcelId: parcelId,
    chainNonce: nonce?.toString?.() ?? String(nonce),
    chainMetadataHash: metadataHash,
    signatures: metaSigs,
  };
}

