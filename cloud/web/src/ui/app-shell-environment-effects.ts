import { useCallback, useEffect, useRef } from '../vendor/preact-htm.js';
import { setLocalStorageItem } from '../utils/storage.js';
import {
  DESKTOP_WORKSPACE_LAYOUT_MEDIA_QUERY,
  persistWorkspaceOpenPreference,
  resolveWorkspaceLayoutBucket,
  shouldAutoRevealWorkspaceForSandboxBinding,
  shouldAutoRevealWorkspaceOnAvailabilityChange,
} from './workspace-visibility.js';
import { initTheme, reapplyStoredTheme } from './theme.js';
import { useTimestampRefresh } from './app-helpers.js';
import { watchReturnToApp, watchStandaloneWebAppMode } from './app-resume.js';
import { installStandaloneMobileViewportFix } from './mobile-viewport.js';
import { BTW_SESSION_KEY } from './app-shell-state.js';

interface RefBox<T> {
  current: T;
}

export const RESUME_LAYOUT_SETTLING_CLASS = 'resume-layout-settling';
export const RESUME_LAYOUT_SETTLING_MS = 220;

const resumeLayoutSettlingTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export interface UseAppShellEnvironmentEffectsOptions {
  isRenameBranchFormOpen: boolean;
  renameBranchNameInputRef: RefBox<any>;
  appShellRef: RefBox<HTMLElement | null>;
  setIsWebAppMode: (next: boolean) => void;
  workspaceOpen: boolean;
  workspaceAvailable?: boolean;
  currentBranchSandboxId?: string | null;
  setWorkspaceOpen: (next: boolean) => void;
  btwSession: any;
  agents: Record<string, unknown> | null | undefined;
  agentsRef: RefBox<Record<string, unknown>>;
  currentChatJid: string;
  activeChatJidRef: RefBox<string>;
  userProfile: any;
  userProfileRef: RefBox<any>;
  brandingRef: RefBox<{ title: string | null; avatarBase: string | null }>;
  panePopoutMode?: boolean;
}

export function persistBtwSession(btwSession: any): void {
  if (!btwSession) {
    setLocalStorageItem(BTW_SESSION_KEY, '');
    return;
  }

  setLocalStorageItem(BTW_SESSION_KEY, JSON.stringify({
    question: btwSession.question || '',
    answer: btwSession.answer || '',
    thinking: btwSession.thinking || '',
    error: btwSession.error || null,
    status: btwSession.status || 'success',
  }));
}

export function shouldApplyBrandingDocumentTitle(options: {
  panePopoutMode?: boolean;
  search?: string | null;
} = {}): boolean {
  if (options.panePopoutMode) return false;
  const search = typeof options.search === 'string' ? options.search : '';
  return !/(?:^|[?&])pane_popout=1(?:&|$)/.test(search);
}

export function scheduleResumeLayoutSettling(
  element: HTMLElement | null | undefined,
  options: {
    durationMs?: number;
    scheduleTimeout?: typeof setTimeout;
    clearScheduledTimeout?: typeof clearTimeout;
  } = {},
): () => void {
  if (!element) return () => {};

  const {
    durationMs = RESUME_LAYOUT_SETTLING_MS,
    scheduleTimeout = setTimeout,
    clearScheduledTimeout = clearTimeout,
  } = options;

  const previous = resumeLayoutSettlingTimers.get(element);
  if (previous) {
    clearScheduledTimeout(previous);
  }

  element.classList.add(RESUME_LAYOUT_SETTLING_CLASS);
  const timer = scheduleTimeout(() => {
    if (resumeLayoutSettlingTimers.get(element) === timer) {
      element.classList.remove(RESUME_LAYOUT_SETTLING_CLASS);
      resumeLayoutSettlingTimers.delete(element);
    }
  }, durationMs);
  resumeLayoutSettlingTimers.set(element, timer);

  return () => {
    const current = resumeLayoutSettlingTimers.get(element);
    if (current) {
      clearScheduledTimeout(current);
      resumeLayoutSettlingTimers.delete(element);
    }
    element.classList.remove(RESUME_LAYOUT_SETTLING_CLASS);
  };
}

export function applyBrandingIconLinks(
  documentLike: { getElementById?: (id: string) => any } | null | undefined,
  version: string | number,
): void {
  if (!documentLike?.getElementById) return;
  const buster = encodeURIComponent(String(version || '0'));
  const nextById: Record<string, string> = {
    'dynamic-manifest': `/manifest.json?v=${buster}`,
    'dynamic-favicon': `/favicon.ico?v=${buster}`,
    'dynamic-apple-touch-icon': `/apple-touch-icon.png?v=${buster}`,
    'dynamic-apple-touch-icon-180': `/apple-touch-icon-180x180.png?v=${buster}`,
    'dynamic-apple-touch-icon-167': `/apple-touch-icon-167x167.png?v=${buster}`,
    'dynamic-apple-touch-icon-152': `/apple-touch-icon-152x152.png?v=${buster}`,
    'dynamic-apple-touch-icon-precomposed': `/apple-touch-icon-precomposed.png?v=${buster}`,
  };

  for (const [id, href] of Object.entries(nextById)) {
    const link = documentLike.getElementById(id);
    if (link && link.href !== href) {
      link.href = href;
    }
  }
}

