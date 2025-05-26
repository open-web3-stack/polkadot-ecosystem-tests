/**
 * Proxy types in the Polkadot relay chain.
 */
export const PolkadotProxyTypes = {
  Any: 0,
  NonTransfer: 1,
  Governance: 2,
  Staking: 3,
  CancelProxy: 6,
  Auction: 7,
  NominationPools: 8,
  ParaRegistration: 9,
}

export const KusamaProxyTypes = {
  Any: 0,
  NonTransfer: 1,
  Governance: 2,
  Staking: 3,
  CancelProxy: 5,
  Auction: 6,
  Society: 7,
  NominationPools: 8,
  Spokesperson: 9,
  ParaRegistration: 10,
}

export const AssetHubProxyTypes = {
  Any: 0,
  NonTransfer: 1,
  CancelProxy: 2,
  Assets: 3,
  AssetOwner: 4,
  AssetManager: 5,
  Collator: 6,
}

export const AssetHubWestendProxyTypes = {
  Any: 0,
  NonTransfer: 1,
  CancelProxy: 2,
  Assets: 3,
  AssetOwner: 4,
  AssetManager: 5,
  Collator: 6,
  Governance: 7,
  Staking: 8,
  NominationPools: 9,
  OldSudoBalances: 10,
  OldIdentityJudgement: 11,
  OldAuction: 12,
  OldParaRegistration: 13,
}

export const CollectivesProxyTypes = {
  Any: 0,
  NonTransfer: 1,
  CancelProxy: 2,
  Collator: 3,
  Alliance: 4,
  Fellowship: 5,
  Ambassador: 6,
}

export const CoretimeProxyTypes = {
  Any: 0,
  NonTransfer: 1,
  CancelProxy: 2,
  Broker: 3,
  CoretimeRenewer: 4,
  OnDemandPurchaser: 5,
  Collator: 6,
}

export const PeopleProxyTypes = {
  Any: 0,
  NonTransfer: 1,
  CancelProxy: 2,
  Identity: 3,
  IdentityJudgement: 4,
  Collator: 5,
}
