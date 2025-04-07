import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import {
	expectResultSuccess,
	expectResultValue,
	cofhejs_initializeWithHardhatSigner,
	mock_expectPlaintext,
	localcofheFundWalletIfNeeded,
	isPermittedCofheEnvironment,
} from 'cofhe-hardhat-plugin'
import hre from 'hardhat'
import { cofhejs, Encryptable, EncryptStep, FheTypes } from 'cofhejs/node'
import { expect } from 'chai'

describe('Counter', function () {
	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	async function deployCounterFixture() {
		// Contracts are deployed using the first signer/account by default
		const [signer, signer2, bob, alice] = await hre.ethers.getSigners()

		const Counter = await hre.ethers.getContractFactory('Counter')
		const counter = await Counter.connect(bob).deploy()

		return { counter, signer, bob, alice }
	}

	describe('Functionality', function () {
		beforeEach(function () {
			if (!isPermittedCofheEnvironment(hre, 'MOCK')) this.skip()
		})

		it('Should increment the counter', async function () {
			const { counter, bob } = await loadFixture(deployCounterFixture)
			const count = await counter.count()
			await mock_expectPlaintext(bob.provider, count, 0n)
			await counter.connect(bob).increment()
			const count2 = await counter.count()
			await mock_expectPlaintext(bob.provider, count2, 1n)
		})
		it('cofhejs unseal (mocks)', async function () {
			const { counter, bob } = await loadFixture(deployCounterFixture)

			expectResultSuccess(await cofhejs_initializeWithHardhatSigner(bob))

			const count = await counter.count()
			const unsealedResult = await cofhejs.unseal(count, FheTypes.Uint32)
			console.log('unsealedResult', unsealedResult)
			expectResultValue(unsealedResult, 0n)

			await counter.connect(bob).increment()

			const count2 = await counter.count()
			const unsealedResult2 = await cofhejs.unseal(count2, FheTypes.Uint32)
			expectResultValue(unsealedResult2, 1n)
		})
		it('cofhejs encrypt (mocks)', async function () {
			const { counter, bob } = await loadFixture(deployCounterFixture)

			expectResultSuccess(await cofhejs_initializeWithHardhatSigner(bob))

			const setState = (step: EncryptStep) => {
				console.log(`Encrypt step - ${step}`)
			}

			const [encryptedInput] = expectResultSuccess(await cofhejs.encrypt(setState, [Encryptable.uint32(5n)] as const))
			await mock_expectPlaintext(bob.provider, encryptedInput.ctHash, 5n)

			await counter.connect(bob).reset(encryptedInput)

			const count = await counter.count()
			await mock_expectPlaintext(bob.provider, count, 5n)

			const unsealedResult = await cofhejs.unseal(count, FheTypes.Uint32)
			expectResultValue(unsealedResult, 5n)
		})
	})

	describe('Functionality (localcofhe)', function () {
		beforeEach(async function () {
			if (!isPermittedCofheEnvironment(hre, 'LOCAL')) this.skip()

			const [signer, signer2, bob, alice] = await hre.ethers.getSigners()
			await localcofheFundWalletIfNeeded(hre, bob.address)
		})

		it('Should increment the counter & unseal (localcofhe)', async function () {
			const { counter, bob } = await deployCounterFixture()
			expectResultSuccess(await cofhejs_initializeWithHardhatSigner(bob))

			await counter.connect(bob).increment()
			let count = await counter.count()
			const unsealedResult = await cofhejs.unseal(count, FheTypes.Uint32)

			expectResultValue(unsealedResult, 1n)
		})

		it('cofhejs encrypt & decrypt (localcofhe)', async function () {
			const { counter, bob } = await deployCounterFixture()

			expectResultSuccess(await cofhejs_initializeWithHardhatSigner(bob))

			const setState = (step: EncryptStep) => {
				console.log(`Encrypt step - ${step}`)
			}

			const [encryptedInput] = expectResultSuccess(await cofhejs.encrypt(setState, [Encryptable.uint32(5n)] as const))
			console.log('encryptedInput', encryptedInput)

			await counter.connect(bob).reset(encryptedInput)

			const count = await counter.count()
			const decryptedResult = await cofhejs.decrypt(count, FheTypes.Uint32)
			console.log('decryptedResult', decryptedResult)
			expectResultValue(decryptedResult, 5n)
		})

		it('On-chain decrypt (localcofhe)', async function () {
			const { counter, bob } = await deployCounterFixture()

			expectResultSuccess(await cofhejs_initializeWithHardhatSigner(bob))

			await counter.connect(bob).increment()
			await counter.connect(bob).increment()
			await counter.connect(bob).increment()

			await counter.connect(bob).decryptCounter()

			let maxAttempts = 10
			let count = 0n
			while (maxAttempts > 0) {
				try {
					count = await counter.connect(bob).getDecryptedValue()
					maxAttempts = 0
				} catch (error) {
					console.error('Error', error)
				}
				maxAttempts--
				await sleep(1000)
			}

			expect(count).equal(3n)
		})
	})
})
