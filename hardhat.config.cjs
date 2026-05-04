/** @type {import('hardhat/config').HardhatUserConfig} */
require("@nomicfoundation/hardhat-toolbox");

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    // Example (configure in env when you pick a chain):
    // amoy: { url: process.env.CHAIN_RPC_URL || "", accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [] },
  },
};

