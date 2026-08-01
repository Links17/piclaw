/**
 * hr.ts — Horizontal rule decoration.
 *
 * Replaces `---`, `***`, `___` with a styled <hr> widget.
 */
import { registerDecorator, Decoration, WidgetType } from './live-preview.js';
import type { DecorationEntry, SyntaxNode, EditorView } from './live-preview.js';

class HorizontalRuleWidget extends WidgetType {
    toDOM(): HTMLElement {
        const hr = document.createElement('hr');
        hr.className = 'cm-md-hr';
        return hr;
    }

    eq(): boolean {
        return true;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

function hrDecorator(node: SyntaxNode, view: EditorView): DecorationEntry[] {
    const line = view.state.doc.lineAt(node.from);
    return [{
        from: line.from,
        to: line.to,
        decoration: Decoration.replace({
            widget: new HorizontalRuleWidget(),

        }),
    }];
}

registerDecorator('HorizontalRule', hrDecorator);
