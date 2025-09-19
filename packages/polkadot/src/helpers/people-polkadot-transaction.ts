import type { Client } from '@e2e-test/networks'

import { ApiPromise, type WsProvider } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'

/**
 * Transaction extensions configuration for People Polkadot runtime.
 */
export const PEOPLE_POLKADOT_TX_EXTENSIONS = {
  VerifyMultiSignature: { extrinsic: { verifyMultiSignature: 'u8' }, payload: {} },
  AsPerson: { extrinsic: { asPerson: 'u8' }, payload: {} },
  AsProofOfInkParticipant: { extrinsic: { asProofOfInkParticipant: 'Option<Null>' }, payload: {} },
  ProvideForVoucherClaimer: { extrinsic: { provideForVoucherClaimer: 'Null' }, payload: {} },
  ScoreAsParticipant: { extrinsic: { scoreAsParticipant: 'u8' }, payload: {} },
  GameAsInvited: { extrinsic: { gameAsInvited: 'u8' }, payload: {} },
  RestrictOrigins: { extrinsic: { restrictOrigins: 'bool' }, payload: {} },
  CheckNonZeroSender: { extrinsic: {}, payload: {} },
  CheckWeight: { extrinsic: {}, payload: {} },
} as const

/**
 * Transaction extensions order for People Polkadot runtime.
 * This must match the exact order from the runtime metadata.
 */
export const PEOPLE_POLKADOT_EXTENSION_ORDER = [
  'VerifyMultiSignature',
  'AsPerson',
  'AsProofOfInkParticipant',
  'ProvideForVoucherClaimer',
  'ScoreAsParticipant',
  'GameAsInvited',
  'RestrictOrigins',
  'CheckNonZeroSender',
  'CheckSpecVersion',
  'CheckTxVersion',
  'CheckGenesis',
  'CheckMortality',
  'CheckNonce',
  'CheckWeight',
  'ChargeTransactionPayment',
  'CheckMetadataHash',
] as const

/**
 * Default values for custom transaction extensions
 */
export interface CustomExtensionOptions {
  verifyMultiSignature?: number
  asPerson?: number
  asProofOfInkParticipant?: null
  provideForVoucherClaimer?: null
  scoreAsParticipant?: number
  gameAsInvited?: number
  restrictOrigins?: boolean
}

/**
 * Standard transaction options
 */
export interface TransactionOptions {
  nonce?: number
  tip?: number
  era?: any
  customExtensions?: CustomExtensionOptions
}

/**
 * Creates an ApiPromise instance configured for People Polkadot custom transaction extensions
 */
export async function createPeoplePolkadotApi(client: Client): Promise<ApiPromise> {
  const provider = client.ws as unknown as WsProvider

  const api = await ApiPromise.create({
    provider,
    signedExtensions: [...PEOPLE_POLKADOT_EXTENSION_ORDER],
    userExtensions: PEOPLE_POLKADOT_TX_EXTENSIONS,
    types: {},
  })

  await api.isReady

  // Force the registry to use our exact order
  ;(api.registry as any).setSignedExtensions?.(
    PEOPLE_POLKADOT_EXTENSION_ORDER as any,
    PEOPLE_POLKADOT_TX_EXTENSIONS as any,
  )

  return api
}

/**
 * Creates signing options for People Polkadot transactions with custom extensions
 */
export function createSigningOptions(api: ApiPromise, nonce: number, options: TransactionOptions = {}) {
  const customExtensions = options.customExtensions || {}

  return {
    verifyMultiSignature: customExtensions.verifyMultiSignature ?? 1, // MultiSignature::Sr25519
    asPerson: customExtensions.asPerson ?? 0,
    asProofOfInkParticipant: customExtensions.asProofOfInkParticipant ?? null, // None
    provideForVoucherClaimer: customExtensions.provideForVoucherClaimer ?? null, // unit
    scoreAsParticipant: customExtensions.scoreAsParticipant ?? 0,
    gameAsInvited: customExtensions.gameAsInvited ?? 0,
    restrictOrigins: customExtensions.restrictOrigins ?? false,

    // Standard extensions
    era: options.era ?? api.registry.createType('ExtrinsicEra', 0), // IMMORTAL
    blockHash: api.genesisHash,
    genesisHash: api.genesisHash,
    nonce,
    tip: options.tip ?? 0,
  }
}

/**
 * Submits a transaction to People Polkadot with custom transaction extensions and automatic block production
 */
export async function submitPeoplePolkadotTransaction(
  client: Client,
  transaction: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
  options: TransactionOptions = {},
): Promise<boolean> {
  const api = await createPeoplePolkadotApi(client)

  const nonce = options.nonce ?? (await api.rpc.system.accountNextIndex(signer.address))
  const nonceNumber = typeof nonce === 'number' ? nonce : nonce.toNumber()

  const signOpts = createSigningOptions(api, nonceNumber, options)

  return new Promise<boolean>((resolve, reject) => {
    let unsub: (() => void) | undefined

    const tx = api.tx[transaction.method.section][transaction.method.method](...transaction.method.args)

    tx.signAndSend(signer, signOpts as any, async (result) => {
      const { status, events, dispatchError } = result
      console.log('[status]', status.type)

      await client.dev.newBlock()

      if (status.isInBlock) {
        console.log('[inBlock] hash=%s', status.asInBlock.toHex())
      }

      if (events?.length) {
        console.log('[events] %d', events.length)
        events.forEach(({ event, phase }, idx) => {
          console.log(
            '  #%d phase=%s %s.%s %s',
            idx,
            phase.toString(),
            event.section,
            event.method,
            JSON.stringify(event.data.toHuman()),
          )
        })
      }

      if (dispatchError) {
        if ((dispatchError as any).isModule) {
          const decoded = api.registry.findMetaError((dispatchError as any).asModule)
          console.error('[error] module=%s.%s docs=%s', decoded.section, decoded.name, decoded.docs.join(' '))
          unsub?.()
          return reject(new Error(`${decoded.section}.${decoded.name}`))
        } else {
          console.error('[error] %s', dispatchError.toString())
          unsub?.()
          return reject(new Error(dispatchError.toString()))
        }
      }

      if (status.isFinalized) {
        console.log('[finalized] hash=%s', status.asFinalized.toHex())

        const ok = events?.some(({ event }) => api.events.system.ExtrinsicSuccess.is(event)) ?? false
        unsub?.()
        return resolve(ok)
      }
    })
      .then((u) => {
        unsub = u
      })
      .catch((e) => {
        console.error('[signAndSend.catch]', e)
        unsub?.()
        reject(e)
      })
  })
}
