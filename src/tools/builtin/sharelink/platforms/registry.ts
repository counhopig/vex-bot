/**
 * Platform registry — holds adapters and resolves the first match.
 *
 * Zero module-level mutable state; each PlatformRegistry is instantiated
 * per share-link factory call.
 */

import { BasePlatformAdapter } from "./base.js";

export class PlatformRegistry {
  private readonly adapters: BasePlatformAdapter[] = [];

  register(adapter: BasePlatformAdapter): void {
    this.adapters.push(adapter);
  }

  unregister(name: string): boolean {
    const idx = this.adapters.findIndex((a) => a.name === name);
    if (idx >= 0) {
      this.adapters.splice(idx, 1);
      return true;
    }
    return false;
  }

  match(url: string): BasePlatformAdapter | undefined {
    for (const adapter of this.adapters) {
      if (adapter.match(url)) {
        return adapter;
      }
    }
    return undefined;
  }

  get platforms(): readonly string[] {
    return this.adapters.map((a) => a.name);
  }
}
