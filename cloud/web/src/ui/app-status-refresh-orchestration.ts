import {
  applyAutoresearchStatusPayload,
  clearPendingPanelActionPrefix,
} from './app-extension-status.js';
import {
  haveSameFollowupQueueRows,
  normalizeFollowupQueueItems,
  type FollowupQueueItemLike,
} from './app-followup-queue.js';
import { isMainTimelineView } from './app-realtime-timeline.js';
import { getLocalStorageJSON, removeLocalStorageItem, setLocalStorageItem } from '../utils/storage.js';

type StateSetter<T> = (next: T | ((prev: T) => T)) => void;

const CONTEXT_STORAGE_PREFIX = 'piclaw:ctx:';
export const CONTEXT_SCOPE_READY_EVENT = 'piclaw:context-scope-ready';
let currentContextUserScope: string | null = null;

export function setContextUserScope(userScope: unknown): void {
  const next = typeof userScope === 'string' && userScope.trim() ? userScope.trim() : null;
  if (currentContextUserScope === next) return;
  currentContextUserScope = next;
  if (
    next
    && typeof window !== 'undefined'
    && typeof window.dispatchEvent === 'function'
  ) {
    window.dispatchEvent(new CustomEvent(CONTEXT_SCOPE_READY_EVENT, { detail: { userScope: next } }));
  }
}

export function getContextUserScope(): string | null {
  return currentContextUserScope;
}

function hasOwn(data: Record<string, unknown>, camel: string, snake?: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, camel)
    || Boolean(snake && Object.prototype.hasOwnProperty.call(data, snake));
}

function readAliased(data: Record<string, unknown>, camel: string, snake?: string): unknown {
  if (Object.prototype.hasOwnProperty.call(data, camel)) return data[camel];
  return snake ? data[snake] : undefined;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTokenUsageRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [camel, snake] of [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['cacheReadTokens', 'cache_read_tokens'],
    ['cacheWriteTokens', 'cache_write_tokens'],
    ['totalTokens', 'total_tokens'],
    ['costTotal', 'cost_total'],
    ['runs', 'runs'],
    ['cacheHitRate', 'cache_hit_rate'],
    ['turns', 'turns'],
  ] as const) {
    if (hasOwn(data, camel, snake)) result[camel] = finiteOrNull(readAliased(data, camel, snake));
  }
  for (const [camel, snake] of [
    ['model', 'model'],
    ['responseModel', 'response_model'],
    ['provider', 'provider'],
    ['api', 'api'],
    ['runAt', 'run_at'],
  ] as const) {
    if (hasOwn(data, camel, snake)) result[camel] = stringOrNull(readAliased(data, camel, snake));
  }
  return result;
}

function normalizeCacheUsage(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const latest = normalizeTokenUsageRecord(data.latest);
  const totals = normalizeTokenUsageRecord(data.totals);
  return latest || totals ? { latest, totals } : null;
}

function normalizeContextSection(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['used', 'total', 'remaining', 'percent'] as const) {
    if (hasOwn(data, key)) result[key] = finiteOrNull(data[key]);
  }
  for (const key of ['kind', 'model', 'provider'] as const) {
    if (hasOwn(data, key)) result[key] = stringOrNull(data[key]);
  }
  for (const [camel, snake] of [
    ['updatedAt', 'updated_at'],
    ['throughMessageId', 'through_message_id'],
    ['latestMessageId', 'latest_message_id'],
    ['compactedThroughMessageId', 'compacted_through_message_id'],
  ] as const) {
    if (hasOwn(data, camel, snake)) {
      result[camel] = camel === 'updatedAt'
        ? stringOrNull(readAliased(data, camel, snake))
        : finiteOrNull(readAliased(data, camel, snake));
    }
  }
  return result;
}

function normalizeDailyQuota(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['used', 'total', 'remaining', 'percent'] as const) {
    if (hasOwn(data, key)) result[key] = finiteOrNull(data[key]);
  }
  for (const [camel, snake] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens']] as const) {
    if (hasOwn(data, camel, snake)) result[camel] = finiteOrNull(readAliased(data, camel, snake));
  }
  if (hasOwn(data, 'kind')) result.kind = stringOrNull(data.kind);
  return result;
}

