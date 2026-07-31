import { useCallback } from '../vendor/preact-htm.js';
import { handleMessageResponseRefresh } from './app-auth-bootstrap.js';
import { applyAgentAbortResponse, applyOptimisticAgentAbort } from './app-agent-abort.js';
import {
  handleInjectQueuedFollowupAction,
  handleRemoveQueuedFollowupAction,
} from './app-floating-widget-followup.js';

type StateSetter<T> = (next: T | ((prev: T) => T)) => void;

interface RefBox<T> {
  current: T;
}

interface ToastFn {
  (title: string, detail?: string | null, kind?: string, durationMs?: number): void;
}

export interface UseFollowupActionsOrchestrationOptions {
  currentChatJid: string;
  followupQueueItemsRef: RefBox<any[]>;
  dismissedQueueRowIdsRef: RefBox<Set<string | number>>;
  refreshQueueState: () => Promise<void>;
  setFollowupQueueItems: StateSetter<any[]>;
  showIntentToast: ToastFn;
  clearQueuedSteerStateIfStale: () => void;
  steerAgentQueueItem: (...args: any[]) => Promise<any>;
  removeAgentQueueItem: (...args: any[]) => Promise<any>;
  refreshActiveChatAgents: () => Promise<void>;
  refreshCurrentChatBranches: () => Promise<void>;
  refreshContextUsage: () => Promise<void>;
  refreshAutoresearchStatus: () => Promise<void>;
  clearAgentRunState: () => void;
  setAgentDraft: StateSetter<any>;
  setAgentStatus: StateSetter<any>;
  setAgentPlan: StateSetter<any>;
  setAgentThought: StateSetter<any>;
  clearCloudAgentQuestion?: () => void;
  wasAgentActiveRef: RefBox<boolean>;
}

interface QueueActionContext {
  queuedItem: any;
  followupQueueItemsRef: RefBox<any[]>;
  dismissedQueueRowIdsRef: RefBox<Set<string | number>>;
  currentChatJid: string;
  refreshQueueState: () => Promise<void>;
  setFollowupQueueItems: StateSetter<any[]>;
  showIntentToast: ToastFn;
  clearQueuedSteerStateIfStale?: () => void;
  steerAgentQueueItem: (...args: any[]) => Promise<any>;
  removeAgentQueueItem: (...args: any[]) => Promise<any>;
}

export function runInjectQueuedFollowup(
  context: QueueActionContext,
  action: (options: QueueActionContext) => void = handleInjectQueuedFollowupAction,
): void {
  action(context);
}

export function runRemoveQueuedFollowup(
  context: QueueActionContext,
  action: (options: QueueActionContext) => void = handleRemoveQueuedFollowupAction,
): void {
  action(context);
}

export function runMessageResponseRefresh(
  response: any,
  context: {
    refreshActiveChatAgents: () => Promise<void>;
    refreshCurrentChatBranches: () => Promise<void>;
    refreshContextUsage: () => Promise<void>;
    refreshAutoresearchStatus: () => Promise<void>;
    refreshQueueState: () => Promise<void>;
  },
  action: (options: Record<string, unknown>) => void = handleMessageResponseRefresh,
): void {
  action({
    response,
    refreshActiveChatAgents: context.refreshActiveChatAgents,
    refreshCurrentChatBranches: context.refreshCurrentChatBranches,
    refreshContextUsage: context.refreshContextUsage,
    refreshAutoresearchStatus: context.refreshAutoresearchStatus,
    refreshQueueState: context.refreshQueueState,
  });
}

export function useFollowupActionsOrchestration(options: UseFollowupActionsOrchestrationOptions) {
  const {
    currentChatJid,
    followupQueueItemsRef,
    dismissedQueueRowIdsRef,
    refreshQueueState,
    setFollowupQueueItems,
    showIntentToast,
    clearQueuedSteerStateIfStale,
    steerAgentQueueItem,
    removeAgentQueueItem,
    refreshActiveChatAgents,
    refreshCurrentChatBranches,
    refreshContextUsage,
    refreshAutoresearchStatus,
    clearAgentRunState,
    setAgentDraft,
    setAgentStatus,
    setAgentPlan,
    setAgentThought,
    clearCloudAgentQuestion,
    wasAgentActiveRef,
  } = options;

  const abortAgentOptions = {
    clearAgentRunState,
    setAgentDraft,
    setAgentStatus,
    setAgentPlan,
    setAgentThought,
    clearCloudAgentQuestion,
    wasAgentActiveRef,
  };

  const handleAbortAgent = useCallback(() => {
    applyOptimisticAgentAbort(abortAgentOptions);
  }, [
    clearAgentRunState,
    clearCloudAgentQuestion,
    setAgentDraft,
    setAgentPlan,
    setAgentStatus,
    setAgentThought,
    wasAgentActiveRef,
  ]);

  const handleInjectQueuedFollowup = useCallback((queuedItem: any) => {
    runInjectQueuedFollowup({
      queuedItem,
      followupQueueItemsRef,
      dismissedQueueRowIdsRef,
      currentChatJid,
      refreshQueueState,
      setFollowupQueueItems,
      showIntentToast,
      steerAgentQueueItem,
      removeAgentQueueItem,
    });
  }, [currentChatJid, dismissedQueueRowIdsRef, followupQueueItemsRef, refreshQueueState, removeAgentQueueItem, setFollowupQueueItems, showIntentToast, steerAgentQueueItem]);

  const handleRemoveQueuedFollowup = useCallback((queuedItem: any) => {
    runRemoveQueuedFollowup({
      queuedItem,
      followupQueueItemsRef,
      dismissedQueueRowIdsRef,
      currentChatJid,
      refreshQueueState,
      setFollowupQueueItems,
      showIntentToast,
      clearQueuedSteerStateIfStale,
      steerAgentQueueItem,
      removeAgentQueueItem,
    });
  }, [clearQueuedSteerStateIfStale, currentChatJid, dismissedQueueRowIdsRef, followupQueueItemsRef, refreshQueueState, removeAgentQueueItem, setFollowupQueueItems, showIntentToast, steerAgentQueueItem]);

  const handleMoveQueuedFollowup = useCallback(async (fromIndex: number, toIndex: number) => {
    // Optimistic local reorder
    setFollowupQueueItems((prev: any[]) => {
      if (!Array.isArray(prev) || fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    // Persist to backend
    try {
      const { reorderAgentQueueItem } = await import('../api.js');
      await reorderAgentQueueItem(fromIndex, toIndex, currentChatJid);
    } catch (error) {
      console.warn('Failed to persist queue reorder:', error);
      // Refresh from backend to restore correct state
      void refreshQueueState();
    }
  }, [currentChatJid, refreshQueueState, setFollowupQueueItems]);

  const handleMessageResponse = useCallback((response: any) => {
    applyAgentAbortResponse(response, abortAgentOptions);
    runMessageResponseRefresh(response, {
      refreshActiveChatAgents,
      refreshCurrentChatBranches,
      refreshContextUsage,
      refreshAutoresearchStatus,
      refreshQueueState,
    });
  }, [
    clearAgentRunState,
    clearCloudAgentQuestion,
    refreshActiveChatAgents,
    refreshAutoresearchStatus,
    refreshContextUsage,
    refreshCurrentChatBranches,
    refreshQueueState,
    setAgentDraft,
    setAgentPlan,
    setAgentStatus,
    setAgentThought,
    wasAgentActiveRef,
  ]);

  return {
    handleInjectQueuedFollowup,
    handleRemoveQueuedFollowup,
    handleMoveQueuedFollowup,
    handleMessageResponse,
    handleAbortAgent,
  };
}
