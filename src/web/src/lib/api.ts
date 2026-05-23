import type { ApiErrorBody } from '@/types/api'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error)
    this.status = status
    this.code = body.error
    this.details = body.details
    this.name = 'ApiError'
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'

async function request<TResponse>(
  method: Method,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<TResponse> {
  const url = path.startsWith('/api') ? path : `/api${path}`
  const headers: Record<string, string> = { Accept: 'application/json', ...(init?.headers as Record<string, string>) }
  let payload: BodyInit | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(url, { ...init, method, headers, body: payload })
  if (!res.ok) {
    let errBody: ApiErrorBody
    try {
      errBody = (await res.json()) as ApiErrorBody
    } catch {
      errBody = { error: `HTTP_${res.status}`, message: res.statusText }
    }
    throw new ApiError(res.status, errBody)
  }
  if (res.status === 204) return undefined as TResponse
  return (await res.json()) as TResponse
}

export const api = {
  get<T>(path: string, init?: RequestInit) {
    return request<T>('GET', path, undefined, init)
  },
  post<T>(path: string, body?: unknown, init?: RequestInit) {
    return request<T>('POST', path, body, init)
  },
  patch<T>(path: string, body?: unknown, init?: RequestInit) {
    return request<T>('PATCH', path, body, init)
  },
  delete<T>(path: string, init?: RequestInit) {
    return request<T>('DELETE', path, undefined, init)
  },
}
