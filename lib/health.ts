// Request-count backoff keeps routing deterministic without assuming a refusal is permanent.
export class ProviderHealth {
  private failures = new Map<string, { count: number; retryAt: number }>();

  cooling(provider: string, request: number): boolean {
    return (this.failures.get(provider)?.retryAt ?? 0) > request;
  }

  refused(provider: string, request: number): void {
    const count = Math.min(6, (this.failures.get(provider)?.count ?? 0) + 1);
    this.failures.set(provider, { count, retryAt: request + 2 ** count });
  }

  recovered(provider: string): void {
    this.failures.delete(provider);
  }
}
