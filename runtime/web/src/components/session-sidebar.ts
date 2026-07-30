import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.js';
import { useTranslation } from '../utils/i18n.js';
import { resolveSessionPopupChats } from './compose-box.js';
import { formatBranchPickerBaseLabel, formatBranchPickerLabel, getBranchLifecycleBadges } from '../ui/branch-lifecycle.js';

export const SESSION_SIDEBAR_OPEN_EVENT = 'piclaw:open-session-sidebar';

export function SessionSidebar({
  activeChatAgents = [],
  currentChatJid = null,
  onSwitchChat,
  onCreateSession,
  onCreateRootSession,
  onRenameSession,
  onDeleteSession,
  onRestoreSession,
  onPurgeArchivedSession,
  collapsed = false,
  onToggleCollapsed,
}: {
  activeChatAgents?: any[];
  currentChatJid?: string | null;
  onSwitchChat?: (chatJid: string) => void;
  onCreateSession?: () => void;
  onCreateRootSession?: () => void;
  onRenameSession?: () => void;
  onDeleteSession?: () => void;
  onRestoreSession?: (chatJid: string) => void;
  onPurgeArchivedSession?: (chatJid: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t } = useTranslation();
  const [showArchived, setShowArchived] = useState(false);
  const sessions = useMemo(() => {
    const all = resolveSessionPopupChats(activeChatAgents, currentChatJid, null);
    if (showArchived) return all;
    return all.filter((chat) => !chat?.archived_at);
  }, [activeChatAgents, currentChatJid, showArchived]);

  useEffect(() => {
    const open = () => {
      if (collapsed) onToggleCollapsed?.();
    };
    window.addEventListener(SESSION_SIDEBAR_OPEN_EVENT, open);
    return () => window.removeEventListener(SESSION_SIDEBAR_OPEN_EVENT, open);
  }, [collapsed, onToggleCollapsed]);

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
          ${onCreateSession && html`
            <button type="button" class="session-sidebar-icon-btn" onClick=${onCreateSession} title="New session">+</button>
          `}
          ${onCreateRootSession && html`
            <button type="button" class="session-sidebar-icon-btn" onClick=${onCreateRootSession} title="New root session">⊕</button>
          `}
          <button type="button" class="session-sidebar-icon-btn" onClick=${onToggleCollapsed} title="Hide sessions" aria-label="Hide sessions">×</button>
        </div>
      </div>
      <div class="session-sidebar-toolbar">
        <label class="session-sidebar-toggle-archived">
          <input type="checkbox" checked=${showArchived} onChange=${(e: any) => setShowArchived(Boolean(e?.target?.checked))} />
          ${t('settings.sessions.showArchived') || 'Show archived'}
        </label>
      </div>
      <div class="session-sidebar-list" role="listbox" aria-label="Sessions">
        ${sessions.length === 0 && html`<div class="session-sidebar-empty">No sessions</div>`}
        ${sessions.map((chat) => {
          const chatJid = String(chat?.chat_jid || '').trim();
          const isCurrent = chatJid && chatJid === currentChatJid;
          const label = formatBranchPickerLabel(chat, { currentChatJid });
          const baseLabel = formatBranchPickerBaseLabel(chat);
          const badges = getBranchLifecycleBadges(chat, { currentChatJid });
          const archived = Boolean(chat?.archived_at);
          return html`
            <button
              key=${chatJid || baseLabel}
              type="button"
              class=${`session-sidebar-item${isCurrent ? ' current' : ''}${archived ? ' archived' : ''}`}
              role="option"
              aria-selected=${isCurrent}
              onClick=${() => {
                if (archived && onRestoreSession) onRestoreSession(chatJid);
                else if (!isCurrent && onSwitchChat) onSwitchChat(chatJid);
              }}
            >
              <span class="session-sidebar-item-label">${label}</span>
              ${badges.length > 0 && html`
                <span class="session-sidebar-item-badges">
                  ${badges.map((badge) => html`<span key=${badge} class="session-sidebar-badge">${badge}</span>`)}
                </span>
              `}
            </button>
          `;
        })}
      </div>
      ${(onRenameSession || onDeleteSession) && html`
        <div class="session-sidebar-footer">
          ${onRenameSession && html`<button type="button" class="session-sidebar-footer-btn" onClick=${onRenameSession}>Rename</button>`}
          ${onDeleteSession && html`<button type="button" class="session-sidebar-footer-btn danger" onClick=${onDeleteSession}>Delete</button>`}
        </div>
      `}
    </aside>
  `;
}
