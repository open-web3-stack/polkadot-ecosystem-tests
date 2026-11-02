import { defineConfig } from 'vitest/config'

import { resolve } from 'node:path'
import dotenv from 'dotenv'
import swc from 'unplugin-swc'

dotenv.config()
dotenv.config({ path: resolve(__dirname, 'KNOWN_GOOD_BLOCK_NUMBERS_KUSAMA.env') })
dotenv.config({ path: resolve(__dirname, 'KNOWN_GOOD_BLOCK_NUMBERS_POLKADOT.env') })
dotenv.config({ path: resolve(__dirname, 'KNOWN_GOOD_BLOCK_NUMBERS_WESTEND.env') })
if (process.env.LOG_LEVEL === undefined) {
	process.env.LOG_LEVEL = 'error'
}

export default defineConfig({
	test: {
		hookTimeout: 300_000,
		testTimeout: 300_000,
		pool: 'forks',
		passWithNoTests: true,
		retry: 1,
		reporters: process.env.GITHUB_ACTIONS ? ['verbose', 'github-actions'] : ['default'],
		// bifrostKusama is excluded: only Liebi public endpoints are configured,
		// and the only currently-reachable host prunes the state CI needs.
		exclude: [
			'**/node_modules/**',
			'**/.git/**',
			'packages/kusama/src/bifrostKusama.*.test.ts',
			'packages/kusama/src/karura.bifrostKusama.xcm.test.ts',
			'packages/polkadot/src/acala.bifrostPolkadot.xcm.test.ts',
			// Hydration runtime 455: on a fork, BuyExecution for DOT fails with AssetNotFound in
			// the MultiCurrencyTrader and the transferred DOT is trapped. The live chain deposits
			// DOT normally, so the fee oracle appears to lack data only on a quiet fork.
			'packages/polkadot/src/bifrostPolkadot.hydration.xcm.test.ts',
		],
	},
	build: {
		outDir: '../../dist',
	},
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [swc.vite({ tsconfigFile: true })],
	oxc: false,
	clearScreen: false,
})
