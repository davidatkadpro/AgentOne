import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

interface HookEntry {
  event: string
  handler: string
  description: string | null
  enabled: boolean
}

interface HooksResponse {
  hooks: HookEntry[]
  configPath: string | null
  error?: string
}

function useHooks() {
  return useQuery({
    queryKey: ['hooks', 'list'] as const,
    queryFn: () => api.get<HooksResponse>('/hooks'),
    staleTime: 30_000,
  })
}

export function HooksTab() {
  const { data, isLoading } = useHooks()

  return (
    <div className="p-6 max-w-2xl" data-testid="hooks-tab">
      <h2 className="text-base font-semibold mb-3">Hooks</h2>
      <div className="text-xs text-muted bg-surface border border-border rounded-md p-3 mb-4">
        Hook editing lives in the YAML file pointed to by{' '}
        <code className="font-mono">EVENT_HOOKS_PATH</code> — this view is read-only in v2.
        Add or modify hooks by editing the file directly and restarting the server.
      </div>
      {isLoading ? (
        <div className="text-xs text-muted">Loading hooks…</div>
      ) : !data ? (
        <div className="text-xs text-muted">No hook data.</div>
      ) : data.configPath === null ? (
        <div className="text-xs text-muted">
          <code className="font-mono">EVENT_HOOKS_PATH</code> is not set — no hooks are
          configured. Set it to a YAML file path and restart the server to enable hooks.
        </div>
      ) : data.hooks.length === 0 ? (
        <div className="text-xs text-muted">
          No hooks declared in <code className="font-mono">{data.configPath}</code>.
        </div>
      ) : (
        <>
          <div className="text-[10px] text-muted mb-2 font-mono break-all">
            {data.configPath}
          </div>
          <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[420px] text-xs" data-testid="hooks-table">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="py-1 pr-2 font-normal w-32">Event</th>
                <th className="py-1 pr-2 font-normal">Handler</th>
                <th className="py-1 pr-2 font-normal w-20 text-right">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {data.hooks.map((h, i) => (
                <tr
                  key={`${h.event}-${h.handler}-${i}`}
                  className="border-b border-border/50"
                  data-testid="hook-row"
                >
                  <td className="py-1 pr-2 font-mono">{h.event}</td>
                  <td className="py-1 pr-2">
                    <span className="font-mono">{h.handler}</span>
                    {h.description ? (
                      <div className="text-[10px] text-muted">{h.description}</div>
                    ) : null}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {h.enabled ? (
                      <span className="text-emerald-600 dark:text-emerald-400">yes</span>
                    ) : (
                      <span className="text-muted">no</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
      {data?.error ? (
        <div className="mt-3 text-xs text-danger">
          Error reading hooks: {data.error}
        </div>
      ) : null}
    </div>
  )
}
