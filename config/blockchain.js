import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { LAND_CONTRACT_ABI } from "./landContractAbi.js";

function trimEnv(k) {
  const v = process.env[k];
  return v != null && String(v).trim() ? String(v).trim() : "";
}

function resolveRpcUrl() {
  return (
    trimEnv("RPC_URL") ||
    trimEnv("POLYGON_RPC_URL") ||
    trimEnv("AMOY_RPC_URL") ||
    trimEnv("CHAIN_RPC_URL")
  );
}

function resolvePrivateKey() {
  return trimEnv("PRIVATE_KEY") || trimEnv("GOV_PRIVATE_KEY");
}

function resolveContractAddress() {
  return trimEnv("CONTRACT_ADDRESS") || trimEnv("LAND_CONTRACT_ADDRESS");
}

function normalizePrivateKey(pk) {
  const s = String(pk || "").trim();
  if (!s) return "";
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return `0x${s}`;
  return s;
}

function loadAbi() {
  const abiPath = trimEnv("CONTRACT_ABI_PATH");
  if (abiPath) {
    const resolved = path.isAbsolute(abiPath) ? abiPath : path.resolve(process.cwd(), abiPath);
    const rawFile = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(rawFile);
    const abi = Array.isArray(parsed) ? parsed : parsed?.abi;
    if (!Array.isArray(abi)) throw new Error("CONTRACT_ABI_PATH must be an ABI array or artifact with .abi");
    return abi;
  }
  const raw = process.env.CONTRACT_ABI_JSON;
  if (!raw || !String(raw).trim()) return LAND_CONTRACT_ABI;
  try {
    const abi = JSON.parse(String(raw));
    if (!Array.isArray(abi)) throw new Error("ABI must be a JSON array");
    return abi;
  } catch (e) {
    throw new Error(`[blockchain] CONTRACT_ABI_JSON invalid: ${e?.message || e}`);
  }
}

export function getBlockchain() {
  const rpc = resolveRpcUrl();
  const pkRaw = resolvePrivateKey();
  const addr = resolveContractAddress();
  const pk = normalizePrivateKey(pkRaw);

  if (!rpc) throw new Error("[blockchain] Missing RPC URL (set RPC_URL or POLYGON_RPC_URL or AMOY_RPC_URL)");
  if (!pk) throw new Error("[blockchain] Missing private key (set PRIVATE_KEY or GOV_PRIVATE_KEY)");
  if (!addr) throw new Error("[blockchain] Missing contract address (set CONTRACT_ADDRESS or LAND_CONTRACT_ADDRESS)");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);
  const abi = loadAbi();
  const contract = new ethers.Contract(addr, abi, wallet);
  return { provider, wallet, contract };
}

const RPC_URL = resolveRpcUrl();
const PRIVATE_KEY = normalizePrivateKey(resolvePrivateKey());
const CONTRACT_ADDRESS = resolveContractAddress();

export const provider = RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null;
export const wallet = RPC_URL && PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
let _cachedAbi = null;
function safeAbi() {
  try {
    _cachedAbi = _cachedAbi || loadAbi();
    return _cachedAbi;
  } catch {
    return null;
  }
}
export const contract =
  RPC_URL && PRIVATE_KEY && CONTRACT_ADDRESS && safeAbi()
    ? new ethers.Contract(CONTRACT_ADDRESS, safeAbi(), wallet)
    : null;
