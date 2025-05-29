import type { ApiPromise } from '@polkadot/api'
import type { SubmittableExtrinsic } from '@polkadot/api/types'

export type Tx = ({ api }: { api: ApiPromise }, acc: any) => SubmittableExtrinsic<'promise'>
export type GetBalance = ({ api }: { api: ApiPromise }, address: string) => Promise<any>
export type GetTotalIssuance = () => Promise<any>
