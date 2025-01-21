import { testingPairs } from '@acala-network/chopsticks-testing'

import { ed25519CreateDerive, sr25519CreateDerive } from "@polkadot-labs/hdkd"
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers"
import { getPolkadotSigner } from "polkadot-api/signer"


export type DefaultAccounts = ReturnType<typeof testingPairs>

export const defaultAccounts = testingPairs()

export const defaultAccountsSr25199 = testingPairs('sr25519')

/**
 * Creates a set of test signers for either Ed25519 or Sr25519.
 * @param keyringType Type of keyring to use for substrate addresses ('ed25519' or 'sr25519')
 * @returns Object containing various test signers, and a `polkadotSignerBuilder` function to create more.
 */
export const testingSigners = (keyringType: 'Ed25519' | 'Sr25519' = 'Ed25519') => {
    const entropy = mnemonicToEntropy(DEV_PHRASE)
    const miniSecret = entropyToMiniSecret(entropy)
    const derive = keyringType === 'Ed25519'
        ? ed25519CreateDerive(miniSecret)
        : sr25519CreateDerive(miniSecret);

    // Create a PAPI polkadot signer given a derivation path e.g. "//Alice" or "//Bob".
    const polkadotSignerBuilder = (
        keyringType: 'Ed25519' | 'Sr25519' = 'Ed25519',
        path: string
    ) => {
        const hdkdKeyPair = derive(path)
        return getPolkadotSigner(
        hdkdKeyPair.publicKey,
        keyringType,
        hdkdKeyPair.sign,
        )
    }

    return {
        alice: polkadotSignerBuilder(keyringType, '//Alice'),
        bob: polkadotSignerBuilder(keyringType, '//Bob'),
        charlie: polkadotSignerBuilder(keyringType, '//Charlie'),
        dave: polkadotSignerBuilder(keyringType, '//Dave'),
        eve: polkadotSignerBuilder(keyringType, '//Eve'),
        ferdie: polkadotSignerBuilder(keyringType, '//Ferdie'),

        polkadotSignerBuilder
    }
}

export const defaultSigners = testingSigners()

export const defaultSignersSr25519 = testingSigners('Sr25519')