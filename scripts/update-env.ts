import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
import * as chains from '@e2e-test/networks/chains'
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api'

const isUpdateKnownGood = process.argv.includes('--update-known-good')
const envFile = isUpdateKnownGood ? 'KNOWN_GOOD_BLOCK_NUMBERS.env' : '.env'
const envPath = path.resolve(dirname(__filename), '../', envFile)

const readEnvFile = () => {
  try {
    return fs.readFileSync(envPath, 'utf8').toString()
  } catch (_err) {
    return ''
  }
}

const main = async () => {
  let envFile = readEnvFile()

  // comment out current ones
  envFile = envFile.replaceAll(/(^[A-Z0-9]+_BLOCK_NUMBER=\d+)/gm, '# $1')

  // prepend new ones
  const blockNumbers: Promise<string>[] = []
  for (const [name, chain] of Object.entries(chains)) {
    const fn = async () => {
      const api = await ApiPromise.create({
        provider:
          Array.isArray(chain.endpoint) || chain.endpoint.startsWith('ws')
            ? new WsProvider(chain.endpoint)
            : new HttpProvider(chain.endpoint),
        noInitWarn: true,
      })
      const header = await api.rpc.chain.getHeader()
      const blockNumber = header.number.toNumber()
      return `${name.toUpperCase()}_BLOCK_NUMBER=${blockNumber}`
    }
    blockNumbers.push(fn())
  }

  const blockNumbersStr = (await Promise.all(blockNumbers)).join('\n')

  if (isUpdateKnownGood) {
    envFile = `${blockNumbersStr}\n`
  } else {
    envFile = `${blockNumbersStr}\n\n${envFile}`
  }

  console.log(blockNumbersStr)
  fs.writeFileSync(envPath, envFile)
}

main()
  .catch(console.error)
  .finally(() => process.exit(0))
