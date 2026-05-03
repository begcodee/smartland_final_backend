import { ethers } from "ethers";

const ABI = [
  "function recordSale(bytes32 saleId, bytes32 parcelKey, bytes32 paystackRefHash) external",
];

function chainConfig() {
  const rpc = process.env.CHAIN_RPC_URL?.trim();
  const key = process.env.CHAIN_REGISTRAR_PRIVATE_KEY?.trim();
  const contract = process.env.LAND_SALE_ANCHOR_CONTRACT_ADDRESS?.trim();
  if (!rpc || !key || !contract) return null;
  return { rpc, key, contract };
}

/**
 * After Paystack succeeds, anchor the same sale on-chain using the registrar wallet.
 * Buyers use fiat only; they never sign this transaction.
 */
export async function anchorSaleOnChain({ transfer, parcelId, paystackReference }) {
  const env = chainConfig();
  if (!env) return { skipped: true, reason: "missing_chain_env" };

  if (transfer?.chainTxHash) return { skipped: true, reason: "already_anchored" };

  const saleId = ethers.keccak256(ethers.toUtf8Bytes(String(transfer.id)));
  const parcelKey = ethers.keccak256(ethers.toUtf8Bytes(String(parcelId)));
  const paystackRefHash = ethers.keccak256(ethers.toUtf8Bytes(String(paystackReference)));

  const provider = new ethers.JsonRpcProvider(env.rpc);
  const wallet = new ethers.Wallet(env.key, provider);
  const contract = new ethers.Contract(env.contract, ABI, wallet);

  const tx = await contract.recordSale(saleId, parcelKey, paystackRefHash);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Chain transaction produced no receipt");

  return {
    skipped: false,
    chainTxHash: receipt.hash,
    chainNetwork: process.env.CHAIN_NETWORK_NAME || "unknown",
    chainSaleId: saleId,
    chainAnchoredAt: new Date().toISOString(),
  };
}

