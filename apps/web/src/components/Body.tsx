'use client'

import { segmentLine } from '@fairhaven/board-core'

/** Plain text with clickable URLs. No markdown (nothing on Arkiv promises markdown). */
export function Body({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return (
    <div className={`md${className ? ` ${className}` : ''}`}>
      {lines.map((line, i) => (
        <p key={i}>
          {segmentLine(line, []).map((s, j) =>
            s.kind === 'url' ? (
              <a key={j} href={s.href} target="_blank" rel="noreferrer noopener nofollow">{s.href}</a>
            ) : s.kind === 'quote' ? (
              <span key={j}>{`>>${s.short}`}</span>
            ) : (
              <span key={j}>{s.text}</span>
            ),
          )}
          {line === '' ? '\u00a0' : null}
        </p>
      ))}
    </div>
  )
}
