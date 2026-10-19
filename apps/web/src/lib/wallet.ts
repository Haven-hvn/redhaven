'use client'

/**
 * Wallet wiring: Reown AppKit + wagmi, created once at module level
 * (components call `modal?.open()`, never `useAppKit()`, whose SSR and client
 * snapshots diverge during hydration). The Arkiv chain is in the network list
 * so a wallet switched there for a write is not reported as unsupported.
 */

import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { mainnet, base, optimism, arbitrum, sepolia } from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'
import { createAppKit } from '@reown/appkit/react'
import { localhost, tiramisu } from '@arkiv-network/sdk/chains'
import { env } from './env'

const localArkiv = env.arkivRpcUrl.includes('localhost') || env.arkivRpcUrl.includes('127.0.0.1')
export const arkivNetwork = (localArkiv ? localhost : tiramisu) as unknown as AppKitNetwork

export const networks = [base, mainnet, optimism, arbitrum, sepolia, arkivNetwork] as [AppKitNetwork, ...AppKitNetwork[]]

export const wagmiAdapter = new WagmiAdapter({ ssr: true, projectId: env.walletConnectProjectId || 'unset', networks })

export const wagmiConfig = wagmiAdapter.wagmiConfig

/** Shared modal (null when no WalletConnect project id is configured). */
export const modal = env.walletConnectProjectId
  ? createAppKit({
      adapters: [wagmiAdapter],
      projectId: env.walletConnectProjectId,
      networks,
      metadata: { name: 'redhaven', description: 'Token-gated boards on the Haven protocol, the 2008 way.', url: env.appUrl, icons: [] },
      themeMode: 'light',
      features: { analytics: false },
    })
  : null
