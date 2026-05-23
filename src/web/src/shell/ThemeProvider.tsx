import { useEffect } from 'react'
import { applyThemeToDocument, useUiStore } from '@/stores/ui'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useUiStore((s) => s.theme)
  useEffect(() => {
    applyThemeToDocument(theme)
  }, [theme])
  useEffect(() => {
    if (theme !== 'system') return
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = () => applyThemeToDocument('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])
  return <>{children}</>
}
