export function HooksTab() {
  return (
    <div className="p-6 max-w-xl">
      <h2 className="text-base font-semibold mb-3">Hooks</h2>
      <div className="text-xs text-muted bg-surface border border-border rounded-md p-3">
        Hook editing lives in <code className="font-mono">settings.json</code> — this view is read-only in v2.
        Add or modify hooks by editing the file directly and restarting the server.
      </div>
      <p className="text-[10px] text-muted mt-3">
        A read-only listing of configured hooks will appear here once the server exposes <code className="font-mono">GET /api/hooks</code>.
      </p>
    </div>
  )
}
