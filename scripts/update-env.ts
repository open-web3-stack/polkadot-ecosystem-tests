import { cryptoWaitReady } from '@polkadot/util-crypto'

import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)

import * as chains from '@e2e-test/networks/chains'

import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api'

const isUpdateKnownGood = process.argv.includes('--update-known-good')

const getEnvPath = (networkGroup?: 'polkadot' | 'kusama') => {
  const envFile = isUpdateKnownGood ? `KNOWN_GOOD_BLOCK_NUMBERS_${networkGroup?.toUpperCase()}.env` : '.env'
  return path.resolve(dirname(__filename), '../', envFile)
}

const readEnvFile = (networkGroup?: 'polkadot' | 'kusama') => {
  try {
    return fs.readFileSync(getEnvPath(networkGroup), 'utf8').toString()
  } catch (_err) {
    return ''
  }
}

const main = async () => {
  await cryptoWaitReady()

  if (isUpdateKnownGood) {
    for (const networkGroup of ['polkadot', 'kusama'] as const) {
      const envFileContent = readEnvFile(networkGroup)
      const currentEnv = dotenv.parse(envFileContent)

      const chainsInGroup = Object.entries(chains).filter(([, chain]) => chain.networkGroup === networkGroup)

      const blockNumberPromises = chainsInGroup.map(async ([name, chain]) => {
        const fetchBlockNumber = async () => {
          const api = await ApiPromise.create({
            provider:
              Array.isArray(chain.endpoint) || chain.endpoint.startsWith('ws')
                ? new WsProvider(chain.endpoint)
                : new HttpProvider(chain.endpoint),
            noInitWarn: true,
          })
          try {
            const header = await api.rpc.chain.getHeader()
            const blockNumber = header.number.toNumber()
            return `${name.toUpperCase()}_BLOCK_NUMBER=${blockNumber}`
          } finally {
            await api.disconnect()
          }
        }

        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout fetching block number for ${name}`)), 60000),
        )

        try {
          return await Promise.race([fetchBlockNumber(), timeout])
        } catch (error: any) {
          console.error(`Failed to fetch block number for ${name}: ${error.message}`)
          const fallback = currentEnv[`${name.toUpperCase()}_BLOCK_NUMBER`]
          if (fallback) {
            console.log(`Using fallback for ${name}: ${fallback}`)
            return `${name.toUpperCase()}_BLOCK_NUMBER=${fallback}`
          }
          return null
        }
      })

      const results = await Promise.all(blockNumberPromises)
      const newBlockNumbers = results
        .filter((x): x is string => x !== null)
        .sort()
        .join('\n')

      const newEnvFileContent = `${newBlockNumbers}\n`
      console.log(`Updated ${networkGroup} block numbers:\n${newBlockNumbers}`)
      fs.writeFileSync(getEnvPath(networkGroup), newEnvFileContent)
    }
  } else {
    // Local development: create a single .env file
    const envFileContent = readEnvFile()
    const currentEnv = dotenv.parse(envFileContent)
    const blockNumberPromises = Object.entries(chains).map(async ([name, chain]) => {
      const fetchBlockNumber = async () => {
        const api = await ApiPromise.create({
          provider:
            Array.isArray(chain.endpoint) || chain.endpoint.startsWith('ws')
              ? new WsProvider(chain.endpoint)
              : new HttpProvider(chain.endpoint),
          noInitWarn: true,
        })
        try {
          const header = await api.rpc.chain.getHeader()
          const blockNumber = header.number.toNumber()
          return `${name.toUpperCase()}_BLOCK_NUMBER=${blockNumber}`
        } finally {
          await api.disconnect()
        }
      }
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout fetching block number for ${name}`)), 60000),
      )
      try {
        return await Promise.race([fetchBlockNumber(), timeout])
      } catch (error: any) {
        console.error(`Failed to fetch block number for ${name}: ${error.message}`)
        const fallback = currentEnv[`${name.toUpperCase()}_BLOCK_NUMBER`]
        if (fallback) {
          console.log(`Using fallback for ${name}: ${fallback}`)
          return `${name.toUpperCase()}_BLOCK_NUMBER=${fallback}`
        }
        return null
      }
    })
    const results = await Promise.all(blockNumberPromises)
    const newBlockNumbers = results
      .filter((x): x is string => x !== null)
      .sort()
      .join('\n')
    const commentedOldContent = envFileContent.replaceAll(/(^[A-Z0-9]+_BLOCK_NUMBER=\d+)/gm, '# $1')
    const newEnvFileContent = `${newBlockNumbers}\n\n${commentedOldContent}`
    console.log(newBlockNumbers)
    fs.writeFileSync(getEnvPath(), newEnvFileContent)
  }
}

main()
  .catch(console.error)
  .finally(() => process.exit(0))
