import { useSearchParams } from 'react-router-dom'

export type ArtifactFilterId =
  | 'all'
  | 'drafts'
  | 'ready'
  | 'issued'
  | 'accepted'
  | 'rejected'
  | 'superseded'

export const FILTER_TO_DISPLAY_STATUS: Record<ArtifactFilterId, string[] | undefined> = {
  all: undefined,
  drafts: ['Estimate · draft', 'Proposal · draft'],
  ready: ['Estimate · ready'],
  issued: ['Proposal · issued'],
  accepted: ['Estimate · accepted', 'Proposal · accepted'],
  rejected: ['Estimate · rejected', 'Proposal · rejected'],
  superseded: ['Estimate · superseded', 'Proposal · superseded'],
}

export function isArtifactFilter(s: string | null): s is ArtifactFilterId {
  return (
    s === 'drafts' ||
    s === 'ready' ||
    s === 'issued' ||
    s === 'accepted' ||
    s === 'rejected' ||
    s === 'superseded'
  )
}

export function useProposalDeepLink() {
  const [search, setSearch] = useSearchParams()
  const filterParam = search.get('filter')
  const filter: ArtifactFilterId = isArtifactFilter(filterParam) ? filterParam : 'all'
  const projectId = search.get('project')

  function setFilter(next: ArtifactFilterId | null): void {
    const updated = new URLSearchParams(search)
    if (next === null || next === 'all') updated.delete('filter')
    else updated.set('filter', next)
    setSearch(updated, { replace: true })
  }

  return { filter, projectId, setFilter, search, setSearch }
}
