import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

import { resolve } from 'node:path'
import dotenv from 'dotenv'
import tsconfigPaths from 'vite-tsconfig-paths'

dotenv.config()
dotenv.config({ path: resolve(__dirname, 'KNOWN_GOOD_BLOCK_NUMBERS.env') })
if (process.env.LOG_LEVEL === undefined) {
	process.env.LOG_LEVEL = 'error'
}

export default defineConfig({
	test: {
		hookTimeout: 240_000,
		testTimeout: 240_000,
		pool: 'forks',
		passWithNoTests: true,
		retry: 1,
		reporters: process.env.GITHUB_ACTIONS ? ['verbose', 'github-actions'] : ['basic'],
	},
	build: {
		outDir: '../../dist',
	},
	plugins: [tsconfigPaths(), swc.vite()],
})
