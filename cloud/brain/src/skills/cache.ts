import type { SkillCatalogEntry } from "./registry.ts";

const catalogCache = new Map<string, SkillCatalogEntry[]>();

export function getCachedCatalog(userId: string): SkillCatalogEntry[] | null {
  return catalogCache.get(userId) ?? null;
}

export function setCachedCatalog(userId: string, catalog: SkillCatalogEntry[]): void {
  catalogCache.set(userId, catalog);
}

export function invalidateSkillCache(userId?: string): void {
  if (userId) {
    catalogCache.delete(userId);
    return;
  }
  catalogCache.clear();
}

export function resetSkillCacheForTests(): void {
  catalogCache.clear();
}
