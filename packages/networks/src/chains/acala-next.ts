import { acala, karura } from './acala.js'

import path from 'path'

export const acalaNext = acala.extend(() => ({
  name: 'acalaNext',
  wasmOverride: path.resolve(__dirname, '../wasm/acala_runtime.wasm'),
}))

export const karuraNext = karura.extend(() => ({
  name: 'karuraNext',
  wasmOverride: path.resolve(__dirname, '../wasm/karura_runtime.wasm'),
}))
