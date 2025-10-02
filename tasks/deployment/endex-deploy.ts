// tasks/deployment/endex-deploy.ts
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveDeployment } from "../utils";

task("endex-deploy", "Deploy the Endex contract (and mocks if needed)")
  .addOptionalParam("underlying", "Underlying token address (6 decimals)")
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

    // --- Resolve / deploy Underlying ---
    let underlyingAddr: string = args.underlying;
    if (!underlyingAddr) {
      console.log("• No --underlying provided → deploying a local Underlying mock (6 decimals).");
      // Adjust the mock name/ctor if your repo uses a different one
      // (e.g. ERC20Mock with a different constructor signature).
      const Underlying = await ethers.getContractFactory("MintableToken");
      // constructor(string name, string symbol, uint8 decimals) OR your mock’s signature
      const underlying = await Underlying.deploy("USD Coin", "USDC", 6);
      await underlying.waitForDeployment();
      underlyingAddr = await underlying.getAddress();
      console.log(`  UnderlyingMock @ ${underlyingAddr}`);
      saveDeployment(network.name, "Underlying", underlyingAddr);
    } else {
      console.log(`• Using provided Underlying @ ${underlyingAddr}`);
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
    const endex = await Endex.deploy(underlyingAddr, feedAddr, feedAddr);
    await endex.waitForDeployment();
    const endexAddr = await endex.getAddress();

    console.log(`\n✅ Endex deployed @ ${endexAddr}`);
    console.log(`   Underlying  @ ${underlyingAddr}`);
    console.log(`   FEED  @ ${feedAddr}\n`);

    saveDeployment(network.name, "Endex", endexAddr);

    return endexAddr;
  });
