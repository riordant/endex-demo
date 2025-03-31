import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'

describe('Counter', function () {
	// We define a fixture to reuse the same setup in every test.
	// We use loadFixture to run this setup once, snapshot that state,
	// and reset Hardhat Network to that snapshot in every test.
	async function deployCounterFixture() {
		// Contracts are deployed using the first signer/account by default
		const [signer, signer2, bob, alice] = await hre.ethers.getSigners()

		const Counter = await hre.ethers.getContractFactory('Counter')
		const counter = await Counter.deploy()

		return { counter, signer, bob, alice }
	}

	describe('Functionality', function () {
		it('Should set the right unlockTime', async function () {
			const { counter, bob } = await loadFixture(deployCounterFixture)

			expect(await counter.count()).to.equal(0)

			await counter.connect(bob).increment()
		})
	})
})
