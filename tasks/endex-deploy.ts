// tasks/deploy-endex.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveDeployment } from "./utils";

task("endex-deploy", "Deploy the Endex contract (and mocks if needed)")
  .addOptionalParam("usdc", "USDC token address (6 decimals)")
  .addOptionalParam("feed", "Chainlink AggregatorV3 address (8 decimals)")
  .addOptionalParam(
    "price",
    "Initial price for mock aggregator (int, 8 decimals; default 2000e8)",
    "200000000000" // 2000 * 1e8
  )
  .addOptionalParam("decimals", "Mock aggregator decimals", "8")
  .setAction(async (args: any, hre: HardhatRuntimeEnvironment) => {
    const { ethers, network } = hre;

    console.log(`\n=== Deploy Endex on '${network.name}' ===`);
    const [deployer] = await ethers.getSigners();
    console.log(`Deployer: ${deployer.address}`);

    // --- Resolve / deploy USDC ---
    let usdcAddr: string = args.usdc;
    if (!usdcAddr) {
      console.log("• No --usdc provided → deploying a local USDC mock (6 decimals).");
      // Adjust the mock name/ctor if your repo uses a different one
      // (e.g. ERC20Mock with a different constructor signature).
      const USDC = await ethers.getContractFactory("MintableToken");
      // constructor(string name, string symbol, uint8 decimals) OR your mock’s signature
      const usdc = await USDC.deploy("USD Coin", "USDC", 6);
      await usdc.waitForDeployment();
      usdcAddr = await usdc.getAddress();
      console.log(`  USDCMock @ ${usdcAddr}`);
      saveDeployment(network.name, "USDC", usdcAddr);
    } else {
      console.log(`• Using provided USDC @ ${usdcAddr}`);
    }

    // --- Resolve / deploy Aggregator ---
    let feedAddr: string = args.feed;
    if (!feedAddr) {
      console.log("• No --feed provided → deploying Chainlink MockV3Aggregator.");
      const decimals = Number(args.decimals ?? 8);
      const initialAnswer = BigInt(args.price ?? "200000000000"); // 2000e8 default

      const Agg = await ethers.getContractFactory("MockV3Aggregator");
      // constructor(uint8 _decimals, int256 _initialAnswer)
      const feed = await Agg.deploy(decimals, initialAnswer);
      await feed.waitForDeployment();
      feedAddr = await feed.getAddress();
      console.log(`  MockV3Aggregator @ ${feedAddr} (decimals=${decimals}, price=${initialAnswer})`);
      saveDeployment(network.name, "PriceFeed", feedAddr);
    } else {
      console.log(`• Using provided PriceFeed @ ${feedAddr}`);
    }

    // --- Deploy Endex ---
    const Endex = await ethers.getContractFactory("Endex");
    const endex = await Endex.deploy(usdcAddr, feedAddr);
    await endex.waitForDeployment();
    const endexAddr = await endex.getAddress();

    console.log(`\n✅ Endex deployed @ ${endexAddr}`);
    console.log(`   USDC  @ ${usdcAddr}`);
    console.log(`   FEED  @ ${feedAddr}\n`);

    saveDeployment(network.name, "Endex", endexAddr);

    return endexAddr;
  });
