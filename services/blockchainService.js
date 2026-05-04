import { ethers } from "ethers";
import { getBlockchain } from "../config/blockchain.js";

function cleanEthersError(err) {
  const msg =
    err?.shortMessage ||
    err?.reason ||
    err?.info?.error?.message ||
    err?.message ||
    "Blockchain call failed";
  const code = err?.code || err?.info?.error?.code || null;
  return { message: String(msg), code };
}

async function sendTx(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  const hash = receipt?.hash || tx?.hash;
  if (!hash) throw new Error("Transaction sent but hash missing");
  return hash;
}

function toLandIdUint256(landId) {
  const s = String(landId).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`landId must be a non-negative integer for this contract (got: ${typeof landId})`);
  }
  return BigInt(s);
}

/**
 * registerLand(landId, documentHash) — contract: registerLand(uint256,string)
 */
export async function registerLand(landId, documentHash) {
  const id = toLandIdUint256(landId);
  const doc = String(documentHash ?? "").trim();
  if (!doc) throw new Error("documentHash is required");
  try {
    const { contract } = getBlockchain();
    return await sendTx(contract.registerLand(id, doc));
  } catch (err) {
    const e = cleanEthersError(err);
    console.error("[chain] registerLand failed:", e.message);
    throw Object.assign(new Error(e.message), { code: e.code });
  }
}

/**
 * transferLand(landId, newOwnerAddress) — contract: transferLand(uint256,address)
 */
export async function transferLand(landId, newOwnerAddress) {
  const id = toLandIdUint256(landId);
  const owner = ethers.getAddress(String(newOwnerAddress).trim());
  try {
    const { contract } = getBlockchain();
    return await sendTx(contract.transferLand(id, owner));
  } catch (err) {
    const e = cleanEthersError(err);
    console.error("[chain] transferLand failed:", e.message);
    throw Object.assign(new Error(e.message), { code: e.code });
  }
}

/** getLand(landId) — contract view returns (uint256, address, string) */
export async function getLand(landId) {
  const id = toLandIdUint256(landId);
  try {
    const { contract } = getBlockchain();
    return await contract.getLand(id);
  } catch (err) {
    const e = cleanEthersError(err);
    console.error("[chain] getLand failed:", e.message);
    throw Object.assign(new Error(e.message), { code: e.code });
  }
}
