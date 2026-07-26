import type { ProviderStatusSource } from "./types.ts";

export class ProviderStatusRegistry {
  readonly #sources = new Map<string, ProviderStatusSource>();

  register(source: ProviderStatusSource): void {
    this.#sources.set(source.id, source);
  }

  get(id: string): ProviderStatusSource | undefined {
    return this.#sources.get(id);
  }

  findForProvider(providerId: string): ProviderStatusSource[] {
    return this.list().filter((source) => source.supports(providerId));
  }

  list(): ProviderStatusSource[] {
    return Array.from(this.#sources.values());
  }
}
