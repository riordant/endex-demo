import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import hre from 'hardhat'
import { cofhejs, Encryptable, FheTypes } from 'cofhejs/node'
import { expect } from 'chai'

// coprocessor requires up to 10 seconds to push the value back onchain.
function coprocessor() {
  console.log('waiting for coprocessor..');
  return new Promise((resolve) => {
    setTimeout(resolve, 10000);
  });
}

describe('SimpleEncryptedPerps', function () {
	async function deployPerpsFixture() {
		const [deployer, user, lp, keeper] = await hre.ethers.getSigners()

		// Deploy mock USDC token
		const USDC = await hre.ethers.getContractFactory('MintableToken')
		const usdc = await USDC.deploy('USDC', 'USDC', 6)
        const usdc_address = await usdc.getAddress();

		// Deploy mock price feed (8 decimals, starting at $2000)
		const Feed = await hre.ethers.getContractFactory('MockV3Aggregator')
		const feed = await Feed.deploy(8, 2000_00000000n)
        const feed_address = await feed.getAddress();

		// Deploy the perpetual exchange contract
		const Simple = await hre.ethers.getContractFactory('SimpleEncryptedPerps')
		const perps = await Simple.deploy(usdc_address, feed_address)
        const perps_address = await perps.getAddress();

		return { perps, perps_address, usdc, feed, deployer, user, lp, keeper }
	}

	describe('LP Functions', function () {
		beforeEach(function () {
			if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
		})

		afterEach(function () {
			if (!hre.cofhe.isPermittedEnvironment('MOCK')) return
		})

		it('Should allow LP to deposit and withdraw', async function () {
			const { perps, perps_address, usdc, lp } = await loadFixture(deployPerpsFixture)

			// Seed LP with USDC
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)

			// Check initial state
			expect(await perps.totalLpShares()).to.equal(0n)
			expect(await perps.usdcBalance()).to.equal(0n)

			// LP deposits
			await perps.connect(lp).lpDeposit(500_000n * 10n ** 6n)

			// Check state after deposit
			expect(await perps.totalLpShares()).to.equal(500_000n * 10n ** 6n)
			expect(await perps.lpShares(lp.address)).to.equal(500_000n * 10n ** 6n)
			expect(await perps.usdcBalance()).to.equal(500_000n * 10n ** 6n)

			// LP withdraws
			await perps.connect(lp).lpWithdraw(250_000n * 10n ** 6n)

			// Check state after withdrawal
			expect(await perps.totalLpShares()).to.equal(250_000n * 10n ** 6n)
			expect(await perps.lpShares(lp.address)).to.equal(250_000n * 10n ** 6n)
			expect(await perps.usdcBalance()).to.equal(250_000n * 10n ** 6n)
		})
	})

	describe('Position Management', function () {
		beforeEach(function () {
			if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
            console.log("enabling logs..")
			hre.cofhe.mocks.enableLogs()
		})

		it('Should open a long position with encrypted size', async function () {
			const { perps, perps_address, usdc, feed, user, lp } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 20_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Encrypt position size (30,000 USDC with 3x leverage)
			const [encryptedSize] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(30_000n * 10n ** 6n)])
			)

			// Open position
			await perps.connect(user).openPosition(
				true, // isLong
				encryptedSize, // encrypted size
				10_000n * 10n ** 6n, // collateral
				0, // stopLossPrice
				0, // takeProfitPrice
				0  // liquidationPrice
			)

			// Check position was created
			const position = await perps.getPosition(1)
			expect(position.owner).to.equal(user.address)
			expect(position.isLong).to.be.true
			expect(position.collateral).to.equal(10_000n * 10n ** 6n)
			expect(position.status).to.equal(0) // Status.Open
			expect(position.entryPrice).to.equal(2000_00000000n)

			// Verify the encrypted size can be unsealed
			const unsealedSize = await cofhejs.unseal(position.size, FheTypes.Uint256)
			await hre.cofhe.expectResultValue(unsealedSize, 30_000n * 10n ** 6n)
		})

		it('Should open a short position with encrypted size', async function () {
			const { perps, perps_address, usdc, user, lp } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 20_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Encrypt position size (25,000 USDC with 2.5x leverage)
			const [encryptedSize] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(25_000n * 10n ** 6n)])
			)

			// Open short position
			await perps.connect(user).openPosition(
				false, // isLong
				encryptedSize, // encrypted size
				10_000n * 10n ** 6n, // collateral
				0, // stopLossPrice
				0, // takeProfitPrice
				0  // liquidationPrice
			)

			// Check position was created
			const position = await perps.getPosition(1)
			expect(position.owner).to.equal(user.address)
			expect(position.isLong).to.be.false
			expect(position.collateral).to.equal(10_000n * 10n ** 6n)
			expect(position.status).to.equal(0) // Status.Open
		})

		it('Should enforce leverage limits with encrypted size', async function () {
			const { perps, perps_address, usdc, user, lp } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 20_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Try to open position with 6x leverage (should be capped to 5x)
			const [encryptedSize] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(60_000n * 10n ** 6n)])
			)

			await perps.connect(user).openPosition(
				true, // isLong
				encryptedSize, // encrypted size (6x leverage attempt)
				10_000n * 10n ** 6n, // collateral
				0, // stopLossPrice
				0, // takeProfitPrice
				0  // liquidationPrice
			)

			// Position should be created but size should be capped to 5x leverage
			const position = await perps.getPosition(1)
			expect(position.owner).to.equal(user.address)
			expect(position.collateral).to.equal(10_000n * 10n ** 6n)

			// The size should be capped to 5x leverage (50,000 USDC)
			const unsealedSize = await cofhejs.unseal(position.size, FheTypes.Uint256)
			await hre.cofhe.expectResultValue(unsealedSize, 50_000n * 10n ** 6n)
		})

		it('Should close position and settle with profit', async function () {
			const { perps, perps_address, usdc, feed, user, lp } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 20_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Open long position
			const [encryptedSize] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(30_000n * 10n ** 6n)])
			)

            const initialCollateral = BigInt(10_000n * 10n ** 6n);

			await perps.connect(user).openPosition(
				true, // isLong
				encryptedSize, // encrypted size
				initialCollateral, // collateral
				0, // stopLossPrice
				0, // takeProfitPrice
				0  // liquidationPrice
			)

			// Move price up to $2200 (10% increase)
			await feed.updateAnswer(2200_00000000n)

			// Close position
			await perps.connect(user).closePosition(1)

			// Position should be awaiting settlement
			let position = await perps.getPosition(1)
			expect(position.status).to.equal(1) // Status.AwaitingSettlement
            //
            // sleep to allow coprocessor to push back the decrypted value
            await coprocessor();

			// Settle the position
			await perps.connect(user).settlePositions([1])

			//// Position should be closed
			position = await perps.getPosition(1)
			expect(position.status).to.equal(3) // Status.Closed

			// Check user received profit (minus fees)
			const userBalance = BigInt(await usdc.balanceOf(user.address))
			expect(userBalance > initialCollateral).to.be.true // Should have more than initial collateral
		})

		it('Should handle take profit automatically', async function () {
			const { perps, perps_address, usdc, feed, user, lp, keeper } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 20_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Open long position with take profit at $2100
			const [encryptedSize] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(30_000n * 10n ** 6n)])
			)

			await perps.connect(user).openPosition(
				true, // isLong
				encryptedSize, // encrypted size
				10_000n * 10n ** 6n, // collateral
				0, // stopLossPrice
				2100_00000000n, // takeProfitPrice
				0  // liquidationPrice
			)

			// Check positions to trigger TP
			await perps.connect(keeper).checkPositions([1])

			// Move price to take profit level
			await feed.updateAnswer(2100_00000000n)

			// Check positions again to trigger settlement
			await perps.connect(keeper).checkPositions([1])

			// Position should be awaiting settlement
			let position = await perps.getPosition(1)
			expect(position.status).to.equal(1) // Status.AwaitingSettlement

            // sleep to allow coprocessor to push back the decrypted value
            await coprocessor();

			// Settle the position
			await perps.connect(user).settlePositions([1])

			// Position should be closed
			position = await perps.getPosition(1)
			expect(position.status).to.equal(3) // Status.Closed
		})

		it('Should handle stop loss automatically', async function () {
			const { perps, perps_address, usdc, feed, user, lp, keeper } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 20_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Open long position with stop loss at $1900
			const [encryptedSize] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(30_000n * 10n ** 6n)])
			)

			await perps.connect(user).openPosition(
				true, // isLong
				encryptedSize, // encrypted size
				10_000n * 10n ** 6n, // collateral
				1900_00000000n, // stopLossPrice
				0, // takeProfitPrice
				0  // liquidationPrice
			)

			// Check positions to trigger SL
			await perps.connect(keeper).checkPositions([1])

			// Move price down to stop loss level
			await feed.updateAnswer(1900_00000000n)

			// Check positions again to trigger settlement
			await perps.connect(keeper).checkPositions([1])

			// Position should be awaiting settlement
			let position = await perps.getPosition(1)
			expect(position.status).to.equal(1) // Status.AwaitingSettlement

            // sleep to allow coprocessor to push back the decrypted value
            await coprocessor();

			// Settle the position
			await perps.connect(user).settlePositions([1])

			// Position should be closed
			position = await perps.getPosition(1)
			expect(position.status).to.equal(3) // Status.Closed
		})
	})

	describe('Edge Cases', function () {
		beforeEach(function () {
			if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
		})

		it('Should handle multiple positions per user', async function () {
			const { perps, perps_address, usdc, feed, user, lp } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 50_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Open first position
			const [encryptedSize1] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(20_000n * 10n ** 6n)])
			)

			await perps.connect(user).openPosition(
				true, // isLong
				encryptedSize1, // encrypted size
				10_000n * 10n ** 6n, // collateral
				0, // stopLossPrice
				0, // takeProfitPrice
				0  // liquidationPrice
			)

			// Open second position
			const [encryptedSize2] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(15_000n * 10n ** 6n)])
			)

			await perps.connect(user).openPosition(
				false, // isLong
				encryptedSize2, // encrypted size
				8_000n * 10n ** 6n, // collateral
				0, // stopLossPrice
				0, // takeProfitPrice
				0  // liquidationPrice
			)

			// Check both positions exist
			const position1 = await perps.getPosition(1)
			const position2 = await perps.getPosition(2)

			expect(position1.owner).to.equal(user.address)
			expect(position2.owner).to.equal(user.address)
			expect(position1.isLong).to.be.true
			expect(position2.isLong).to.be.false
		})

		it('Should handle zero collateral gracefully', async function () {
			const { perps, perps_address, usdc, feed, user, lp } = await loadFixture(deployPerpsFixture)

			// Setup LP
			await usdc.mint(lp.address, 1_000_000n * 10n ** 6n)
			await usdc.connect(lp).approve(perps_address, hre.ethers.MaxUint256)
			await perps.connect(lp).lpDeposit(1_000_000n * 10n ** 6n)

			// Setup user
			await usdc.mint(user.address, 20_000n * 10n ** 6n)
			await usdc.connect(user).approve(perps_address, hre.ethers.MaxUint256)

			// Initialize cofhejs
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(user))

			// Try to open position with zero collateral
			const [encryptedSize] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([Encryptable.uint256(30_000n * 10n ** 6n)])
			)

			// This should revert due to insufficient collateral
			//await expect(
			//	perps.connect(user).openPosition(
			//		true, // isLong
			//		encryptedSize, // encrypted size
			//		0, // zero collateral
			//		0, // stopLossPrice
			//		0, // takeProfitPrice
			//		0  // liquidationPrice
			//	)
			//).to.be.reverted
		})
	})
})


