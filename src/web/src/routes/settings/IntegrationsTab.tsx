export function IntegrationsTab() {
  return (
    <div className="p-6 max-w-xl">
      <h2 className="text-base font-semibold mb-3">Integrations</h2>
      <div className="p-4 bg-surface border border-border rounded-md flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-fg">QuickBooks Online</div>
          <div className="text-xs text-muted">Not connected</div>
        </div>
        <button
          disabled
          className="h-9 px-3 text-sm rounded-md bg-bg border border-border text-muted cursor-not-allowed"
          title="Available in Phase 5"
        >
          Connect (Phase 5)
        </button>
      </div>
    </div>
  )
}
