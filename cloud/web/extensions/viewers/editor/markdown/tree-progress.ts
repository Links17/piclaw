import {
    EditorView,
    StateEffect,
    ViewPlugin,
    ensureSyntaxTree,
    syntaxTree,
} from '#editor-vendor/codemirror';
import type { ViewUpdate } from '#editor-vendor/codemirror';

/**
 * Signals that Lezer's background parser has advanced enough that cached
 * live-preview decorations should rebuild. Piclaw still disables live preview
 * in Large Document Mode; this only prevents partial-tree raw Markdown pockets
 * inside documents that are allowed to use live preview.
 */
export interface TreeGrowthRange {
    from: number;
    to: number;
}

export const treeGrowthEffect = StateEffect.define<TreeGrowthRange>();

export const TREE_PROGRESS_GROWTH_THRESHOLD = 8 * 1024;
export const TREE_PROGRESS_TICK_BUDGET_MS = 8;

type IdleHandle = { kind: 'idle'; id: number } | { kind: 'timeout'; id: number };

function scheduleIdle(callback: () => void): IdleHandle {
    const win = typeof window !== 'undefined' ? window : null;
    if (win && typeof win.requestIdleCallback === 'function') {
        return { kind: 'idle', id: win.requestIdleCallback(() => callback()) };
    }
    const schedule = win?.setTimeout.bind(win) ?? setTimeout;
    return { kind: 'timeout', id: schedule(callback, 16) as unknown as number };
}

function cancelIdle(handle: IdleHandle): void {
    const win = typeof window !== 'undefined' ? window : null;
    if (handle.kind === 'idle' && win && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(handle.id);
        return;
    }
    const cancel = win?.clearTimeout.bind(win) ?? clearTimeout;
    cancel(handle.id);
}

export function shouldSignalTreeGrowth(previousLength: number, nextLength: number, docLength: number): boolean {
    return nextLength >= docLength || nextLength >= previousLength + TREE_PROGRESS_GROWTH_THRESHOLD;
}

class TreeProgressPlugin {
    private lastTreeLength: number;
    private idleHandle: IdleHandle | null = null;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
        // Guarantee one post-attach repair pass. State fields are created
        // before this view plugin and may have observed a shorter tree.
        this.lastTreeLength = 0;
        this.schedule();
    }

    update(update: ViewUpdate) {
        const previousTree = syntaxTree(update.startState);
        const nextTree = syntaxTree(update.state);
        if (!nextTree.topNode.type.isTop) {
            this.lastTreeLength = 0;
            this.cancelScheduledTick();
            return;
        }
        const parserActivated = !previousTree.topNode.type.isTop;
        if (!update.docChanged && !parserActivated) return;
        // Parser reconfiguration must produce at least one growth signal even
        // when the replacement parser completes synchronously.
        this.lastTreeLength = parserActivated ? 0 : nextTree.length;
        this.schedule();
    }

    destroy() {
        this.destroyed = true;
        this.cancelScheduledTick();
    }

    private cancelScheduledTick() {
        if (this.idleHandle === null) return;
        cancelIdle(this.idleHandle);
        this.idleHandle = null;
    }

    private schedule() {
        if (this.idleHandle !== null) return;
        this.idleHandle = scheduleIdle(() => {
            this.idleHandle = null;
            if (!this.destroyed) this.tick();
        });
    }

    private tick() {
        const state = this.view.state;
        const docLength = state.doc.length;
        if (this.lastTreeLength >= docLength) return;
        if (!syntaxTree(state).topNode.type.isTop) return;

        const ensured = ensureSyntaxTree(state, docLength, TREE_PROGRESS_TICK_BUDGET_MS);
        const nextLength = (ensured ?? syntaxTree(state)).length;

        if (shouldSignalTreeGrowth(this.lastTreeLength, nextLength, docLength)) {
            const previousLength = this.lastTreeLength;
            this.lastTreeLength = nextLength;
            try {
                this.view.dispatch({
                    effects: treeGrowthEffect.of({
                        from: previousLength,
                        to: nextLength,
                    }),
                });
            } catch {
                this.lastTreeLength = previousLength;
                return;
            }
        }

        if (nextLength < docLength) this.schedule();
    }
}

export const treeProgressPlugin = ViewPlugin.fromClass(TreeProgressPlugin);
