import { Notice } from 'obsidian';
import type { HighlightInfo as HiNote } from '../types/highlight';
import type { HiNotePluginContext } from '../types/plugin';
import type { HighlightRepository } from '../repositories/HighlightRepository';
import type { EventManager } from './EventManager';

interface Kept {
    path: string;
    before: HiNote[];
    at: number;
}

/**
 * 批注和高亮的撤销。
 *
 * 批注、公式和图里的高亮都存在 .hinote/highlights/*.json，不在笔记里，编辑器的 Cmd-Z 看不到。
 * 所有写盘都经过 HighlightRepository：写之前，如果改的是读者做的东西（高亮、颜色、批注，
 * 而不只是打字让位置挪了），就记下这个文件之前的样子。
 * Cmd-Z：这次改动比最后一次改笔记正文还新，就恢复上一份；否则 Cmd-Z 还是编辑器的。
 * Cmd-Shift-Z 同样地重做；有新的改动时，能重做的就清空。
 */
export class HighlightUndo {
    private stack: Kept[] = [];
    private redoStack: Kept[] = [];
    private lastTextEdit = 0;
    private restoring = false;

    constructor(
        private plugin: HiNotePluginContext,
        private repository: HighlightRepository,
        private eventManager: EventManager
    ) {}

    enable(): void {
        this.repository.beforeWrite = (path, next) => this.record(path, next);
        this.plugin.registerEvent(this.plugin.app.workspace.on('editor-change', () => {
            this.lastTextEdit = Date.now();
        }));
        this.plugin.registerDomEvent(activeDocument, 'keydown', event => this.onKey(event), { capture: true });
        this.plugin.addCommand({
            id: 'undo-comment-highlight',
            name: 'Undo last comment or highlight change',
            callback: () => void this.undo()
        });
        this.plugin.addCommand({
            id: 'redo-comment-highlight',
            name: 'Redo last undone comment or highlight change',
            callback: () => void this.redo()
        });
    }

    disable(): void {
        this.repository.beforeWrite = null;
    }

    /** 读者做的东西，去掉跟着打字变的文字、位置和上下文 */
    static essence(list: HiNote[] | null | undefined): string {
        return JSON.stringify((list || [])
            .filter(h => h && h.id)
            .map(h => {
                const f = h.figure;
                return [
                    h.id,
                    h.backgroundColor || '',
                    (h.comments || []).map(c => [c.id, c.content]),
                    f ? (f.kind === 'math' ? f.leaves : f.path) : null
                ];
            })
            .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
    }

    private async record(path: string, next: HiNote[]): Promise<void> {
        if (this.restoring) return;
        // 刚打完字就写盘，是 HiNote 在跟着正文挪位置，不是读者改的
        if (Date.now() - this.lastTextEdit < 1500) return;
        const before = await this.repository.readStoredHighlights(path);
        if (HighlightUndo.essence(before) === HighlightUndo.essence(next)) return;
        this.stack.push({ path, before: JSON.parse(JSON.stringify(before)) as HiNote[], at: Date.now() });
        if (this.stack.length > 50) this.stack.shift();
        this.redoStack = [];
    }

    private onKey(event: KeyboardEvent): void {
        if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
        const target = event.target as HTMLElement | null;
        // 在批注框（或别的输入框）里打字：用它自己的撤销
        if (target?.closest?.('textarea, input') || (target?.isContentEditable && !target.closest('.cm-content'))) return;
        const list = event.shiftKey ? this.redoStack : this.stack;
        const top = list[list.length - 1];
        if (!top || top.at < this.lastTextEdit) return;
        event.preventDefault();
        event.stopPropagation();
        void (event.shiftKey ? this.redo() : this.undo());
    }

    async undo(): Promise<void> {
        const top = this.stack.pop();
        if (!top) {
            new Notice('Nothing to undo in comments or highlights');
            return;
        }
        const was = await this.restore(top);
        this.redoStack.push({ path: top.path, before: was, at: Date.now() });
        new Notice('Undid the last comment or highlight change');
    }

    async redo(): Promise<void> {
        const top = this.redoStack.pop();
        if (!top) {
            new Notice('Nothing to redo in comments or highlights');
            return;
        }
        const was = await this.restore(top);
        this.stack.push({ path: top.path, before: was, at: Date.now() });
        new Notice('Redid the comment or highlight change');
    }

    /** 把一个文件的高亮恢复成记下的样子，返回被换掉的那份 */
    private async restore(top: Kept): Promise<HiNote[]> {
        const path = top.path;
        const now = JSON.parse(JSON.stringify(await this.repository.getFileHighlights(path))) as HiNote[];
        const pos = new Map(now.map(h => [h.id, h]));
        // 位置用现在的：之后可能又在笔记里打过字
        const back = top.before.map(h => {
            const current = pos.get(h.id);
            return current ? { ...h, position: current.position } : h;
        });
        this.restoring = true;
        try {
            if (back.length) await this.repository.saveFileHighlights(path, back);
            else await this.repository.deleteFileHighlights(path);
        } finally {
            this.restoring = false;
        }
        const em = this.eventManager;
        const ids = new Set(back.map(h => h.id));
        back.forEach(h => {
            const comments = h.comments || [];
            if (comments.length) em.emitCommentUpdate(path, h.text, comments[comments.length - 1].content, h.id!);
            else em.emitHighlightUpdate(path, h.text, h.text, h.id!);
        });
        now.filter(h => !ids.has(h.id)).forEach(h => em.emitHighlightDelete(path, h.text, h.id!));
        em.emitFigureHighlightChange(path);
        return now;
    }
}
