import { App, MarkdownView, Menu, TFile, setIcon } from 'obsidian';
import type { CodeAnchor, HighlightInfo as HiNote } from '../types/highlight';
import type { HiNotePluginContext } from '../types/plugin';
import type { HighlightRepository } from '../repositories/HighlightRepository';
import type { HighlightManager } from '../services/HighlightManager';
import type { EventManager, HighlightEvents } from '../services/EventManager';
import type { HighlightService } from '../services/HighlightService';
import { IdGenerator } from '../utils/IdGenerator';
import { CommentWidgetHelper } from '../components/comment/CommentWidgetHelper';
import { hasCommentThread } from '../components/comment/commentThread';
import { t } from '../i18n';
import { showConfirmModal } from '../utils/ConfirmModal';
import { FIGURE_FLASH_EVENT } from '../figure/FigureHighlighter';
import { CodeBlock, CodeSource, CodeSpot } from './codeSource';

const DEFAULT_COLOR = '#ffeb3b';
const COMMENTED = 'hi-note-code-commented';
const FLASH = 'hi-note-code-flash';
const SAFE_COLOR = /^[#a-zA-Z0-9(),.%\s-]+$/;

type CodeMirrorView = {
    state: { doc: { lineAt(pos: number): { number: number } } };
    viewport: { from: number; to: number };
    contentDOM: HTMLElement;
    scrollDOM: HTMLElement;
    posAtDOM(node: Node, offset?: number): number;
    domAtPos(pos: number): { node: Node; offset: number };
};

/** Obsidian 没公开的：编辑器底下的 CodeMirror，阅读模式分好的段 */
type ViewInternals = MarkdownView & {
    editor: { cm?: CodeMirrorView };
    previewMode: { containerEl?: HTMLElement; renderer?: { sections?: { el?: HTMLElement; lineStart: number }[] } };
};

/** CSS Highlight API（Obsidian 的 TypeScript 版本还没有它的类型） */
type HighlightCtor = new (...ranges: Range[]) => object;

interface Drawn {
    highlight: HiNote;
    range: Range;
}

interface Painted {
    drawn: Drawn[];
    overlay: HTMLElement | null;
    widgets: HTMLElement[];
    widgetKey: string;
}

interface CodeSelection {
    file: TFile;
    block: CodeBlock;
    from: number;
    to: number;
    text: string;
}

interface Hit {
    view: MarkdownView;
    highlight: HiNote;
}

/**
 * 让 HiNote 能划代码块里的字，像划图里的字一样。
 *
 * 选中代码块里的字，弹出「高亮 / 批注」；右键高亮可以批注或去掉。阅读模式和实时预览都行。
 * 高亮和图里的一样存在笔记自己的 HiNote 文件里（figure.kind 是 'code'），
 * 所以侧栏、批注、闪卡、导出都照常能用。
 *
 * 代码块的字不能改（实时预览里是编辑器的字，改了就是改笔记），所以不加 <mark>，
 * 用 CSS Highlight API 给一段段 Range 上色；批注图标放在一层盖在上面的浮层里。
 */
export class CodeHighlighter {
    private app: App;
    private readonly registry: Map<string, object> | null;
    private readonly Highlight: HighlightCtor | null;
    private painted = new Map<MarkdownView, Painted>();
    private paintSeq = new Map<MarkdownView, number>();
    private blockCache = new WeakMap<MarkdownView, { src: string; blocks: CodeBlock[]; codes: string[] }>();
    private watched = new WeakSet<HTMLElement>();
    private observers: (MutationObserver | ResizeObserver)[] = [];
    private queued = new Set<MarkdownView>();
    private names = new Set<string>();
    private style: HTMLStyleElement | null = null;
    private toolbar: HTMLElement | null = null;
    private hover: { view: MarkdownView; id: string } | null = null;
    private lastContextMenu: MouseEvent | null = null;
    private flashTimer: number | null = null;

    constructor(
        private plugin: HiNotePluginContext,
        private repository: HighlightRepository,
        private highlightManager: HighlightManager,
        private eventManager: EventManager,
        private highlightService: HighlightService
    ) {
        this.app = plugin.app;
        const css = (window as unknown as { CSS?: { highlights?: Map<string, object> } }).CSS;
        this.registry = css?.highlights ?? null;
        this.Highlight = (window as unknown as { Highlight?: HighlightCtor }).Highlight ?? null;
    }

    enable(): void {
        if (!this.registry || !this.Highlight) {
            console.warn('[HiNote] 没有 CSS Highlight API，代码块里不能划高亮');
            return;
        }
        const { workspace } = this.app;
        workspace.onLayoutReady(() => this.watchLeaves());
        this.plugin.registerEvent(workspace.on('layout-change', () => this.watchLeaves()));
        this.plugin.registerEvent(workspace.on('file-open', () => this.watchLeaves()));
        this.plugin.registerEvent(workspace.on('css-change', () => this.apply()));
        this.plugin.registerEvent(workspace.on('editor-menu', menu => this.onEditorMenu(menu)));

        const dataEvents: (keyof HighlightEvents)[] = [
            'highlight:update', 'highlight:delete', 'comment:update', 'comment:delete', 'figure-highlight:change'
        ];
        dataEvents.forEach(name => {
            this.plugin.registerEvent(this.eventManager.on(name, () => this.painted.forEach((_, view) => this.queue(view))));
        });

        this.plugin.registerDomEvent(activeDocument, 'mouseup', event => {
            // 等浏览器（和编辑器）把选区定下来
            window.setTimeout(() => this.showToolbarForSelection(event), 0);
        });
        this.plugin.registerDomEvent(activeDocument, 'mousedown', event => {
            if (this.toolbar && !this.toolbar.contains(event.target as Node)) this.hideToolbar();
        });
        this.plugin.registerDomEvent(activeDocument, 'keydown', event => {
            if (event.key === 'Escape') this.hideToolbar();
        });
        this.plugin.registerDomEvent(activeDocument, 'mousemove', event => this.onMouseMove(event));
        this.plugin.registerDomEvent(activeDocument, 'contextmenu', event => this.onContextMenu(event), { capture: true });
    }

    disable(): void {
        this.observers.forEach(observer => observer.disconnect());
        this.observers = [];
        this.painted.forEach(p => p.overlay?.remove());
        this.painted.clear();
        if (this.flashTimer) window.clearInterval(this.flashTimer);
        this.names.forEach(name => this.registry?.delete(name));
        this.registry?.delete(FLASH);
        this.names.clear();
        this.style?.remove();
        this.style = null;
        this.hideToolbar();
    }

    // ── 找到笔记 ─────────────────────────────────────────────────────────────

    private watchLeaves(): void {
        const views = new Set<MarkdownView>();
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) return;
            views.add(view);
            const root = view.containerEl;
            if (!this.watched.has(root)) {
                this.watched.add(root);
                // 阅读模式滚动时一段段挂上拿下，实时预览打字、滚动时编辑器重画行：都只能盯着 DOM
                const mutations = new MutationObserver(list => {
                    if (list.every(m => this.isMine(m))) return;
                    this.queue(view);
                });
                mutations.observe(root, { childList: true, subtree: true, characterData: true });
                // 换了阅读 / 编辑、改了窗口宽度，字挪了地方
                const resize = new ResizeObserver(() => this.queue(view));
                resize.observe(root);
                root.querySelectorAll('.markdown-reading-view, .markdown-source-view').forEach(el => resize.observe(el));
                this.observers.push(mutations, resize);
                root.addEventListener(FIGURE_FLASH_EVENT, (event: Event) => {
                    this.flash(view, (event as CustomEvent<string>).detail);
                });
            }
            this.queue(view);
        });
        this.painted.forEach((_, view) => {
            if (!views.has(view)) this.clear(view);
        });
    }

    /** 我们自己的批注图标变了，不用重画 */
    private isMine(m: MutationRecord): boolean {
        const el = m.target.nodeType === 1 ? m.target as Element : m.target.parentElement;
        if (el?.closest?.('.hi-note-code-widgets')) return true;
        if (m.type !== 'childList') return false;
        const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
        return nodes.length > 0 && nodes.every(n => n.nodeType === 1 && (n as Element).hasClass('hi-note-code-widgets'));
    }

    private queue(view: MarkdownView): void {
        if (this.queued.has(view)) return;
        this.queued.add(view);
        window.requestAnimationFrame(() => {
            this.queued.delete(view);
            void this.paint(view).catch(error => console.error('[HiNote] 画代码块里的高亮失败:', error));
        });
    }

    private viewOf(el: Element): MarkdownView | null {
        const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view.containerEl.contains(el));
        return leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
    }

    private cmOf(view: MarkdownView): CodeMirrorView | null {
        return (view as ViewInternals).editor?.cm ?? null;
    }

    private blocksOf(view: MarkdownView): { blocks: CodeBlock[]; codes: string[] } {
        const src = view.getViewData();
        const cached = this.blockCache.get(view);
        if (cached?.src === src) return cached;
        const blocks = CodeSource.blocks(src);
        const fresh = { src, blocks, codes: blocks.map(b => trimNewlines(b.code)) };
        this.blockCache.set(view, fresh);
        return fresh;
    }

    /** 页面上显示出来的 <pre><code>：阅读模式的，和实时预览里画成块的 callout、引用里的 */
    private codeEls(view: MarkdownView): HTMLElement[] {
        const root = view.getMode() === 'preview'
            ? (view as ViewInternals).previewMode?.containerEl
            : this.cmOf(view)?.contentDOM;
        if (!root) return [];
        return Array.from(root.querySelectorAll<HTMLElement>('pre > code'))
            .filter(code => !code.closest('.markdown-embed') && !code.parentElement!.hasClass('frontmatter'));
    }

    /** 页面上这个 <code> 是原文第几个代码块：按代码认，一样的代码有好几块时取位置最近的 */
    private blockFor(view: MarkdownView, code: Element): number | null {
        const { blocks, codes } = this.blocksOf(view);
        const text = trimNewlines(code.textContent || '');
        const same: number[] = [];
        codes.forEach((c, i) => {
            if (c === text) same.push(i);
        });
        if (same.length <= 1) return same.length ? same[0] : null;
        const line = this.lineOf(view, code);
        if (line == null) return same[0];
        return same.reduce((a, b) => Math.abs(blocks[b].line - line) < Math.abs(blocks[a].line - line) ? b : a);
    }

    /** 页面上这个元素大概在原文第几行 */
    private lineOf(view: MarkdownView, el: Element): number | null {
        try {
            if (view.getMode() === 'preview') {
                const sections = (view as ViewInternals).previewMode?.renderer?.sections || [];
                return sections.find(s => s.el?.contains(el))?.lineStart ?? null;
            }
            const cm = this.cmOf(view);
            if (!cm) return null;
            return cm.state.doc.lineAt(cm.posAtDOM(el.closest('.cm-embed-block') || el)).number - 1;
        } catch {
            return null;
        }
    }

    /** 实时预览里直接显示的代码行（不在画成块的 callout 里） */
    private isEditorCodeLine(node: Node): boolean {
        const el = node.nodeType === 1 ? node as Element : node.parentElement;
        const line = el?.closest('.cm-line');
        return !!line && line.hasClass('HyperMD-codeblock') && !line.closest('.cm-embed-block');
    }

    // ── 画高亮 ───────────────────────────────────────────────────────────────

    private async paint(view: MarkdownView): Promise<void> {
        const file = view.file;
        if (!file || !view.containerEl.isConnected || !this.highlightService.shouldProcessFile(file)) {
            this.clear(view);
            return;
        }
        const seq = (this.paintSeq.get(view) || 0) + 1;
        this.paintSeq.set(view, seq);
        const stored = await this.repository.getFileHighlights(file.path);
        if (this.paintSeq.get(view) !== seq) return;

        const mine = stored
            .filter(h => h.id && h.figure?.kind === 'code')
            .map(h => ({ ...h, filePath: file.path }));
        const drawn: Drawn[] = [];
        if (mine.length) {
            const { blocks } = this.blocksOf(view);
            const byBlock = new Map<number, { highlight: HiNote; spot: CodeSpot }[]>();
            mine.forEach(highlight => {
                const spot = CodeSource.resolve(blocks, highlight);
                if (!spot) return;
                if (!byBlock.has(spot.block)) byBlock.set(spot.block, []);
                byBlock.get(spot.block)!.push({ highlight, spot });
            });

            for (const code of this.codeEls(view)) {
                const index = this.blockFor(view, code);
                (index == null ? [] : byBlock.get(index) || []).forEach(({ highlight, spot }) => {
                    const range = rangeIn(code, spot.from, spot.to);
                    if (range) drawn.push({ highlight, range });
                });
            }

            const cm = this.cmOf(view);
            if (cm && view.getMode() === 'source') {
                byBlock.forEach((list, index) => list.forEach(({ highlight, spot }) => {
                    const range = this.editorRange(cm, blocks[index], spot);
                    if (range) drawn.push({ highlight, range });
                }));
            }
        }

        const before = this.painted.get(view);
        this.painted.set(view, {
            drawn,
            overlay: before?.overlay ?? null,
            widgets: before?.widgets ?? [],
            widgetKey: before?.widgetKey ?? ''
        });
        this.apply();
        this.placeWidgets(view);
    }

    /** 实时预览：编辑器只画了屏幕附近的行，没画出来的先不管，滚过去时会再画 */
    private editorRange(cm: CodeMirrorView, block: CodeBlock, spot: CodeSpot): Range | null {
        const from = CodeSource.toSrc(block, spot.from);
        const to = CodeSource.toSrc(block, spot.to);
        if (from < cm.viewport.from || to > cm.viewport.to) return null;
        try {
            const start = cm.domAtPos(from);
            const end = cm.domAtPos(to);
            if (!this.isEditorCodeLine(start.node) || !this.isEditorCodeLine(end.node)) return null;
            const range = activeDocument.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            return range;
        } catch {
            return null;
        }
    }

    private clear(view: MarkdownView): void {
        const p = this.painted.get(view);
        if (!p) return;
        p.overlay?.remove();
        this.painted.delete(view);
        this.apply();
    }

    /** 把所有笔记里画好的 Range 按颜色交给 CSS.highlights */
    private apply(): void {
        if (!this.registry || !this.Highlight) return;
        const body = activeDocument.body;
        const dark = body.hasClass('theme-dark');
        const vars = getComputedStyle(body);
        const commented = vars.getPropertyValue('--hi-note-commented-bg').trim() || (dark ? '#523a6d' : '#e0cdf5');
        const edge = vars.getPropertyValue('--hi-note-commented-edge').trim() || '#9d74d4';

        const groups = new Map<string, { color: string; ranges: Range[] }>();
        this.painted.forEach(p => p.drawn.forEach(({ highlight, range }) => {
            let name = COMMENTED;
            let color = commented;
            if (!hasCommentThread(highlight)) {
                const picked = highlight.backgroundColor && SAFE_COLOR.test(highlight.backgroundColor)
                    ? highlight.backgroundColor : DEFAULT_COLOR;
                name = `hi-note-code-${picked.replace(/[^a-zA-Z0-9]/g, '')}`;
                color = `color-mix(in srgb, ${picked} ${dark ? 45 : 70}%, transparent)`;
            }
            if (!groups.has(name)) groups.set(name, { color, ranges: [] });
            groups.get(name)!.ranges.push(range);
        }));

        this.names.forEach(name => {
            if (!groups.has(name)) this.registry!.delete(name);
        });
        groups.forEach((group, name) => this.registry!.set(name, new this.Highlight!(...group.ranges)));
        this.names = new Set(groups.keys());

        if (!this.style) this.style = activeDocument.head.createEl('style', { attr: { id: 'hi-note-code-highlights' } });
        const rules = Array.from(groups).map(([name, group]) => `::highlight(${name}) { background-color: ${group.color}; }`);
        rules.push(`::highlight(${FLASH}) { background-color: ${edge}; }`);
        this.style.textContent = rules.join('\n');
    }

    // ── 批注图标 ─────────────────────────────────────────────────────────────

    /** 图标放在哪儿：跟着内容一起滚的那层 */
    private hostOf(view: MarkdownView): HTMLElement | null {
        if (view.getMode() === 'preview') return (view as ViewInternals).previewMode?.containerEl ?? null;
        return this.cmOf(view)?.scrollDOM ?? null;
    }

    /** 和图、公式里的一样，鼠标移到高亮上才出现：图标会盖住代码 */
    private placeWidgets(view: MarkdownView): void {
        const p = this.painted.get(view);
        if (!p) return;
        const host = this.hostOf(view);
        const items: { highlight: HiNote; left: number; top: number }[] = [];
        if (host) {
            const hostBox = host.getBoundingClientRect();
            p.drawn.forEach(({ highlight, range }) => {
                const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
                const last = rects[rects.length - 1];
                if (!last) return;
                items.push({
                    highlight,
                    left: last.right - hostBox.left - host.clientLeft + host.scrollLeft,
                    top: last.top - hostBox.top - host.clientTop + host.scrollTop
                });
            });
        }

        const key = items.map(({ highlight, left, top }) => [
            highlight.id, Math.round(left), Math.round(top),
            (highlight.comments || []).map(c => `${c.id}@${c.updatedAt}`).join(',')
        ].join(':')).join('|');
        if (p.overlay?.isConnected && p.overlay.parentElement === host && key === p.widgetKey) return;

        p.overlay?.remove();
        p.overlay = null;
        p.widgets = [];
        p.widgetKey = key;
        if (!host || !items.length) return;

        if (getComputedStyle(host).position === 'static') host.addClass('hi-note-code-host');
        const overlay = host.createDiv({ cls: 'hi-note-code-widgets' });
        for (const { highlight, left, top } of items) {
            const widget = overlay.createSpan({ cls: 'hi-note-widget hi-note-figure-widget hi-note-code-widget' });
            widget.dataset.highlightId = highlight.id;
            widget.style.left = `${left}px`;
            widget.style.top = `${top}px`;

            const comments = highlight.comments || [];
            const button = CommentWidgetHelper.createButton(widget, false);
            const openPanel = () => CommentWidgetHelper.openCommentPanel(this.app, highlight, this.eventManager);
            if (comments.length > 0) {
                const icon = button.querySelector('.hi-note-icon-container') as HTMLElement;
                CommentWidgetHelper.addCommentCount(icon, comments.length);
                const tooltip = CommentWidgetHelper.createTooltip(this.app, highlight);
                CommentWidgetHelper.setupTooltipEvents(button, widget, tooltip);
                CommentWidgetHelper.setupClickEvent(button, tooltip, openPanel);
                CommentWidgetHelper.createCleanupObserver(widget, tooltip);
            } else {
                button.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    void openPanel();
                });
            }
            // 实时预览里别让编辑器把这一下当成点在正文上
            widget.addEventListener('mousedown', event => event.stopPropagation());
            p.widgets.push(widget);
        }
        p.overlay = overlay;
        if (this.hover?.view === view) this.setHover(this.hover, true);
    }

    /** 屏幕上这一点落在哪处高亮上 */
    private highlightAt(x: number, y: number): Hit | null {
        for (const [view, p] of Array.from(this.painted)) {
            for (const { highlight, range } of p.drawn) {
                const inside = Array.from(range.getClientRects()).some(r =>
                    x >= r.left - 1 && x <= r.right + 1 && y >= r.top && y <= r.bottom);
                if (inside) return { view, highlight };
            }
        }
        return null;
    }

    /** 鼠标停在高亮上时，才把它的批注按钮露出来 */
    private onMouseMove(event: MouseEvent): void {
        const target = event.target as Element | null;
        if (target?.closest?.('.hi-note-code-widget')) return;
        let next: { view: MarkdownView; id: string } | null = null;
        if (this.painted.size && target?.closest?.('pre, .HyperMD-codeblock')) {
            const hit = this.highlightAt(event.clientX, event.clientY);
            if (hit?.highlight.id) next = { view: hit.view, id: hit.highlight.id };
        }
        if (this.hover?.id === next?.id && this.hover?.view === next?.view) return;
        this.setHover(this.hover, false);
        this.hover = next;
        this.setHover(next, true);
    }

    private setHover(entry: { view: MarkdownView; id: string } | null, on: boolean): void {
        if (!entry) return;
        const widget = this.painted.get(entry.view)?.widgets.find(w => w.dataset.highlightId === entry.id);
        widget?.querySelector('.hi-note-button')?.toggleClass('hi-note-button-hidden', !on);
    }

    private flash(view: MarkdownView, id: string, retry = true): void {
        const rangesOf = () => (this.painted.get(view)?.drawn || [])
            .filter(d => d.highlight.id === id)
            .map(d => d.range);
        if (!rangesOf().length) {
            // 刚滚过来，编辑器可能还没画好那几行
            if (retry) window.setTimeout(() => this.flash(view, id, false), 400);
            return;
        }
        if (this.flashTimer) window.clearInterval(this.flashTimer);
        let tick = 0;
        const step = () => {
            const ranges = rangesOf();
            if (tick % 2 === 0 && ranges.length) this.registry!.set(FLASH, new this.Highlight!(...ranges));
            else this.registry!.delete(FLASH);
            if (++tick >= 6) {
                window.clearInterval(this.flashTimer!);
                this.flashTimer = null;
                this.registry!.delete(FLASH);
            }
        };
        step();
        this.flashTimer = window.setInterval(step, 225);
    }

    // ── 划高亮：选中代码块里的字 → 小工具条 ───────────────────────────────────

    private selectionInCode(): CodeSelection | null {
        const selection = activeWindow.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const common = range.commonAncestorContainer;
        const el = common.nodeType === 1 ? common as Element : common.parentElement;
        if (!el) return null;
        const view = this.viewOf(el);
        if (!view?.file) return null;
        const { blocks } = this.blocksOf(view);

        let index: number | null;
        let from: number;
        let to: number;
        const code = el.closest('pre > code');
        if (code && !code.closest('.markdown-embed')) {
            index = this.blockFor(view, code);
            from = charOffset(code, range.startContainer, range.startOffset);
            to = charOffset(code, range.endContainer, range.endOffset);
        } else {
            const cm = this.cmOf(view);
            if (!cm || !cm.contentDOM.contains(el)) return null;
            if (!this.isEditorCodeLine(range.startContainer) || !this.isEditorCodeLine(range.endContainer)) return null;
            try {
                const a = CodeSource.at(blocks, cm.posAtDOM(range.startContainer, range.startOffset));
                const b = CodeSource.at(blocks, cm.posAtDOM(range.endContainer, range.endOffset));
                if (!a || !b || a.block !== b.block) return null;
                index = a.block;
                from = a.code;
                to = b.code;
            } catch {
                return null;
            }
        }
        if (index == null) return null;

        // 拖选常常带上两头的空格和换行，高亮别把它们也涂上
        const block = blocks[index];
        while (from < to && /\s/.test(block.code[from])) from++;
        while (to > from && /\s/.test(block.code[to - 1])) to--;
        if (from >= to) return null;
        return { file: view.file, block, from, to, text: block.code.slice(from, to) };
    }

    private showToolbarForSelection(event: MouseEvent): void {
        if (this.toolbar?.contains(event.target as Node)) return;
        const found = this.selectionInCode();
        if (!found) return;

        this.hideToolbar();
        const box = activeWindow.getSelection()!.getRangeAt(0).getBoundingClientRect();
        const toolbar = activeDocument.body.createDiv({ cls: 'hi-note-figure-toolbar' });
        const add = (icon: string, label: string, withComment: boolean) => {
            const button = toolbar.createEl('button', { cls: 'hi-note-figure-toolbar-button' });
            setIcon(button.createSpan(), icon);
            button.createSpan({ text: label });
            button.addEventListener('mousedown', e => e.preventDefault()); // 别把选区点没了
            button.addEventListener('click', () => {
                this.hideToolbar();
                void this.addHighlight(found, withComment);
            });
        };
        add('highlighter', t('Highlight'), false);
        add('message-circle', t('Comment'), true);

        const width = toolbar.offsetWidth;
        const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), activeWindow.innerWidth - width - 8);
        const above = box.top - toolbar.offsetHeight - 6;
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${above > 8 ? above : box.bottom + 6}px`;
        this.toolbar = toolbar;
    }

    private hideToolbar(): void {
        this.toolbar?.remove();
        this.toolbar = null;
    }

    private async addHighlight(selection: CodeSelection, openComment: boolean): Promise<void> {
        const { file, block, from, to, text } = selection;
        const stored = await this.repository.getFileHighlights(file.path);
        const same = stored.find(h => h.figure?.kind === 'code' && h.figure.path === block.sig
            && h.figure.from[0] === from && h.figure.to[0] === to);

        let highlight: HiNote;
        if (same) {
            highlight = { ...same, filePath: file.path };
        } else {
            const position = CodeSource.toSrc(block, from);
            const anchor: CodeAnchor = { kind: 'code', path: block.sig, label: block.lang, from: [from], to: [to] };
            highlight = {
                id: IdGenerator.generateHighlightId(file.path, position, `${block.sig}#${from}-${to}:${text}`),
                text,
                position,
                figure: anchor,
                backgroundColor: DEFAULT_COLOR,
                comments: [],
                filePath: file.path,
                fileName: file.basename
            };
            await this.highlightManager.addHighlight(file, highlight);
        }

        activeWindow.getSelection()?.removeAllRanges();
        this.eventManager.emitFigureHighlightChange(file.path);

        if (openComment) {
            // 侧栏收到上面的事件后要先把这张卡片画出来，才能在上面打开批注框
            window.setTimeout(() => {
                void CommentWidgetHelper.openCommentPanel(this.app, highlight, this.eventManager);
            }, 250);
        }
    }

    private async removeHighlight(highlight: HiNote): Promise<void> {
        const file = highlight.filePath ? this.app.vault.getAbstractFileByPath(highlight.filePath) : null;
        if (!(file instanceof TFile)) return;

        if (highlight.comments?.length) {
            const confirmed = await showConfirmModal(this.app, {
                title: t('Remove highlight'),
                message: t('This highlight has comments. Removing it deletes them too.')
            });
            if (!confirmed) return;
        }

        await this.highlightManager.removeHighlight(file, highlight);
        this.eventManager.emitFigureHighlightChange(file.path);
    }

    // ── 右键：批注 / 去掉高亮 ────────────────────────────────────────────────

    private fillMenu(menu: Menu, hit: Hit | null, picked: CodeSelection | null): void {
        if (picked) {
            menu.addItem(item => item.setTitle(t('Highlight')).setIcon('highlighter')
                .onClick(() => void this.addHighlight(picked, false)));
            menu.addItem(item => item.setTitle(t('Comment')).setIcon('message-circle')
                .onClick(() => void this.addHighlight(picked, true)));
        }
        if (hit) {
            if (picked) menu.addSeparator();
            menu.addItem(item => item.setTitle(t('Comment')).setIcon('message-circle')
                .onClick(() => void CommentWidgetHelper.openCommentPanel(this.app, hit.highlight, this.eventManager)));
            menu.addItem(item => item.setTitle(t('Remove highlight')).setIcon('eraser')
                .onClick(() => void this.removeHighlight(hit.highlight)));
        }
    }

    /** 阅读模式（和实时预览里画成块的 callout）里的代码块：自己弹菜单 */
    private onContextMenu(event: MouseEvent): void {
        this.lastContextMenu = event;
        const target = event.target as Element | null;
        const pre = target?.closest?.('pre');
        if (!pre || !this.viewOf(pre)) return;

        const hit = this.highlightAt(event.clientX, event.clientY);
        const picked = this.selectionInCode();
        if (!hit && !picked) return;

        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu();
        this.fillMenu(menu, hit, picked);
        menu.showAtMouseEvent(event);
    }

    /** 实时预览里的代码行：编辑器有自己的右键菜单（剪切、复制……），加在它后面 */
    private onEditorMenu(menu: Menu): void {
        const event = this.lastContextMenu;
        const target = event?.target as Element | null;
        if (!event || !target?.closest?.('.HyperMD-codeblock')) return;
        const hit = this.highlightAt(event.clientX, event.clientY);
        const picked = this.selectionInCode();
        if (!hit && !picked) return;
        menu.addSeparator();
        this.fillMenu(menu, hit, picked);
    }
}

function trimNewlines(s: string): string {
    return s.replace(/\n+$/, '');
}

/** 选区一端在这个元素里是第几个字 */
function charOffset(el: Element, node: Node, offset: number): number {
    const range = activeDocument.createRange();
    range.setStart(el, 0);
    range.setEnd(node, offset);
    return range.toString().length;
}

/** 元素里第 from 到第 to 个字（不含）的 Range */
export function rangeIn(el: Element, from: number, to: number): Range | null {
    const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = activeDocument.createRange();
    let seen = 0;
    let started = false;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const length = node.data.length;
        if (!started && from < seen + length) {
            range.setStart(node, from - seen);
            started = true;
        }
        if (started && to <= seen + length) {
            range.setEnd(node, to - seen);
            return range;
        }
        seen += length;
    }
    return null;
}
