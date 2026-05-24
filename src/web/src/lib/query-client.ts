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
  projects: {
    all: () => ['projects'] as const,
    list: (status?: string[] | null) =>
      ['projects', 'list', status ?? null] as const,
    detail: (id: string) => ['projects', 'detail', id] as const,
    budget: (id: string) => ['projects', 'budget', id] as const,
    scope: (id: string) => ['projects', 'scope', id] as const,
    files: (id: string) => ['projects', 'files', id] as const,
    activity: (id: string, offset?: number) =>
      ['projects', 'activity', id, offset ?? 0] as const,
    nextNumber: () => ['projects', 'next-number'] as const,
  },
  emails: {
    all: () => ['emails'] as const,
    list: (opts?: Record<string, unknown>) => ['emails', 'list', opts ?? {}] as const,
    detail: (id: string) => ['emails', 'detail', id] as const,
    body: (id: string) => ['emails', 'body', id] as const,
  },
  proposals: {
    all: () => ['proposals'] as const,
    artifacts: (opts?: Record<string, unknown>) =>
      ['proposals', 'artifacts', opts ?? {}] as const,
    detail: (id: string) => ['proposals', 'detail', id] as const,
    history: (id: string) => ['proposals', 'history', id] as const,
    templates: () => ['proposals', 'templates'] as const,
    scopeFiles: (projectId: string) => ['proposals', 'scope-files', projectId] as const,
  },
  estimates: {
    detail: (id: string) => ['estimates', 'detail', id] as const,
  },
  invoices: {
    all: () => ['invoices'] as const,
    list: (opts?: Record<string, unknown>) => ['invoices', 'list', opts ?? {}] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
  },
  qbo: {
    status: () => ['qbo', 'status'] as const,
  },
} as const
