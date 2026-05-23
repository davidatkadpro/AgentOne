import { ModulePanel } from '@/components/module/ModulePanel'
import { EmptyState } from '@/components/shared/EmptyState'

export interface ModuleStubProps {
  module: string
  phase: number
}

export function ModuleStub({ module, phase }: ModuleStubProps) {
  return (
    <ModulePanel
      list={
        <div className="p-4 text-xs text-muted">
          Content for <code className="font-mono">/{module}</code> ships in Phase {phase}.
        </div>
      }
      detail={null}
      emptyState={<EmptyState title={`Coming in Phase ${phase}`} body={`The ${module} panel will live here.`} />}
    />
  )
}
