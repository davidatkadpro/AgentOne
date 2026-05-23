import { create } from 'zustand'

type Theme = 'light' | 'dark' | 'system'
type SettingsTab = 'profiles' | 'theme' | 'hooks' | 'integrations'

const THEME_KEY = 'agentone:theme'

function readStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'system'
  const v = localStorage.getItem(THEME_KEY)
  if (v === 'light' || v === 'dark' || v === 'system') return v
  return 'system'
}

export function applyThemeToDocument(theme: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'system') {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
    root.classList.toggle('dark', !!dark)
  } else {
    root.classList.toggle('dark', theme === 'dark')
  }
}

interface UiState {
  theme: Theme
  setTheme(theme: Theme): void
  trayOpen: boolean
  setTrayOpen(open: boolean): void
  newChatDialogOpen: boolean
  setNewChatDialogOpen(open: boolean): void
  settingsTab: SettingsTab
  setSettingsTab(tab: SettingsTab): void
}

export const useUiStore = create<UiState>((set) => ({
  theme: readStoredTheme(),
  setTheme(theme) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, theme)
    applyThemeToDocument(theme)
    set({ theme })
  },
  trayOpen: false,
  setTrayOpen(open) {
    set({ trayOpen: open })
  },
  newChatDialogOpen: false,
  setNewChatDialogOpen(open) {
    set({ newChatDialogOpen: open })
  },
  settingsTab: 'profiles',
  setSettingsTab(tab) {
    set({ settingsTab: tab })
  },
}))
