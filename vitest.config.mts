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
		// Bifrost Kusama public RPCs (us./hk./generic Liebi) are unreachable or
		// pruned at the pinned block; every shard that runs these tests stalls on
		// setup. Excluded until a workable endpoint set is identified.
		exclude: [
			'**/node_modules/**',
			'**/.git/**',
			'packages/kusama/src/bifrostKusama.*.test.ts',
			'packages/kusama/src/karura.bifrostKusama.xcm.test.ts',
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
