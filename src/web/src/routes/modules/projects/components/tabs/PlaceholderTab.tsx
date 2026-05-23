import { EmptyState } from '@/components/shared/EmptyState'

export interface PlaceholderTabProps {
  module: string
  phase: number
}

export function PlaceholderTab({ module, phase }: PlaceholderTabProps) {
  return (
    <EmptyState
      title={`${module.charAt(0).toUpperCase() + module.slice(1)} module wires in Phase ${phase}`}
      body={`Once the ${module} module ships, ${module} associated with this project will appear here.`}
    />
  )
}
