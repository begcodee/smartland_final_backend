import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.connect();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const threshold = Number(process.env.APPROVAL_THRESHOLD || 2);
  const Registry = await ethers.getContractFactory("SmartLandRegistry");
  const registry = await Registry.deploy(deployer.address, threshold);
  await registry.waitForDeployment();

  const addr = await registry.getAddress();
  console.log("SmartLandRegistry deployed:", addr);

  const approvers = String(process.env.APPROVER_ADDRESSES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (approvers.length) {
    const role = await registry.APPROVER_ROLE();
    for (const a of approvers) {
      const tx = await registry.grantRole(role, a);
      await tx.wait();
      console.log("Granted APPROVER_ROLE to", a);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

