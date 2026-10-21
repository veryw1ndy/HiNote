import { App, MarkdownPostProcessorContext, MarkdownView, Menu, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type { HighlightInfo as HiNote, MathAnchor } from '../types/highlight';
import type { HiNotePluginContext } from '../types/plugin';
import type { HighlightRepository } from '../repositories/HighlightRepository';
import type { HighlightManager } from '../services/HighlightManager';
import type { EventManager, HighlightEvents } from '../services/EventManager';
import type { HighlightService } from '../services/HighlightService';
import type { HighlightDecorator } from '../editor/HighlightDecorator';
import { IdGenerator } from '../utils/IdGenerator';
import { CommentWidgetHelper } from '../components/comment/CommentWidgetHelper';
import { t } from '../i18n';
import { showConfirmModal } from '../utils/ConfirmModal';
import { FIGURE_FLASH_EVENT } from '../figure/FigureHighlighter';
import { MathDom } from './mathDom';
import { MathSource, MathSpot } from './mathSource';
import { MathLayer } from './MathLayer';

const DEFAULT_COLOR = '#ffeb3b';
const EDITOR_BLOCK = '.table-wrapper, .cm-embed-block';

type CodeMirrorView = {
    state: { doc: { lineAt(pos: number): { number: number; from: number; to: number }; line(n: number): { text: string; from: number; to: number }; lines: number } };
    posAtDOM(node: Node): number;
};

/** Obsidian 没公开的：编辑器底下的 CodeMirror，阅读模式分好的段 */
type ViewInternals = MarkdownView & {
    editor: { cm?: CodeMirrorView };
    previewMode: { renderer?: { sections?: { el?: HTMLElement; lineStart: number; lineEnd: number }[] } };
};

interface Drag {
    layer: MathLayer;
    x: number;
    y: number;
    x1: number;
    y1: number;
    active: boolean;
}

/**
 * 让 HiNote 能划公式的一部分，像划图里的字一样。
 *
 * 在公式上按住拖一个框，框碰到的字形变蓝，弹出「高亮 / 批注」；右键高亮可以批注或去掉。
 * 编辑模式下也一样，不拖只点的话还是打开公式的源码。
 * 高亮和图里的一样存在笔记自己的 HiNote 文件里（figure.kind 是 'math'），
 * 所以侧栏、批注、闪卡、导出都照常能用。
 *
 * 整个公式用 ==$…$== 标出来的是 HiNote 自己的正文高亮，见 PreviewHighlightResolver。
 */
export class MathHighlighter {
    private app: App;
    private layers = new Set<MathLayer>();
    private layerOf = new WeakMap<Element, MathLayer>();
    private watched = new WeakSet<HTMLElement>();
    private observers: MutationObserver[] = [];
    private scanQueued = new Set<WorkspaceLeaf>();
    private widgets = new Map<MathLayer, HTMLElement[]>();
    private toolbar: HTMLElement | null = null;
    private pending: { layer: MathLayer; leaves: number[] } | null = null;
    private band: HTMLElement | null = null;
    private drag: Drag | null = null;
    private upHandler: ((event: MouseEvent) => void) | null = null;
    private eatClick = false;
    private hover: { layer: MathLayer; id: string } | null = null;
    private markTries = new WeakMap<Element, number>();
    private repaired = new Set<string>();
    private unwatchModeSwitch: (() => void) | null = null;

    constructor(
        private plugin: HiNotePluginContext,
        private repository: HighlightRepository,
        private highlightManager: HighlightManager,
        private eventManager: EventManager,
        private highlightService: HighlightService,
        private highlightDecorator: HighlightDecorator
    ) {
        this.app = plugin.app;
    }

    enable(): void {
        const { workspace } = this.app;
        workspace.onLayoutReady(() => this.watchLeaves());
        this.plugin.registerEvent(workspace.on('layout-change', () => this.watchLeaves()));
        this.plugin.registerEvent(workspace.on('file-open', () => this.watchLeaves()));

        const dataEvents: (keyof HighlightEvents)[] = [
            'highlight:update', 'highlight:delete', 'comment:update', 'comment:delete', 'figure-highlight:change'
        ];
        dataEvents.forEach(name => {
            this.plugin.registerEvent(this.eventManager.on(name, () => void this.redrawAll()));
        });
        this.watchModeSwitch();

        this.plugin.registerDomEvent(activeDocument, 'mousedown', event => this.onMouseDown(event), { capture: true });
        this.plugin.registerDomEvent(activeDocument, 'mousemove', event => this.onMouseMove(event));
        this.plugin.registerDomEvent(activeDocument, 'click', event => this.onClick(event), { capture: true });
        this.plugin.registerDomEvent(activeDocument, 'keydown', event => {
            if (event.key === 'Escape') this.clearPending();
        });
        this.plugin.registerDomEvent(activeDocument, 'contextmenu', event => this.onContextMenu(event), { capture: true });
    }

    disable(): void {
        this.observers.forEach(observer => observer.disconnect());
        this.observers = [];
        this.layers.forEach(layer => this.dropLayer(layer));
        this.endDrag();
        this.hideToolbar();
        this.unwatchModeSwitch?.();
        this.unwatchModeSwitch = null;
    }

    // ── 阅读 / 编辑切换 ──────────────────────────────────────────────────────

    /**
     * 阅读模式和编辑模式是两页，只显示一页。在一页上加的高亮或批注，画到另一页时那页没有大小，
     * 所以切过去看到的是旧的，要重载 HiNote 才对。每次切换都按存下的高亮重画显示出来的那页：
     * 公式，还有它表格里的 ==标记==。Obsidian 切换时没有事件，只好包一下 setMode。
     */
    private watchModeSwitch(): void {
        const proto = MarkdownView.prototype as unknown as { setMode?: (...args: unknown[]) => unknown };
        const orig = proto.setMode;
        if (typeof orig !== 'function' || (orig as { hiMath?: boolean }).hiMath) return;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const wrapped = function (this: MarkdownView, ...args: unknown[]) {
            const result = orig.apply(this, args);
            const after = () => self.onModeSwitch(this);
            if (result && typeof (result as Promise<unknown>).then === 'function') {
                (result as Promise<unknown>).then(after, after);
            } else {
                after();
            }
            return result;
        };
        (wrapped as { hiMath?: boolean }).hiMath = true;
        proto.setMode = wrapped;
        this.unwatchModeSwitch = () => {
            if (proto.setMode === wrapped) proto.setMode = orig;
        };
    }

    private onModeSwitch(view: MarkdownView): void {
        if (!view?.file) return;
        const file = view.file;
        const root = view.containerEl;
        // 等两帧：那时刚显示出来的页面才有大小
        window.requestAnimationFrame(() => window.requestAnimationFrame(async () => {
            try {
                const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view === view);
                if (leaf) this.queueScan(leaf);
                const all = await this.repository.getFileHighlights(file.path);
                this.layers.forEach(layer => {
                    if (layer.connected && root.contains(layer.container)) this.paint(layer, all);
                });
                this.markTries = new WeakMap();
                await this.highlightDecorator.previewRenderer.refresh(file, root);
                this.adoptMarks(view);
            } catch (error) {
                console.error('[HiNote] 切换模式后重画公式高亮失败:', error);
            }
        }));
    }

    // ── 找到笔记里的公式 ──────────────────────────────────────────────────────

    private watchLeaves(): void {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const root = leaf.view.containerEl;
            if (!this.watched.has(root)) {
                this.watched.add(root);
                const observer = new MutationObserver(mutations => {
                    // 我们自己画的色块和按钮不算
                    const mine = (node: Node) => {
                        const el = node.nodeType === 1 ? node as Element : node.parentElement;
                        return el?.closest?.('.hi-note-math-marks, .hi-note-widget');
                    };
                    if (mutations.every(m => mine(m.target))) return;
                    this.queueScan(leaf);
                });
                observer.observe(root, { childList: true, subtree: true });
                this.observers.push(observer);
                root.addEventListener(FIGURE_FLASH_EVENT, (event: Event) => {
                    const id = (event as CustomEvent<string>).detail;
                    this.layers.forEach(layer => {
                        if (root.contains(layer.container) && layer.hasHighlight(id)) layer.flash(id);
                    });
                });
            }
            this.queueScan(leaf);
        });
    }

    private queueScan(leaf: WorkspaceLeaf): void {
        if (this.scanQueued.has(leaf)) return;
        this.scanQueued.add(leaf);
        window.requestAnimationFrame(() => {
            this.scanQueued.delete(leaf);
            void this.scan(leaf);
        });
    }

    private async scan(leaf: WorkspaceLeaf): Promise<void> {
        this.layers.forEach(layer => {
            if (!layer.connected) this.dropLayer(layer);
        });
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || !view.file) return;
        if (!this.highlightService.shouldProcessFile(view.file)) return;
        const path = view.file.path;

        const found = Array.from(view.containerEl.querySelectorAll<HTMLElement>('mjx-container'))
            .filter(c => !c.closest('.markdown-embed') && !c.closest('.hi-note-widget'));
        const fresh: MathLayer[] = [];
        for (const c of found) {
            const old = this.layerOf.get(c);
            if (old?.connected) continue;
            if (!MathDom.ready(c)) continue;
            const layer = new MathLayer(c, MathDom.signature(c), path);
            layer.onDrawn = (l, drawn) => this.placeWidgets(l, drawn);
            this.layers.add(layer);
            this.layerOf.set(c, layer);
            fresh.push(layer);
        }
        this.adoptMarks(view);
        if (!fresh.length) return;
        const all = await this.repository.getFileHighlights(path);
        fresh.forEach(layer => this.paint(layer, all));
    }

    /**
     * 实时预览里表格（和别的块）是编辑器外面画的，HiNote 的编辑器扩展看不到里面的 ==标记==：
     * 一直是黄的，也没有批注按钮。交给阅读模式那套去配，并说明块覆盖原文的哪几行。
     */
    private adoptMarks(view: MarkdownView): void {
        const renderer = this.highlightDecorator.previewRenderer;
        const cm = (view as ViewInternals).editor?.cm;
        if (!cm || !view.file || view.getMode() !== 'source') return;
        // 表格重画一个格子时，配好的标记会丢掉按钮，所以再配一次（最多几次，免得有东西一直在拆它）
        const marks = Array.from(view.containerEl.querySelectorAll('.markdown-source-view mark, .markdown-source-view span.highlight'))
            .filter(mark => mark.closest(EDITOR_BLOCK) && !renderer.isRendered(mark) && (this.markTries.get(mark) || 0) < 4);
        if (!marks.length) return;
        marks.forEach(mark => this.markTries.set(mark, (this.markTries.get(mark) || 0) + 1));

        const getSectionInfo = (el: HTMLElement) => {
            try {
                const doc = cm.state.doc;
                const a = doc.lineAt(cm.posAtDOM(el.closest(EDITOR_BLOCK)!)).number;
                let b = a;
                while (b < doc.lines && doc.line(b + 1).text.trim() !== '') b++;
                return { lineStart: a - 1, lineEnd: b - 1, text: '' };
            } catch {
                return null;
            }
        };
        const context = { sourcePath: view.file.path, getSectionInfo } as unknown as MarkdownPostProcessorContext;
        const file = view.file;
        // HiNote 配批注用的是缓存，文件的高亮读过一次之前缓存是空的，这时去配，有批注的也配不上
        this.repository.getFileHighlights(file.path)
            .then(() => this.highlightDecorator.previewRenderer.adoptMarks(file, marks, view.containerEl, context))
            .catch(error => console.error('[HiNote] 编辑模式表格里的高亮配批注失败:', error));
    }

    // ── 公式在原文的哪儿 ──────────────────────────────────────────────────────

    private viewOf(container: HTMLElement): MarkdownView | null {
        const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view.containerEl.contains(container));
        return leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
    }

    /** 页面上这个公式在笔记原文里的位置（说不准时 position 是 null） */
    private whereIs(layer: MathLayer): { src: string; position: number | null } | null {
        const c = layer.container;
        const view = this.viewOf(c);
        if (!view?.file) return null;
        const src = view.data;
        const latex = MathDom.latex(c);
        if (!latex) return { src, position: null };
        const at = this.pageSpot(view, c, src);
        return { src, position: at ? MathSource.place(src, latex, at) : null };
    }

    /** 公式在页面上的哪儿，换成原文的说法（见 MathSource.place） */
    private pageSpot(view: MarkdownView, c: HTMLElement, src: string): MathSpot | null {
        let scope: Element | null = null;
        let from = 0;
        let to = 0;
        try {
            if (c.closest('.markdown-source-view')) {
                const cm = (view as ViewInternals).editor?.cm;
                if (!cm) return null;
                const doc = cm.state.doc;
                const block = c.closest(EDITOR_BLOCK);
                if (block) {
                    const a = doc.lineAt(cm.posAtDOM(block)).number;
                    let b = a;
                    while (b < doc.lines && doc.line(b + 1).text.trim() !== '') b++;
                    scope = block;
                    from = doc.line(a).from;
                    to = doc.line(b).to;
                } else {
                    const line = doc.lineAt(cm.posAtDOM(c));
                    scope = c.closest('.cm-line') || c.parentElement;
                    from = line.from;
                    to = line.to;
                }
            } else {
                const sections = (view as ViewInternals).previewMode?.renderer?.sections || [];
                const s = sections.find(q => q.el?.contains(c));
                if (!s) return null;
                const lineOffset = (n: number) => {
                    let p = 0;
                    for (let i = 0; i < n && p >= 0; i++) p = src.indexOf('\n', p) + 1 || -1;
                    return p;
                };
                from = lineOffset(s.lineStart);
                const end = lineOffset(s.lineEnd);
                if (from < 0 || end < 0) return null;
                const e = src.indexOf('\n', end);
                to = e < 0 ? src.length : e;
                scope = s.el!;
            }
        } catch {
            return null;
        }
        if (!scope) return null;
        const latex = MathDom.strip(c);
        const same = (root: Element) => Array.from(root.querySelectorAll('mjx-container')).filter(x => MathDom.strip(x) === latex);
        const at: MathSpot = { from, to, nth: same(scope).indexOf(c) };
        const cell = c.closest('td, th');
        const table = cell?.closest('table');
        if (cell && table && scope.contains(table)) {
            at.table = Array.from(scope.querySelectorAll('table')).indexOf(table);
            at.row = Array.from(table.rows).indexOf(cell.parentElement as HTMLTableRowElement);
            at.col = Array.from(cell.parentElement!.children).filter(x => x.matches('td, th')).indexOf(cell);
            at.nthInCell = same(cell).indexOf(c);
        }
        return at;
    }

    /** 高亮是不是做在页面上这一份公式上（同一公式出现好几次时） */
    private isHere(where: { src: string; position: number | null } | null, h: HiNote): boolean {
        if (!where || where.position == null) return true;
        const p = MathSource.resolve(where.src, h);
        return p == null || p === where.position;
    }

    // ── 画高亮 ───────────────────────────────────────────────────────────────

    private paint(layer: MathLayer, all: HiNote[]): void {
        const where = this.whereIs(layer);
        const mine = all
            .filter(h => h.figure?.kind === 'math' && h.figure.path === layer.sig && this.isHere(where, h))
            .map(h => ({ ...h, filePath: layer.sourcePath }));
        layer.setHighlights(mine);
        mine.forEach(h => {
            if (h.figure?.kind === 'math' && !h.figure.tex) void this.repair(layer, h);
        });
    }

    /** 以前在阅读模式下做的高亮没记公式在哪儿（那时还不按 LaTeX 找公式）：现在补上，只补一次 */
    private async repair(layer: MathLayer, h: HiNote): Promise<void> {
        if (!h.id || this.repaired.has(h.id)) return;
        this.repaired.add(h.id);
        const file = this.app.vault.getAbstractFileByPath(layer.sourcePath);
        if (!(file instanceof TFile)) return;
        const loc = MathSource.locate(await this.app.vault.cachedRead(file), MathDom.latex(layer.container));
        if (!loc) return;
        const stored = (await this.repository.getFileHighlights(file.path)).find(x => x.id === h.id);
        if (stored?.figure?.kind !== 'math' || stored.figure.tex) return;
        await this.highlightManager.addHighlight(file, {
            ...stored, position: loc.position, figure: { ...stored.figure, tex: loc.tex }
        });
    }

    private async redrawAll(): Promise<void> {
        const byFile = new Map<string, HiNote[]>();
        for (const layer of this.layers) {
            if (!byFile.has(layer.sourcePath)) {
                byFile.set(layer.sourcePath, await this.repository.getFileHighlights(layer.sourcePath));
            }
            this.paint(layer, byFile.get(layer.sourcePath)!);
        }
    }

    private dropLayer(layer: MathLayer): void {
        this.clearWidgets(layer);
        layer.destroy();
        this.layers.delete(layer);
        this.layerOf.delete(layer.container);
    }

    /** 批注按钮，和图里的一样：鼠标移到高亮上才出现 */
    private placeWidgets(layer: MathLayer, highlights: HiNote[]): void {
        this.clearWidgets(layer);
        const widgets: HTMLElement[] = [];
        for (const highlight of highlights) {
            if (!highlight.id) continue;
            const point = layer.anchorPoint(highlight.id);
            if (!point) continue;

            const widget = layer.container.createSpan({ cls: 'hi-note-widget hi-note-figure-widget hi-note-math-widget' });
            widget.dataset.highlightId = highlight.id;
            widget.style.left = `${point.left}px`;
            widget.style.top = `${point.top}px`;

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
            widget.addEventListener('mousedown', event => event.stopPropagation());
            widgets.push(widget);
        }
        this.widgets.set(layer, widgets);
        if (this.hover?.layer === layer) this.setHover(this.hover, true);
    }

    private clearWidgets(layer: MathLayer): void {
        this.widgets.get(layer)?.forEach(widget => widget.remove());
        this.widgets.delete(layer);
    }

    /** 鼠标停在高亮上时，才把它的批注按钮露出来 */
    private onMouseMove(event: MouseEvent): void {
        if (this.drag) {
            this.onDragMove(event);
            return;
        }
        const target = event.target as Element | null;
        if (target?.closest?.('.hi-note-math-widget')) return;
        let next: { layer: MathLayer; id: string } | null = null;
        const c = target?.closest?.('mjx-container');
        const layer = c && this.layerOf.get(c);
        if (layer) {
            const highlight = layer.highlightAt(event.clientX, event.clientY);
            if (highlight?.id) next = { layer, id: highlight.id };
        }
        if (this.hover && next && this.hover.id === next.id && this.hover.layer === next.layer) return;
        this.setHover(this.hover, false);
        this.hover = next;
        this.setHover(next, true);
    }

    private setHover(entry: { layer: MathLayer; id: string } | null, on: boolean): void {
        if (!entry) return;
        const widget = this.widgets.get(entry.layer)?.find(w => w.dataset.highlightId === entry.id);
        widget?.querySelector('.hi-note-button')?.toggleClass('hi-note-button-hidden', !on);
    }

    // ── 在公式上拖一个框 ──────────────────────────────────────────────────────

    private onMouseDown(event: MouseEvent): void {
        if (event.button !== 0) return;
        this.eatClick = false;
        const target = event.target as Element | null;
        if (this.toolbar && target && this.toolbar.contains(target)) return;
        const c = target?.closest?.('mjx-container');
        const layer = c && this.layerOf.get(c);
        if (!layer || target?.closest?.('.hi-note-math-widget')) {
            this.clearPending();
            return;
        }
        // 编辑模式下，按下再松开的那次 click 会打开公式的源码。只点一下就让它打开；
        // 拖完松开的那次 click 吞掉（onClick）。
        event.preventDefault();
        event.stopPropagation();
        this.clearPending();
        this.drag = { layer, x: event.clientX, y: event.clientY, x1: event.clientX, y1: event.clientY, active: false };
        this.upHandler = ev => this.onDragEnd(ev);
        activeDocument.addEventListener('mouseup', this.upHandler, true);
    }

    private onDragMove(event: MouseEvent): void {
        const d = this.drag!;
        d.x1 = event.clientX;
        d.y1 = event.clientY;
        if (!d.active) {
            if (Math.hypot(d.x1 - d.x, d.y1 - d.y) < 4) return;
            d.active = true;
            this.band = activeDocument.body.createDiv({ cls: 'hi-note-math-band' });
        }
        event.preventDefault();
        const b = this.band!.style;
        b.left = `${Math.min(d.x, d.x1)}px`;
        b.top = `${Math.min(d.y, d.y1)}px`;
        b.width = `${Math.abs(d.x1 - d.x)}px`;
        b.height = `${Math.abs(d.y1 - d.y)}px`;
        d.layer.setPending(MathDom.pick(d.layer.container, { x0: d.x, y0: d.y, x1: d.x1, y1: d.y1 }));
    }

    private onDragEnd(event: MouseEvent): void {
        const d = this.drag;
        this.endDrag();
        if (!d || !d.active) return;
        event.preventDefault();
        event.stopPropagation();
        this.eatClick = true;
        const leaves = MathDom.pick(d.layer.container, { x0: d.x, y0: d.y, x1: event.clientX, y1: event.clientY });
        d.layer.setPending(leaves);
        if (!leaves.length) return;
        this.pending = { layer: d.layer, leaves };
        this.showToolbar(Math.max(d.x, event.clientX), Math.min(d.y, event.clientY));
    }

    /** 拖完松开的那次 click：不吞掉的话，编辑模式会打开公式的源码，选中的公式就没了 */
    private onClick(event: MouseEvent): void {
        if (!this.eatClick) return;
        this.eatClick = false;
        event.preventDefault();
        event.stopPropagation();
    }

    private endDrag(): void {
        if (this.upHandler) activeDocument.removeEventListener('mouseup', this.upHandler, true);
        this.upHandler = null;
        this.band?.remove();
        this.band = null;
        this.drag = null;
    }

    private clearPending(): void {
        this.hideToolbar();
        this.pending?.layer.setPending([]);
        this.pending = null;
    }

    private showToolbar(right: number, top: number): void {
        this.hideToolbar();
        const toolbar = activeDocument.body.createDiv({ cls: 'hi-note-figure-toolbar' });
        const add = (icon: string, label: string, withComment: boolean) => {
            const button = toolbar.createEl('button', { cls: 'hi-note-figure-toolbar-button' });
            setIcon(button.createSpan(), icon);
            button.createSpan({ text: label });
            button.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
            });
            button.addEventListener('click', () => {
                const picked = this.pending;
                this.clearPending();
                if (picked) void this.addHighlight(picked.layer, picked.leaves, withComment);
            });
        };
        add('highlighter', t('Highlight'), false);
        add('message-circle', t('Comment'), true);

        const width = toolbar.offsetWidth;
        toolbar.style.left = `${Math.min(Math.max(8, right - width), activeWindow.innerWidth - width - 8)}px`;
        const above = top - toolbar.offsetHeight - 6;
        toolbar.style.top = `${above > 8 ? above : top + 24}px`;
        this.toolbar = toolbar;
    }

    private hideToolbar(): void {
        this.toolbar?.remove();
        this.toolbar = null;
    }

    // ── 存 ──────────────────────────────────────────────────────────────────

    /**
     * 公式在笔记哪儿：编辑模式问编辑器，否则按公式自己的 LaTeX 在原文里找。
     * 只用来跳回去和给侧栏排序。
     */
    private async mathSource(file: TFile, layer: MathLayer): Promise<{ position: number; tex: string }> {
        const src = await this.app.vault.cachedRead(file);
        const view = this.app.workspace.getLeavesOfType('markdown')
            .map(l => l.view)
            .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
        try {
            const cm = view && (view as ViewInternals).editor?.cm;
            if (cm && view.getMode() === 'source') {
                const pos = cm.posAtDOM(layer.container);
                const m = /^\$\$[\s\S]*?\$\$|^\$[^$\n]+?\$/.exec(src.slice(pos));
                if (m) return { position: pos, tex: m[0] };
            }
        } catch {
            // 编辑器说不出来，下面按 LaTeX 找
        }
        return MathSource.locate(src, MathDom.latex(layer.container)) || { position: 0, tex: '' };
    }

    private async addHighlight(layer: MathLayer, leaves: number[], openComment: boolean): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(layer.sourcePath);
        if (!(file instanceof TFile)) return;

        const key = leaves.join(',');
        const stored = await this.repository.getFileHighlights(file.path);
        const where = this.whereIs(layer);
        const same = stored.find(h => h.figure?.kind === 'math' && h.figure.path === layer.sig &&
            Array.isArray(h.figure.leaves) && h.figure.leaves.join(',') === key && this.isHere(where, h));

        let highlight: HiNote;
        if (same) {
            highlight = { ...same, filePath: file.path };
        } else {
            // 是页面上这一份公式，不是第一个 LaTeX 一样的
            const occ = where && where.position != null
                ? MathSource.occurrences(where.src, MathDom.latex(layer.container)).find(o => o.position === where.position)
                : undefined;
            const src = occ ? { position: occ.position, tex: occ.tex } : await this.mathSource(file, layer);
            const text = MathDom.textOf(layer.container, leaves);
            const figure: MathAnchor = {
                kind: 'math', path: layer.sig, label: 'formula', tex: src.tex,
                leaves, from: [leaves[0]], to: [leaves[leaves.length - 1]]
            };
            if (occ) {
                figure.line = occ.line;
                figure.lineNth = occ.lineNth;
            }
            highlight = {
                id: IdGenerator.generateHighlightId(file.path, src.position, `${layer.sig}#${key}:${text}`),
                text,
                position: src.position,
                figure,
                backgroundColor: DEFAULT_COLOR,
                comments: [],
                filePath: file.path,
                fileName: file.basename
            };
            await this.highlightManager.addHighlight(file, highlight);
        }

        this.eventManager.emitFigureHighlightChange(file.path);
        if (openComment) {
            // 侧栏收到上面的事件后要先把这张卡片画出来，才能在上面打开批注框
            window.setTimeout(() => {
                void CommentWidgetHelper.openCommentPanel(this.app, highlight, this.eventManager);
            }, 250);
        }
    }

    private async removeHighlight(layer: MathLayer, highlight: HiNote): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(layer.sourcePath);
        if (!(file instanceof TFile)) return;
        if ((highlight.comments?.length ?? 0) > 0) {
            const confirmed = await showConfirmModal(this.app, {
                title: t('Remove highlight'),
                message: t('This highlight has comments. Removing it deletes them too.')
            });
            if (!confirmed) return;
        }
        await this.highlightManager.removeHighlight(file, highlight);
        this.eventManager.emitFigureHighlightChange(file.path);
    }

    // ── 右键：高亮 / 批注 / 去掉高亮 ───────────────────────────────────────────

    private onContextMenu(event: MouseEvent): void {
        const target = event.target as Element | null;
        const c = target?.closest?.('mjx-container');
        const layer = c && this.layerOf.get(c);
        if (!layer) return;
        const highlight = layer.highlightAt(event.clientX, event.clientY);
        const picked = this.pending && this.pending.layer === layer ? this.pending : null;
        if (!highlight && !picked) return;

        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu();
        if (picked) {
            menu.addItem(item => item.setTitle(t('Highlight')).setIcon('highlighter').onClick(() => {
                this.clearPending();
                void this.addHighlight(picked.layer, picked.leaves, false);
            }));
            menu.addItem(item => item.setTitle(t('Comment')).setIcon('message-circle').onClick(() => {
                this.clearPending();
                void this.addHighlight(picked.layer, picked.leaves, true);
            }));
        }
        if (highlight) {
            if (picked) menu.addSeparator();
            menu.addItem(item => item.setTitle(t('Comment')).setIcon('message-circle')
                .onClick(() => void CommentWidgetHelper.openCommentPanel(this.app, highlight, this.eventManager)));
            menu.addItem(item => item.setTitle(t('Remove highlight')).setIcon('eraser')
                .onClick(() => void this.removeHighlight(layer, highlight)));
        }
        menu.showAtMouseEvent(event);
    }
}
