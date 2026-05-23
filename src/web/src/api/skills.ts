import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'

export interface SkillListEntry {
  qualifiedName: string
  name: string
  category: string
  description: string
  slashCommand: string | null
  allowedTools: string[]
  body: string
}

interface ListSkillsResponse {
  skills: SkillListEntry[]
}

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills.list(),
    queryFn: () => api.get<ListSkillsResponse>('/skills').then((r) => r.skills),
  })
}
