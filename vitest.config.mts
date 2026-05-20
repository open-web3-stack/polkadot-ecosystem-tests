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
		// Excluded chains:
		//
		// - bifrostKusama: only Liebi public endpoint (us./hk./generic) is configured,
		//   and the only currently-reachable host prunes the state CI needs.
		// - acala: Subway hardcodes its per-upstream request_timeout to 30s and
		//   doesn't expose it in `ClientConfig`, so heavy Acala storage queries
		//   that take >30s force Subway to cycle through the 3 Liebi endpoints,
		//   none of which respond inside the chopsticks rpcTimeout (90s here).
		//   Unblock via an upstream Subway fix (`request_timeout` in YAML).
		exclude: [
			'**/node_modules/**',
			'**/.git/**',
			'packages/kusama/src/bifrostKusama.*.test.ts',
			'packages/kusama/src/karura.bifrostKusama.xcm.test.ts',
			'packages/polkadot/src/acala.*.test.ts',
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
