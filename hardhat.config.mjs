import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: { type: "edr-simulated" },
    ...(process.env.AMOY_RPC_URL || process.env.CHAIN_RPC_URL
      ? {
          amoy: {
            type: "http",
            url: process.env.AMOY_RPC_URL || process.env.CHAIN_RPC_URL,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
          },
        }
      : {}),
    ...(process.env.SEPOLIA_RPC_URL
      ? {
          sepolia: {
            type: "http",
            url: process.env.SEPOLIA_RPC_URL,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
          },
        }
      : {}),
    ...(process.env.MAINNET_RPC_URL
      ? {
          mainnet: {
            type: "http",
            url: process.env.MAINNET_RPC_URL,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
          },
        }
      : {}),
  },
});