export function useAppShellEnvironmentEffects(options: UseAppShellEnvironmentEffectsOptions) {
  const {
    isRenameBranchFormOpen,
    renameBranchNameInputRef,
    appShellRef,
    setIsWebAppMode,
    workspaceOpen,
    workspaceAvailable = true,
    currentBranchSandboxId = null,
    setWorkspaceOpen,
    btwSession,
    agents,
    agentsRef,
    currentChatJid,
    activeChatJidRef,
    userProfile,
    userProfileRef,
    brandingRef,
    panePopoutMode = false,
  } = options;

  useTimestampRefresh(30000);

  useEffect(() => {
    if (!isRenameBranchFormOpen) return;
    requestAnimationFrame(() => {
      if (isRenameBranchFormOpen) {
        renameBranchNameInputRef.current?.focus?.();
        renameBranchNameInputRef.current?.select?.();
      }
    });
  }, [isRenameBranchFormOpen, renameBranchNameInputRef]);

  useEffect(() => initTheme(), []);

  useEffect(() => watchStandaloneWebAppMode(setIsWebAppMode), [setIsWebAppMode]);

  useEffect(() => {
    let disposeSettling = () => {};
    const stopWatching = watchReturnToApp(() => {
      reapplyStoredTheme();
      disposeSettling();
      disposeSettling = scheduleResumeLayoutSettling(appShellRef.current);
    });

    return () => {
      stopWatching();
      disposeSettling();
    };
  }, [appShellRef]);

  const workspaceLayoutBucketRef = useRef(resolveWorkspaceLayoutBucket());
  const previousBranchSandboxIdRef = useRef<string | null>(null);
  const previousWorkspaceAvailableRef = useRef(workspaceAvailable);

  useEffect(() => {
    const previousSandboxId = previousBranchSandboxIdRef.current;
    const previousAvailable = previousWorkspaceAvailableRef.current;

    if (shouldAutoRevealWorkspaceForSandboxBinding(previousSandboxId, currentBranchSandboxId)) {
      setWorkspaceOpen(true);
    }
    if (shouldAutoRevealWorkspaceOnAvailabilityChange(previousAvailable, workspaceAvailable)) {
      setWorkspaceOpen(true);
    }

    previousBranchSandboxIdRef.current = typeof currentBranchSandboxId === 'string'
      ? currentBranchSandboxId.trim()
      : '';
    previousWorkspaceAvailableRef.current = workspaceAvailable;
  }, [currentBranchSandboxId, workspaceAvailable, setWorkspaceOpen]);

  useEffect(() => {
    persistWorkspaceOpenPreference(workspaceOpen, {
      bucket: workspaceLayoutBucketRef.current,
    });
  }, [workspaceOpen]);

  useEffect(() => {
    if (!workspaceAvailable && workspaceOpen) {
      setWorkspaceOpen(false);
    }
  }, [workspaceAvailable, workspaceOpen, setWorkspaceOpen]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;

    const media = window.matchMedia(DESKTOP_WORKSPACE_LAYOUT_MEDIA_QUERY);
    const applyLayoutPreference = () => {
      const nextBucket = resolveWorkspaceLayoutBucket(window);
      if (workspaceLayoutBucketRef.current === nextBucket) return;
      const prevBucket = workspaceLayoutBucketRef.current;
      workspaceLayoutBucketRef.current = nextBucket;
      // When shrinking to narrow, collapse the workspace to avoid overlap.
      // When widening to desktop, do NOT auto-open — respect the user's
      // explicit toggle. They can open it themselves.
      if (prevBucket === 'desktop' && nextBucket === 'narrow') {
        setWorkspaceOpen(false);
      }
    };

    if (media.addEventListener) media.addEventListener('change', applyLayoutPreference);
    else if (media.addListener) media.addListener(applyLayoutPreference);

    return () => {
      if (media.removeEventListener) media.removeEventListener('change', applyLayoutPreference);
      else if (media.removeListener) media.removeListener(applyLayoutPreference);
    };
  }, [setWorkspaceOpen]);

  useEffect(() => installStandaloneMobileViewportFix(), []);

  useEffect(() => {
    persistBtwSession(btwSession);
  }, [btwSession]);

  useEffect(() => {
    agentsRef.current = agents || {};
  }, [agents, agentsRef]);

  useEffect(() => {
    activeChatJidRef.current = currentChatJid;
  }, [activeChatJidRef, currentChatJid]);

  useEffect(() => {
    userProfileRef.current = userProfile || { name: 'You', avatar_url: null, avatar_background: null };
  }, [userProfile, userProfileRef]);

  const applyBranding = useCallback((name: string, avatarUrl: string | null, avatarVersion: string | null = null) => {
    if (typeof document === 'undefined') return;

    const title = (name || '').trim() || 'Seeed';
    if (brandingRef.current.title !== title) {
      if (shouldApplyBrandingDocumentTitle({
        panePopoutMode,
        search: typeof window !== 'undefined' ? window.location.search : '',
      })) {
        document.title = title;
        const titleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
        if (titleMeta && titleMeta.getAttribute('content') !== title) {
          titleMeta.setAttribute('content', title);
        }
      }
      brandingRef.current.title = title;
    }

    const avatarKey = avatarUrl ? `${avatarUrl}|${avatarVersion || ''}` : '';
    if (brandingRef.current.avatarBase !== avatarKey) {
      brandingRef.current.avatarBase = avatarKey;
      const buster = avatarVersion || Date.now();
      applyBrandingIconLinks(document, buster);
    }
  }, [brandingRef]);

  return {
    applyBranding,
  };
}
