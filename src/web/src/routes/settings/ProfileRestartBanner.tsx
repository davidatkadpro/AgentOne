export function ProfileRestartBanner() {
  return (
    <div className="bg-warn/10 border-b border-warn/30 px-6 py-2 text-xs text-warn">
      Changes apply on the next server restart — the running orchestrator still
      uses the in-memory boot copy until then.
    </div>
  )
}
