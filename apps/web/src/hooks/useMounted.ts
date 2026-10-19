'use client'

import { useEffect, useState } from 'react'

/** False during SSR and the first client render; wallet state must not influence markup before this. */
export function useMounted(): boolean {
  const [m, setM] = useState(false)
  useEffect(() => setM(true), [])
  return m
}
