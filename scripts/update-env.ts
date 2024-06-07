import { fileURLToPath } from 'url'
import fs from 'fs'
import path, { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
import * as chains from '@e2e-test/networks/chains'
import { ApiPromise, WsProvider } from '@polkadot/api'

const envPath = path.resolve(dirname(__filename), '../KNOWN_GOOD_BLOCK_NUMBERS.env')

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
      const api = await ApiPromise.create({ provider: new WsProvider(chain.endpoint), noInitWarn: true })
      const header = await api.rpc.chain.getHeader()
      const blockNumber = header.number.toNumber()
      return `${name.toUpperCase()}_BLOCK_NUMBER=${blockNumber}`
    }
    blockNumbers.push(fn())
  }

  const blockNumbersStr = (await Promise.all(blockNumbers)).join('\n')

  envFile = blockNumbersStr + '\n\n' + envFile
  console.log('KNOWN_GOOD_BLOCK_NUMBERS:')
  console.log(envFile)
  fs.writeFileSync(envPath, envFile)
  console.log('read', fs.readFileSync(envFile).toString())
}

main()
  .catch(console.error)
  .finally(() => process.exit(0))
