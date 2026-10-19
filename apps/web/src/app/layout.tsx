import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import { Providers } from '@/components/Providers'

export const metadata: Metadata = {
  title: 'redhaven',
  description: 'Token-gated subreddits on the Haven protocol. Posts live on Arkiv and Filecoin; votes travel between readers.',
  icons: { icon: '/icon.svg' },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
        <div className="footer-parent">
          <div className="footer">
            <p className="bottommenu">
              redhaven is a Haven protocol client. Submissions and comments are Arkiv entities (<code>haven.board.*</code>) readable by any Haven app; votes are off-chain and shared only between redhaven readers.{' '}
              <a href="https://github.com/Haven-hvn" target="_blank" rel="noreferrer noopener">source</a>
            </p>
          </div>
        </div>
      </body>
    </html>
  )
}
