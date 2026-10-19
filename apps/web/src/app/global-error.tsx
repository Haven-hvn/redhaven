'use client'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'verdana, arial, helvetica, sans-serif', fontSize: 13, padding: 24 }}>
        <h1 style={{ fontSize: 18 }}>something broke</h1>
        <p>{error.message}</p>
        <p>
          <button type="button" onClick={reset}>try again</button>
        </p>
        <p style={{ color: '#888' }}>Nothing of yours was lost: posts live on Arkiv, votes in this browser's storage.</p>
      </body>
    </html>
  )
}
