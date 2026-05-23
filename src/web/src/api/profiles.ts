import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type {
  ListProfilesResponse,
  CreateProfileRequest,
  CreateProfileResponse,
  UpdateProfileRequest,
  UpdateProfileResponse,
  DeleteProfileResponse,
} from '@/types/api'

export function useProfiles() {
  return useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: () => api.get<ListProfilesResponse>('/profiles'),
  })
}

export function useCreateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateProfileRequest) =>
      api.post<CreateProfileResponse>('/profiles', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.profiles.list() })
    },
  })
}

export function useUpdateProfile(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) =>
      api.patch<UpdateProfileResponse>(`/profiles/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.profiles.list() })
    },
  })
}

export function useDeleteProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<DeleteProfileResponse>(`/profiles/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.profiles.list() })
    },
  })
}
