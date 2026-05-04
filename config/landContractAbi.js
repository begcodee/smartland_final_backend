/** Minimal ABI for deployed Polygon Amoy land contract (matches frontend / Hardhat artifact). */
export const LAND_CONTRACT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "landId", type: "uint256" },
      { indexed: false, internalType: "address", name: "owner", type: "address" },
    ],
    name: "LandRegistered",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "landId", type: "uint256" },
      { indexed: false, internalType: "address", name: "oldOwner", type: "address" },
      { indexed: false, internalType: "address", name: "newOwner", type: "address" },
    ],
    name: "LandTransferred",
    type: "event",
  },
  {
    inputs: [{ internalType: "uint256", name: "_landId", type: "uint256" }],
    name: "getLand",
    outputs: [
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "address", name: "", type: "address" },
      { internalType: "string", name: "", type: "string" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_landId", type: "uint256" },
      { internalType: "string", name: "_documentHash", type: "string" },
    ],
    name: "registerLand",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_landId", type: "uint256" },
      { internalType: "address", name: "_newOwner", type: "address" },
    ],
    name: "transferLand",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
