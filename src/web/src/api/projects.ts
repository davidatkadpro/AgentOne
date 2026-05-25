import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type {
  AddDependencyRequest,
  AddDependencyResponse,
  AddPhaseRequest,
  AddPhaseResponse,
  AddTaskRequest,
  AddTaskResponse,
  AttachTaskFileRequest,
  AttachTaskFileResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  DetachTaskFileRequest,
  ListProjectsResponse,
  ListTaskFilesResponse,
  NextProjectNumberResponse,
  ProjectActivityResponse,
  ProjectDetailResponse,
  ProjectFilesResponse,
  ProjectScopeResponse,
  UpdatePhaseRequest,
  UpdatePhaseResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  UpdateProjectStatusRequest,
  UpdateProjectStatusResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
} from '@/types/api'
import type { EntityStatus } from '@/types/domain'

export function useProjects(status?: EntityStatus[]) {
  const qs = status && status.length > 0 ? `?${status.map((s) => `status=${s}`).join('&')}` : ''
  return useQuery({
    queryKey: queryKeys.projects.list(status ?? null),
    queryFn: () => api.get<ListProjectsResponse>(`/projects${qs}`).then((r) => r.projects),
  })
}

export function useProject(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.projects.detail(id ?? ''),
    queryFn: () => api.get<ProjectDetailResponse>(`/projects/${id}`),
    enabled: !!id,
  })
}

// useProjectBudget moved to @/api/invoicing — Phase 5 unified the budget
// shape on the invoicing module's endpoint. Re-export so existing imports
// keep working.
export { useProjectBudget } from './invoicing'

export function useProjectScope(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.projects.scope(id ?? ''),
    queryFn: () => api.get<ProjectScopeResponse>(`/projects/${id}/scope`),
    enabled: !!id,
    staleTime: 5 * 60_000,
  })
}

export function useProjectFiles(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.projects.files(id ?? ''),
    queryFn: () => api.get<ProjectFilesResponse>(`/projects/${id}/files`),
    enabled: !!id,
    staleTime: 5 * 60_000,
  })
}

export function useProjectActivity(id: string | null | undefined, opts: { limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.offset !== undefined) params.set('offset', String(opts.offset))
  const qs = params.size ? `?${params.toString()}` : ''
  return useQuery({
    queryKey: queryKeys.projects.activity(id ?? '', opts.offset),
    queryFn: () => api.get<ProjectActivityResponse>(`/projects/${id}/activity${qs}`),
    enabled: !!id,
  })
}

export function useNextProjectNumber(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projects.nextNumber(),
    queryFn: () => api.get<NextProjectNumberResponse>('/projects/next-number'),
    enabled,
    staleTime: 0,
  })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      api.post<CreateProjectResponse>('/projects', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.all() })
    },
  })
}

export function useUpdateProjectStatus(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateProjectStatusRequest) =>
      api.patch<UpdateProjectStatusResponse>(`/projects/${projectId}/status`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.list() })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.activity(projectId) })
    },
  })
}

export function useUpdateProject(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) =>
      api.patch<UpdateProjectResponse>(`/projects/${projectId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.list() })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.activity(projectId) })
    },
    onError: (err) => {
      toast.error(`Project update failed: ${err instanceof Error ? err.message : String(err)}`)
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
  })
}

export function useAddPhase(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AddPhaseRequest) =>
      api.post<AddPhaseResponse>(`/projects/${projectId}/phases`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.activity(projectId) })
    },
  })
}

export function useUpdatePhase(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ phaseId, body }: { phaseId: string; body: UpdatePhaseRequest }) =>
      api.patch<UpdatePhaseResponse>(`/phases/${phaseId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.activity(projectId) })
    },
    onError: (err) => {
      toast.error(`Phase update failed: ${err instanceof Error ? err.message : String(err)}`)
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
  })
}

export function useAddTask(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AddTaskRequest) =>
      api.post<AddTaskResponse>(`/projects/${projectId}/tasks`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.activity(projectId) })
    },
  })
}

export function useUpdateTask(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: UpdateTaskRequest }) =>
      api.patch<UpdateTaskResponse>(`/tasks/${taskId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.activity(projectId) })
    },
    onError: (err) => {
      toast.error(`Task update failed: ${err instanceof Error ? err.message : String(err)}`)
      // Force a refetch so the UI snaps back to server truth.
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
  })
}

export function useAddDependency(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: AddDependencyRequest }) =>
      api.post<AddDependencyResponse>(`/tasks/${taskId}/dependencies`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
    onError: (err) => {
      // Cycle errors get surfaced inline by the caller — only toast on other
      // failures so we don't double-render the message.
      if (!(err instanceof ApiError) || err.code !== 'TASK_DEPENDENCY_CYCLE') {
        toast.error(`Dependency add failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })
}

export function useRemoveDependency(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, dependsOnTaskId }: { taskId: string; dependsOnTaskId: string }) =>
      api.delete<{ ok: true }>(`/tasks/${taskId}/dependencies/${dependsOnTaskId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
  })
}

export function useTaskFiles(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ['task-files', taskId ?? ''],
    queryFn: () => api.get<ListTaskFilesResponse>(`/tasks/${taskId}/files`).then((r) => r.files),
    enabled: !!taskId,
  })
}

export function useAttachTaskFile(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: AttachTaskFileRequest }) =>
      api.post<AttachTaskFileResponse>(`/tasks/${taskId}/files`, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: ['task-files', vars.taskId] })
    },
    onError: (err) => {
      toast.error(`Attach file failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function useDetachTaskFile(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: DetachTaskFileRequest }) =>
      api.delete<{ ok: true }>(`/tasks/${taskId}/files`, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
      void qc.invalidateQueries({ queryKey: ['task-files', vars.taskId] })
    },
  })
}