function normalizeSessionUsage(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const rawBySource = data.bySource ?? data.by_source;
  const bySource = rawBySource && typeof rawBySource === 'object'
    ? Object.fromEntries(Object.entries(rawBySource).map(([source, usage]) => [
        source,
        normalizeTokenUsageRecord(usage),
      ]))
    : {};
  const result: Record<string, unknown> = {};
  if (hasOwn(data, 'totals')) result.totals = normalizeTokenUsageRecord(data.totals);
  if (hasOwn(data, 'latest')) result.latest = normalizeTokenUsageRecord(data.latest);
  if (hasOwn(data, 'bySource', 'by_source')) result.bySource = bySource;
  if (hasOwn(data, 'kind')) result.kind = stringOrNull(data.kind);
  return result;
}

function mergeRecord(previous: unknown, incoming: unknown): Record<string, unknown> | null {
  if (incoming === null) return null;
  if (!incoming || typeof incoming !== 'object') {
    return previous && typeof previous === 'object' ? previous as Record<string, unknown> : null;
  }
  const prev = previous && typeof previous === 'object' ? previous as Record<string, unknown> : {};
  const next = incoming as Record<string, unknown>;
  const result = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && prev[key] && typeof prev[key] === 'object' && !Array.isArray(prev[key])
    ) {
      result[key] = mergeRecord(prev[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function normalizeContextUsage(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const context = hasOwn(data, 'context') ? normalizeContextSection(data.context) : null;
  const tokens = finiteOrNull(data.tokens) ?? finiteOrNull(context?.used);
  const contextWindow = finiteOrNull(data.contextWindow ?? data.context_window) ?? finiteOrNull(context?.total);
  const percent = finiteOrNull(data.percent) ?? finiteOrNull(context?.percent);
  const result: Record<string, unknown> = {
    tokens,
    contextWindow,
    percent,
  };
  if (context || tokens != null || contextWindow != null || percent != null) {
    result.context = {
      ...(tokens != null ? { used: tokens } : {}),
      ...(contextWindow != null ? { total: contextWindow } : {}),
      ...(percent != null ? { percent } : {}),
      ...(context ?? {}),
    };
  }
  if (hasOwn(data, 'dailyQuota', 'daily_quota')) {
    result.dailyQuota = normalizeDailyQuota(readAliased(data, 'dailyQuota', 'daily_quota'));
  }
  if (hasOwn(data, 'sessionUsage', 'session_usage')) {
    result.sessionUsage = normalizeSessionUsage(readAliased(data, 'sessionUsage', 'session_usage'));
  }
  if (hasOwn(data, 'cacheUsage', 'cache_usage')) {
    result.cacheUsage = normalizeCacheUsage(readAliased(data, 'cacheUsage', 'cache_usage'));
  }
  return result;
}

export function mergeContextUsage(previous: unknown, incoming: unknown): Record<string, unknown> | null {
  const next = normalizeContextUsage(incoming);
  if (!next) return normalizeContextUsage(previous);
  const prev = normalizeContextUsage(previous);
  return {
    tokens: next.tokens ?? prev?.tokens ?? null,
    contextWindow: next.contextWindow ?? prev?.contextWindow ?? null,
    percent: next.percent ?? prev?.percent ?? null,
    context: mergeRecord(prev?.context, next.context),
    dailyQuota: mergeRecord(prev?.dailyQuota, next.dailyQuota),
    sessionUsage: mergeRecord(prev?.sessionUsage, next.sessionUsage),
    cacheUsage: mergeRecord(prev?.cacheUsage, next.cacheUsage),
  };
}

export function haveSameContextUsage(a: unknown, b: unknown): boolean {
  const left = normalizeContextUsage(a);
  const right = normalizeContextUsage(b);
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.tokens === right.tokens
    && left.contextWindow === right.contextWindow
    && left.percent === right.percent
    && JSON.stringify(left.context ?? null) === JSON.stringify(right.context ?? null)
    && JSON.stringify(left.dailyQuota ?? null) === JSON.stringify(right.dailyQuota ?? null)
    && JSON.stringify(left.sessionUsage ?? null) === JSON.stringify(right.sessionUsage ?? null)
    && JSON.stringify(left.cacheUsage ?? null) === JSON.stringify(right.cacheUsage ?? null);
}

export function hasRenderableContextUsage(payload: unknown): boolean {
  const normalized = normalizeContextUsage(payload);
  return Boolean(normalized && (
    normalized.percent != null
    || normalized.context != null
    || normalized.dailyQuota != null
    || normalized.sessionUsage != null
    || normalized.cacheUsage != null
  ));
}

function contextStorageKey(chatJid: string, userScope: string): string {
  return `${CONTEXT_STORAGE_PREFIX}${encodeURIComponent(userScope)}:${chatJid}`;
}

export function persistContextUsage(chatJid: string, userScope: string, payload: unknown): void {
  if (!chatJid || !userScope || !payload || typeof payload !== 'object') return;
  const data = payload as Record<string, unknown>;
  if (
    data.percent == null
    && data.context == null
    && data.dailyQuota == null
    && data.sessionUsage == null
    && data.cacheUsage == null
  ) return;
  try {
    setLocalStorageItem(contextStorageKey(chatJid, userScope), JSON.stringify(payload));
  } catch (error) {
    console.debug('[app-status-refresh] Ignoring best-effort context usage persistence failure.', error, {
      chatJid,
    });
  }
}

export function restoreContextUsage(chatJid: string, userScope: string): Record<string, unknown> | null {
  if (!chatJid || !userScope) return null;
  return getLocalStorageJSON<Record<string, unknown>>(contextStorageKey(chatJid, userScope));
}

export function clearContextUsage(chatJid: string, userScope: string): void {
  if (!chatJid || !userScope) return;
  removeLocalStorageItem(contextStorageKey(chatJid, userScope));
}


interface RefBox<T> {
  current: T;
}

export interface RefreshQueueStateForChatOptions<TItem extends FollowupQueueItemLike = FollowupQueueItemLike> {
  currentChatJid: string;
  queueRefreshGenRef: RefBox<number>;
  activeChatJidRef: RefBox<string>;
  dismissedQueueRowIdsRef: RefBox<Set<string | number>>;
  getAgentQueueState: (chatJid: string) => Promise<{ items?: TItem[] | null | undefined }>;
  setFollowupQueueItems: StateSetter<TItem[]>;
  clearQueuedSteerStateIfStale: (remainingQueueCount: number) => void;
}

/**
 * Refresh follow-up queue state for the active chat, dropping stale responses.
 */
export async function refreshQueueStateForChat<TItem extends FollowupQueueItemLike = FollowupQueueItemLike>(
  options: RefreshQueueStateForChatOptions<TItem>,
): Promise<void> {
  const {
    currentChatJid,
    queueRefreshGenRef,
    activeChatJidRef,
    dismissedQueueRowIdsRef,
    getAgentQueueState,
    setFollowupQueueItems,
    clearQueuedSteerStateIfStale,
  } = options;

  const gen = ++queueRefreshGenRef.current;
  const targetChatJid = currentChatJid;

  try {
    const payload = await getAgentQueueState(targetChatJid);
    if (gen !== queueRefreshGenRef.current) return;
    if (activeChatJidRef.current !== targetChatJid) return;

    const dismissed = dismissedQueueRowIdsRef.current;
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const items = normalizeFollowupQueueItems(rawItems, dismissed);
    if (items.length) {
      setFollowupQueueItems((prev) => (haveSameFollowupQueueRows(prev, items) ? prev : items));
      return;
    }

    if (rawItems.length > 0) {
      return;
    }

    dismissed.clear();
    clearQueuedSteerStateIfStale(0);
    setFollowupQueueItems((prev) => (prev.length === 0 ? prev : []));
  } catch {
    if (gen !== queueRefreshGenRef.current) return;
    if (activeChatJidRef.current !== targetChatJid) return;
    setFollowupQueueItems((prev) => (prev.length === 0 ? prev : []));
  }
}

export interface RefreshContextUsageForChatOptions {
  currentChatJid: string;
  activeChatJidRef: RefBox<string>;
  getAgentContext: (chatJid: string) => Promise<any>;
  setContextUsage: StateSetter<any>;
}

/** Best-effort context usage refresh tied to the currently active chat. */
export async function refreshContextUsageForChat(options: RefreshContextUsageForChatOptions): Promise<void> {
  const {
    currentChatJid,
    activeChatJidRef,
    getAgentContext,
    setContextUsage,
  } = options;

  const targetChatJid = currentChatJid;
  try {
    const contextPayload = normalizeContextUsage(await getAgentContext(targetChatJid));
    if (activeChatJidRef.current !== targetChatJid) return;
    // Only update state when the server returns meaningful context/cache data.
    // After a reload or for inactive chats, the API may return empty context
    // metrics; keep restored localStorage values unless token cache telemetry
    // is available.
    if (hasRenderableContextUsage(contextPayload)) {
      setContextUsage((prev: unknown) => {
        const merged = mergeContextUsage(prev, contextPayload);
        if (!hasRenderableContextUsage(merged) || haveSameContextUsage(prev, merged)) return prev;
        const userScope = getContextUserScope();
        if (userScope) persistContextUsage(targetChatJid, userScope, merged);
        return merged;
      });
    }
  } catch (error) {
    if (activeChatJidRef.current !== targetChatJid) return;
    console.warn('Failed to fetch agent context:', error);
  }
}

export interface RefreshAutoresearchStatusForChatOptions {
  currentChatJid: string;
  activeChatJidRef: RefBox<string>;
  getAutoresearchStatus: (chatJid: string) => Promise<any>;
  setExtensionStatusPanels: StateSetter<Map<any, any>>;
  setPendingExtensionPanelActions: StateSetter<Set<string>>;
}

/** Best-effort autoresearch panel refresh tied to the currently active chat. */
export async function refreshAutoresearchStatusForChat(options: RefreshAutoresearchStatusForChatOptions): Promise<void> {
  const {
    currentChatJid,
    activeChatJidRef,
    getAutoresearchStatus,
    setExtensionStatusPanels,
    setPendingExtensionPanelActions,
  } = options;

  const targetChatJid = currentChatJid;
  try {
    const payload = await getAutoresearchStatus(targetChatJid);
    if (activeChatJidRef.current !== targetChatJid) return;
    setExtensionStatusPanels((prev) => applyAutoresearchStatusPayload(prev, payload));
    setPendingExtensionPanelActions((prev) => clearPendingPanelActionPrefix(prev, 'autoresearch'));
  } catch (error) {
    if (activeChatJidRef.current !== targetChatJid) return;
    console.warn('Failed to fetch autoresearch status:', error);
  }
}

export interface RefreshModelAndQueueStateOptions {
  refreshModelState: () => void;
  refreshActiveChatAgents: () => void;
  refreshCurrentChatBranches: () => void;
  refreshQueueState: () => void;
  refreshContextUsage: () => Promise<void> | void;
  refreshAutoresearchStatus: () => Promise<void> | void;
}

/** Run the standard model/queue/status refresh bundle used on connect/wake. */
export function refreshModelAndQueueState(options: RefreshModelAndQueueStateOptions): void {
  const {
    refreshModelState,
    refreshActiveChatAgents,
    refreshCurrentChatBranches,
    refreshQueueState,
    refreshContextUsage,
    refreshAutoresearchStatus,
  } = options;

  refreshModelState();
  refreshActiveChatAgents();
  refreshCurrentChatBranches();
  refreshQueueState();
  void refreshContextUsage();
  void refreshAutoresearchStatus();
}

export interface RefreshCurrentViewOptions {
  viewStateRef: RefBox<Record<string, unknown> | null | undefined>;
  refreshTimeline: () => Promise<void> | void;
  refreshModelAndQueueState: () => void;
}

/**
 * Refresh the current view and status panels without disturbing search/hashtag modes.
 */
export function refreshCurrentView(options: RefreshCurrentViewOptions): void {
  const {
    viewStateRef,
    refreshTimeline,
    refreshModelAndQueueState: refreshModelAndQueueStateFn,
  } = options;

  const onMainTimeline = isMainTimelineView(viewStateRef.current);
  if (onMainTimeline) {
    void refreshTimeline();
  }
  refreshModelAndQueueStateFn();
}
