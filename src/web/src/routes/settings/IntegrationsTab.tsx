import { QboIntegrationPanel } from './QboIntegrationPanel'
import { M365IntegrationPanel } from './M365IntegrationPanel'

export function IntegrationsTab() {
  return (
    <div className="p-6 max-w-xl space-y-4">
      <h2 className="text-base font-semibold">Integrations</h2>
      <M365IntegrationPanel />
      <QboIntegrationPanel />
    </div>
  )
}
