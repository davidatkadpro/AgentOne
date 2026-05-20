import type { Provider } from './base.js'

/**
 * Registry of configured providers keyed by their `id` ('lmstudio',
 * 'openrouter', ...). The server bootstrap constructs each available
 * provider and registers it; downstream consumers (orchestrator, consult_expert)
 * look up the provider for a given Model Profile via `get(modelProfile.provider)`.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>()

  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  /** Returns the provider, or throws with a clear message naming who's missing. */
  get(id: string): Provider {
    const p = this.providers.get(id)
    if (!p) {
      throw new Error(
        `No provider registered for id "${id}". ` +
          `Registered: ${[...this.providers.keys()].join(', ') || '(none)'}`,
      )
    }
    return p
  }

  /** Soft variant — returns undefined when missing. Useful for optional features. */
  find(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  ids(): string[] {
    return [...this.providers.keys()]
  }
}
