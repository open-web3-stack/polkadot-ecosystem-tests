import { acala, karura } from './acala.js'

import { fileURLToPath } from 'url'
import path, { dirname } from 'path'

// Convert the URL to a path and get the directory name
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const acalaNext = acala.extend(() => ({
  name: 'acalaNext',
  wasmOverride: path.resolve(__dirname, '../wasm/acala_runtime.wasm'),
}))

export const karuraNext = karura.extend(() => ({
  name: 'karuraNext',
  wasmOverride: path.resolve(__dirname, '../wasm/karura_runtime.wasm'),
}))
