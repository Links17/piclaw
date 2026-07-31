import { html, useCallback, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { resolveSessionPopupChats } from './compose-box.js';
import { formatBranchPickerBaseLabel, getBranchLifecycleBadges } from '../ui/branch-lifecycle.js';
import { getSessionRowCapabilities } from '../ui/session-row-capabilities.js';
import { chatJidsMatch } from '../ui/chat-jid.js';
import { BodyPortal } from './body-portal.js';

export const SESSION_SIDEBAR_OPEN_EVENT = 'piclaw:open-session-sidebar';

type MenuAnchor = {
  chatJid: string;
  top: number;
  left: number;
};

function SessionSidebarRowMenu({
  chat,
  anchor,
  currentChatJid = null,
  onClose,
  onRenameSession,
  onDeleteSession,
  onPurgeArchivedSession,
}: {
  chat: any;
  anchor: MenuAnchor;
  currentChatJid?: string | null;
  onClose: () => void;
  onRenameSession?: (chatJid: string) => void;
  onDeleteSession?: (chatJid: string, options?: { confirmed?: boolean }) => Promise<boolean | void>;
  onPurgeArchivedSession?: (chatJid: string, options?: { confirmed?: boolean }) => Promise<boolean | void>;
}) {
  const chatJid = String(chat?.chat_jid || '').trim();
  const caps = getSessionRowCapabilities(chat, {
    currentChatJid,
    canDelete: typeof onDeleteSession === 'function',
    canPurgeArchived: typeof onPurgeArchivedSession === 'function',
    allowRootDelete: true,
  });
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const handleEdit = () => {
    onClose();
    onRenameSession?.(chatJid);
  };

  const handleDelete = async () => {
    if (!deleteConfirming) {
      setDeleteConfirming(true);
      return;
    }
    onClose();
    if (caps.canPurgeArchived) {
      await onPurgeArchivedSession?.(chatJid, { confirmed: true });
    } else if (caps.canPrune) {
      await onDeleteSession?.(chatJid, { confirmed: true });
    }
  };

  return html`
    <${BodyPortal} className="session-sidebar-menu-portal">
      <div
        ref=${menuRef}
        class="workspace-menu-dropdown session-sidebar-item-dropdown"
        role="menu"
        style=${{
          position: 'fixed',
          top: `${anchor.top}px`,
          left: `${anchor.left}px`,
          zIndex: 1200,
        }}
      >
        ${caps.canEdit && onRenameSession && html`
          <button type="button" class="workspace-menu-item" role="menuitem" onClick=${handleEdit}>Edit</button>
        `}
        ${caps.canDelete && html`
          <button
            type="button"
            class=${`workspace-menu-item${deleteConfirming ? ' danger' : ''}`}
            role="menuitem"
            onClick=${() => { void handleDelete(); }}
          >
            ${deleteConfirming ? (caps.canPurgeArchived ? 'Confirm delete' : 'Confirm delete') : 'Delete'}
          </button>
        `}
      </div>
    <//>
  `;
}

export function SessionSidebar({
  activeChatAgents = [],
  currentChatJid = null,
  onSwitchChat,
  onCreateRootSession,
  onRenameSession,
  onDeleteSession,
  onPurgeArchivedSession,
  collapsed = false,
  onToggleCollapsed,
}: {
  activeChatAgents?: any[];
  currentChatJid?: string | null;
  onSwitchChat?: (chatJid: string) => void;
  onCreateRootSession?: () => void;
  onRenameSession?: (chatJid: string) => void;
  onDeleteSession?: (chatJid: string, options?: { confirmed?: boolean }) => Promise<boolean | void>;
  onPurgeArchivedSession?: (chatJid: string, options?: { confirmed?: boolean }) => Promise<boolean | void>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<MenuAnchor | null>(null);
  const sessions = useMemo(() => {
    const all = resolveSessionPopupChats(activeChatAgents, currentChatJid, null);
    return all.filter((chat) => !chat?.archived_at);
  }, [activeChatAgents, currentChatJid]);
  const openMenuChat = useMemo(
    () => (openMenu ? sessions.find((chat) => chat?.chat_jid === openMenu.chatJid) || null : null),
    [openMenu, sessions],
  );

  const closeMenu = useCallback(() => setOpenMenu(null), []);

  useEffect(() => {
    const open = () => {
      if (collapsed) onToggleCollapsed?.();
    };
    window.addEventListener(SESSION_SIDEBAR_OPEN_EVENT, open);
    return () => window.removeEventListener(SESSION_SIDEBAR_OPEN_EVENT, open);
  }, [collapsed, onToggleCollapsed]);

  const openRowMenu = useCallback((event: Event, chatJid: string) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement | null;
    const rect = button?.getBoundingClientRect?.();
    if (!rect) return;
    const menuWidth = 160;
    setOpenMenu({
      chatJid,
      top: rect.bottom + 4,
      left: Math.max(8, rect.right - menuWidth),
    });
  }, []);

  if (collapsed) {
    return html`
      <aside class="session-sidebar session-sidebar-collapsed">
        <button
          type="button"
          class="session-sidebar-expand-btn"
          onClick=${onToggleCollapsed}
          title="Show sessions"
          aria-label="Show sessions"
        >
          ☰
        </button>
      </aside>
    `;
  }

  return html`
    <aside class="session-sidebar" data-testid="session-sidebar">
      <div class="session-sidebar-header">
        <span class="session-sidebar-title">Sessions</span>
        <div class="session-sidebar-header-actions">
          ${onCreateRootSession && html`
            <button type="button" class="session-sidebar-icon-btn" onClick=${onCreateRootSession} title="New session" aria-label="New session">+</button>
          `}
          <button type="button" class="session-sidebar-icon-btn" onClick=${onToggleCollapsed} title="Hide sessions" aria-label="Hide sessions">×</button>
        </div>
      </div>
      <div class="session-sidebar-list" role="listbox" aria-label="Sessions">
        ${sessions.length === 0 && html`<div class="session-sidebar-empty">No sessions</div>`}
        ${sessions.map((chat) => {
          const chatJid = String(chat?.chat_jid || '').trim();
          const isCurrent = chatJid && chatJidsMatch(chatJid, currentChatJid);
          const baseLabel = formatBranchPickerBaseLabel(chat);
          const badges = getBranchLifecycleBadges(chat, { currentChatJid })
            .filter((badge) => badge !== 'current');
  const caps = getSessionRowCapabilities(chat, {
    currentChatJid,
    canDelete: typeof onDeleteSession === 'function',
    canPurgeArchived: typeof onPurgeArchivedSession === 'function',
    allowRootDelete: true,
  });
          return html`
            <div
              key=${chatJid || baseLabel}
              class=${`session-sidebar-item-row${isCurrent ? ' current' : ''}`}
              role="option"
              aria-selected=${isCurrent}
            >
              <button
                type="button"
                class="session-sidebar-item-main"
                onClick=${() => {
                  closeMenu();
                  if (!isCurrent && onSwitchChat) onSwitchChat(chatJid);
                }}
              >
                <span class="session-sidebar-item-label" title=${chatJid}>${baseLabel}</span>
                ${badges.length > 0 && html`
                  <span class="session-sidebar-item-badges">
                    ${badges.map((badge) => html`<span key=${badge} class="session-sidebar-badge">${badge}</span>`)}
                  </span>
                `}
              </button>
              ${caps.showMenu && html`
                <button
                  type="button"
                  class="session-sidebar-item-menu"
                  data-testid="session-row-menu"
                  aria-haspopup="menu"
                  aria-expanded=${openMenu?.chatJid === chatJid ? 'true' : 'false'}
                  title="Session actions"
                  aria-label="Session actions"
                  onClick=${(event: Event) => openRowMenu(event, chatJid)}
                >
                  …
                </button>
              `}
            </div>
          `;
        })}
      </div>
      ${openMenu && openMenuChat && html`
        <${SessionSidebarRowMenu}
          chat=${openMenuChat}
          anchor=${openMenu}
          currentChatJid=${currentChatJid}
          onClose=${closeMenu}
          onRenameSession=${onRenameSession}
          onDeleteSession=${onDeleteSession}
          onPurgeArchivedSession=${onPurgeArchivedSession}
        />
      `}
    </aside>
  `;
}
