export interface SessionRowCapabilities {
  archived: boolean;
  isRoot: boolean;
  canEdit: boolean;
  canPrune: boolean;
  canPurgeArchived: boolean;
  canDelete: boolean;
  showMenu: boolean;
}

export function resolveBranchRecordByChatJid(
  chatJid: string,
  ...lists: Array<any[] | null | undefined>
): any | null {
  const target = typeof chatJid === 'string' ? chatJid.trim() : '';
  if (!target) return null;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const found = list.find((row) => row?.chat_jid === target);
    if (found) return found;
  }
  return null;
}

/** Session row action eligibility (matches compose session popup rules). */
export function getSessionRowCapabilities(
  chat: any,
  options: {
    currentChatJid?: string | null;
    canDelete?: boolean;
    canPurgeArchived?: boolean;
    /** When true, any non-archived root session row may be archived/deleted. */
    allowRootDelete?: boolean;
  } = {},
): SessionRowCapabilities {
  const archived = Boolean(chat?.archived_at);
  const chatJid = typeof chat?.chat_jid === 'string' ? chat.chat_jid.trim() : '';
  const isRoot = chatJid === (chat?.root_chat_jid || chatJid);
  const isCurrent = Boolean(chatJid && chatJid === options.currentChatJid);
  const allowRootDelete = options.allowRootDelete !== false;
  const canPruneInactive = Boolean(
    !isRoot
    && !chat?.is_active
    && !archived
    && options.canDelete,
  );
  const canDeleteCurrent = Boolean(
    isCurrent
    && !archived
    && options.canDelete,
  );
  const canDeleteRoot = Boolean(
    isRoot
    && !archived
    && options.canDelete
    && allowRootDelete,
  );
  const canPrune = canPruneInactive || canDeleteCurrent || canDeleteRoot;
  const canPurgeArchived = Boolean(archived && options.canPurgeArchived);
  const canEdit = !archived;
  const canDelete = canPrune || canPurgeArchived;
  const showMenu = canEdit || canDelete;
  return {
    archived,
    isRoot,
    canEdit,
    canPrune,
    canPurgeArchived,
    canDelete,
    showMenu,
  };
}
