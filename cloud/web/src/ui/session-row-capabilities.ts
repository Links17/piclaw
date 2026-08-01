export interface SessionRowCapabilities {
  isRoot: boolean;
  canEdit: boolean;
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
    /** When true, any root session row may be deleted. */
    allowRootDelete?: boolean;
  } = {},
): SessionRowCapabilities {
  const chatJid = typeof chat?.chat_jid === 'string' ? chat.chat_jid.trim() : '';
  const isRoot = chatJid === (chat?.root_chat_jid || chatJid);
  const isCurrent = Boolean(chatJid && chatJid === options.currentChatJid);
  const allowRootDelete = options.allowRootDelete !== false;
  const canDeleteInactive = Boolean(
    !isRoot
    && !chat?.is_active
    && options.canDelete,
  );
  const canDeleteCurrent = Boolean(
    isCurrent
    && options.canDelete,
  );
  const canDeleteRoot = Boolean(
    isRoot
    && options.canDelete
    && allowRootDelete,
  );
  const canDelete = canDeleteInactive || canDeleteCurrent || canDeleteRoot;
  const canEdit = true;
  const showMenu = canEdit || canDelete;
  return {
    isRoot,
    canEdit,
    canDelete,
    showMenu,
  };
}
