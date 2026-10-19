'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { cookieToInitialState, WagmiProvider, useAccount, type Config } from 'wagmi'
import { wagmiConfig } from '@/lib/wallet'
import { loadPersisted, persistQueryCache } from '@/lib/persist'
import { forgetKeys } from '@/lib/aol'
import { clearOpened } from '@/lib/media'
import { forgetLiveSessions } from '@/lib/votes/sessions'

function getClientCookies(): string | null {
  return typeof document !== 'undefined' ? document.cookie || null : null
}

/** Drop every decrypted byte and in-memory key when the wallet goes away or changes. */
function SecurityCleanup() {
  const { address, isConnected } = useAccount()
  useEffect(() => {
    if (!isConnected) {
      forgetKeys()
      clearOpened()
      forgetLiveSessions()
    }
  }, [isConnected, address])
  return null
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: (count, e) => count < 1 && !(e instanceof Error && (e.name === 'RateLimitError' || /\b429\b|ANON_COST_LIMITED/.test(e.message))) } } })
    loadPersisted(c)
    return c
  })
  const [initialState] = useState(() => cookieToInitialState(wagmiConfig as Config, getClientCookies()))
  useEffect(() => persistQueryCache(qc), [qc])
  return (
    <WagmiProvider config={wagmiConfig as Config} initialState={initialState}>
      <QueryClientProvider client={qc}>
        <SecurityCleanup />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
