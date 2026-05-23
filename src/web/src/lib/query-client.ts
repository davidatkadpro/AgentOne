import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: { retry: 0 },
  },
})

export const queryKeys = {
  health: () => ['health'] as const,
  sessions: {
    all: () => ['sessions'] as const,
    list: () => ['sessions', 'list'] as const,
    detail: (id: string) => ['sessions', 'detail', id] as const,
  },
  profiles: {
    all: () => ['profiles'] as const,
    list: () => ['profiles', 'list'] as const,
  },
  drafts: {
    list: () => ['drafts', 'list'] as const,
  },
  commands: {
    list: () => ['commands', 'list'] as const,
  },
  notifications: {
    all: () => ['notifications'] as const,
    list: (opts?: { includeResolved?: boolean }) =>
      ['notifications', 'list', opts?.includeResolved ?? false] as const,
  },
  skills: {
    list: () => ['skills', 'list'] as const,
  },
  moduleActions: {
    list: (module: string) => ['module-actions', module] as const,
  },
} as const
