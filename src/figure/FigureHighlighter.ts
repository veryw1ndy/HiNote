import { App, FileSystemAdapter, MarkdownView, Menu, TFile, WorkspaceLeaf, getLinkpath, setIcon } from "obsidian";
import { HighlightInfo as HiNote } from "../types/highlight";
import type { HiNotePluginContext } from "../types/plugin";
import type { HighlightRepository } from "../repositories/HighlightRepository";
import type { HighlightManager } from "../services/HighlightManager";
import type { EventManager, HighlightEvents } from "../services/EventManager";
import type { HighlightService } from "../services/HighlightService";
import { IdGenerator } from "../utils/IdGenerator";
import { CommentWidgetHelper } from "../components/comment/CommentWidgetHelper";
import { t } from "../i18n";
import { showConfirmModal } from "../utils/ConfirmModal";
import { FigureLayer, FigureSelection } from "./FigureLayer";
import { loadFigureSvg } from "./figureSvg";
import { OcrReader, RASTER_EXTENSIONS, ocrSvg } from "./ocr";

/** 侧栏点了图里的高亮：LocationService 滚到图那儿，再发这个事件让那一处闪一下 */
export const FIGURE_FLASH_EVENT = 'hi-note-figure-flash';

const DEFAULT_COLOR = '#ffeb3b';

/**
 * 让 HiNote 能划图里的字。
 *
 * 只管笔记里嵌的 .svg 图：它们的字本来就是文字，盖一层透明的字上去就能选。
 * 划下的高亮存在笔记自己的 HiNote 文件里（带 figure 字段），所以侧栏、批注、
 * 闪卡、导出都和正文高亮一样用。
 */
export class FigureHighlighter {
    private app: App;
    private layers = new Set<FigureLayer>();
    private layerOf = new WeakMap<HTMLImageElement, FigureLayer>();
    private pending = new WeakSet<HTMLImageElement>();
    private watched = new WeakSet<HTMLElement>();
    private observers: MutationObserver[] = [];
    private scanQueued = new Set<WorkspaceLeaf>();

    private toolbar: HTMLElement | null = null;
    private widgets = new Map<FigureLayer, HTMLElement[]>();
    private hoverWidget: { layer: FigureLayer; id: string } | null = null;
    private ocr: OcrReader;

    constructor(
        private plugin: HiNotePluginContext,
        private repository: HighlightRepository,
        private highlightManager: HighlightManager,
        private eventManager: EventManager,
        private highlightService: HighlightService
    ) {
        this.app = plugin.app;
        this.ocr = new OcrReader(this.app, plugin.manifest.dir);
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
            this.plugin.registerEvent(this.eventManager.on(name, (filePath: string) => {
                void this.redraw(filePath);
            }));
        });

        this.plugin.registerDomEvent(activeDocument, 'mouseup', event => {
            // 等浏览器把选区定下来
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
        this.layers.forEach(layer => this.dropLayer(layer));
        this.hideToolbar();
    }

    // ── 找到笔记里的图 ────────────────────────────────────────────────────────

    private watchLeaves(): void {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const container = leaf.view.containerEl;
            if (!this.watched.has(container)) {
                this.watched.add(container);
                // 阅读模式的图是后加载的，实时预览的图是编辑器随滚动画的：都只能盯着 DOM
                const observer = new MutationObserver(() => this.queueScan(leaf));
                observer.observe(container, { childList: true, subtree: true });
                this.observers.push(observer);
                container.addEventListener(FIGURE_FLASH_EVENT, (event: Event) => {
                    const id = (event as CustomEvent<string>).detail;
                    this.layers.forEach(layer => {
                        if (container.contains(layer.svg as unknown as Node) && layer.hasHighlight(id)) layer.flash(id);
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
        // 被编辑器重画掉的图，它的那层也收掉
        this.layers.forEach(layer => {
            if (!layer.connected) this.dropLayer(layer);
        });

        const view = leaf.view;
        if (!(view instanceof MarkdownView) || !view.file) return;
        const sourcePath = view.file.path;
        if (!this.highlightService.shouldProcessFile(view.file)) return;

        const imgs = Array.from(view.containerEl.querySelectorAll('img'));
        for (const img of imgs) {
            if (this.layerOf.has(img) || this.pending.has(img)) continue;
            // 嵌进来的别的笔记里的图，属于那篇笔记，不在这儿管
            if (img.closest('.markdown-embed')) continue;
            if (img.closest('.hi-note-figure-host')?.querySelector('.hi-note-figure-layer')) continue;

            const file = this.resolveFigure(img, sourcePath);
            if (!file) continue;

            this.pending.add(img);
            try {
                const svg = file.extension.toLowerCase() === 'svg'
                    ? await loadFigureSvg(this.app.vault, file)
                    : await this.loadScreenshot(file);
                if (!svg || !img.isConnected) continue;
                const layer = new FigureLayer(img, file.path, sourcePath, svg);
                layer.onDrawn = drawn => this.placeWidgets(layer, drawn);
                this.layers.add(layer);
                this.layerOf.set(img, layer);
                await this.paint(layer);
            } catch (error) {
                console.error('[HiNote] 给图加字层失败:', file.path, error);
            } finally {
                this.pending.delete(img);
            }
        }
    }

    /** 截图：先认字（第一次要一两秒，之后读缓存），再做成字层 */
    private async loadScreenshot(file: TFile): Promise<SVGSVGElement | null> {
        const result = await this.ocr.read(file);
        return result ? ocrSvg(result) : null;
    }

    /** <img> 指向库里哪个图片文件：.svg 直接用里面的字，截图要能认字才算 */
    private resolveFigure(img: HTMLImageElement, sourcePath: string): TFile | null {
        let file: TFile | null = null;

        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter && img.src) {
            try {
                const absolute = decodeURIComponent(new URL(img.src).pathname);
                const base = adapter.getBasePath().replace(/\/$/, '');
                if (absolute.startsWith(base + '/')) {
                    const found = this.app.vault.getAbstractFileByPath(absolute.slice(base.length + 1));
                    if (found instanceof TFile) file = found;
                }
            } catch {
                // 不是 app:// 地址（外链图片之类），下面再试
            }
        }

        if (!file) {
            const link = img.closest('.internal-embed')?.getAttribute('src');
            if (link) file = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link), sourcePath);
        }

        if (!file) return null;
        const extension = file.extension.toLowerCase();
        if (extension === 'svg') return file;
        return RASTER_EXTENSIONS.has(extension) && this.ocr.available ? file : null;
    }

    private dropLayer(layer: FigureLayer): void {
        this.clearWidgets(layer);
        layer.destroy();
        this.layers.delete(layer);
    }

    // ── 画高亮 ───────────────────────────────────────────────────────────────

    private async redraw(filePath: string): Promise<void> {
        for (const layer of this.layers) {
            if (layer.sourcePath === filePath) await this.paint(layer);
        }
    }

    private async paint(layer: FigureLayer): Promise<void> {
        const stored = await this.repository.getFileHighlights(layer.sourcePath);
        const mine = stored
            .filter(h => h.figure?.path === layer.figurePath)
            .map(h => ({ ...h, filePath: layer.sourcePath }));
        layer.setHighlights(mine);
    }

    /**
     * 有批注的高亮右上角放 HiNote 的批注图标（带数量，悬停看批注，点开侧栏），
     * 和正文高亮一样。没批注的，鼠标移到高亮上才出现。
     */
    private placeWidgets(layer: FigureLayer, highlights: HiNote[]): void {
        this.clearWidgets(layer);
        const widgets: HTMLElement[] = [];

        for (const highlight of highlights) {
            if (!highlight.id) continue;
            const point = layer.anchorPoint(highlight.id);
            if (!point) continue;

            const widget = layer.hostEl.createSpan({ cls: 'hi-note-widget hi-note-figure-widget' });
            widget.dataset.highlightId = highlight.id;
            widget.style.left = `${point.left}px`;
            widget.style.top = `${point.top}px`;

            const comments = highlight.comments || [];
            const button = CommentWidgetHelper.createButton(widget, comments.length > 0);
            const openPanel = () => CommentWidgetHelper.openCommentPanel(this.app, highlight, this.eventManager);

            if (comments.length > 0) {
                const icon = button.querySelector('.hi-note-icon-container') as HTMLElement;
                CommentWidgetHelper.addCommentCount(icon, comments.length);
                const tooltip = CommentWidgetHelper.createTooltip(this.app, highlight);
                CommentWidgetHelper.setupTooltipEvents(button, widget, tooltip);
                CommentWidgetHelper.setupClickEvent(button, tooltip, openPanel);
                CommentWidgetHelper.createCleanupObserver(widget, tooltip);
            } else {
                widget.addClass('hi-note-figure-widget-empty');
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
    }

    private clearWidgets(layer: FigureLayer): void {
        this.widgets.get(layer)?.forEach(widget => widget.remove());
        this.widgets.delete(layer);
    }

    /** 鼠标停在没批注的高亮上时，才把它的批注按钮露出来 */
    private onMouseMove(event: MouseEvent): void {
        const target = event.target as Element | null;
        const overWidget = target?.closest?.('.hi-note-figure-widget');
        if (overWidget) return;

        let next: { layer: FigureLayer; id: string } | null = null;
        for (const layer of this.layers) {
            if (!layer.svg.contains(target as Node) && target !== (layer.img as Element)) continue;
            const highlight = layer.highlightAt(event.clientX, event.clientY);
            if (highlight?.id) next = { layer, id: highlight.id };
            break;
        }

        if (this.hoverWidget?.id === next?.id && this.hoverWidget?.layer === next?.layer) return;
        this.setHoverWidget(this.hoverWidget, false);
        this.hoverWidget = next;
        this.setHoverWidget(next, true);
    }

    private setHoverWidget(entry: { layer: FigureLayer; id: string } | null, on: boolean): void {
        if (!entry) return;
        const widget = this.widgets.get(entry.layer)?.find(w => w.dataset.highlightId === entry.id);
        if (!widget?.hasClass('hi-note-figure-widget-empty')) return;
        widget.querySelector('.hi-note-button')?.toggleClass('hi-note-button-hidden', !on);
    }

    // ── 划高亮：选中图里的字 → 小工具条 ─────────────────────────────────────────

    private selectionInFigure(): { layer: FigureLayer; selection: FigureSelection } | null {
        const selection = activeWindow.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);

        for (const layer of this.layers) {
            if (!layer.svg.contains(range.commonAncestorContainer)
                && range.commonAncestorContainer !== (layer.svg as unknown as Node)) continue;
            const picked = layer.selectionFrom(range);
            return picked ? { layer, selection: picked } : null;
        }
        return null;
    }

    private showToolbarForSelection(event: MouseEvent): void {
        if (this.toolbar?.contains(event.target as Node)) return;
        const found = this.selectionInFigure();
        if (!found) return;

        this.hideToolbar();
        const range = activeWindow.getSelection()!.getRangeAt(0);
        const box = range.getBoundingClientRect();

        const toolbar = activeDocument.body.createDiv({ cls: 'hi-note-figure-toolbar' });
        const add = (icon: string, label: string, withComment: boolean) => {
            const button = toolbar.createEl('button', { cls: 'hi-note-figure-toolbar-button' });
            setIcon(button.createSpan(), icon);
            button.createSpan({ text: label });
            button.addEventListener('mousedown', e => e.preventDefault()); // 别把选区点没了
            button.addEventListener('click', () => {
                this.hideToolbar();
                void this.addHighlight(found.layer, found.selection, withComment);
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

    private async addHighlight(layer: FigureLayer, selection: FigureSelection, openComment: boolean): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(layer.sourcePath);
        if (!(file instanceof TFile)) return;

        const stored = await this.repository.getFileHighlights(file.path);
        const same = stored.find(h => h.figure?.path === layer.figurePath
            && h.figure.from.join() === selection.from.join()
            && h.figure.to.join() === selection.to.join());

        let highlight: HiNote;
        if (same) {
            highlight = { ...same, filePath: file.path };
        } else {
            const position = await this.embedPosition(file, layer.figurePath);
            const anchor = { path: layer.figurePath, from: selection.from, to: selection.to };
            highlight = {
                id: IdGenerator.generateHighlightId(
                    file.path, position, `${anchor.path}#${anchor.from.join(':')}-${anchor.to.join(':')}:${selection.text}`
                ),
                text: selection.text,
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

    /** 图嵌在笔记哪儿：侧栏按这个给高亮排序，点卡片也滚到这儿 */
    private async embedPosition(file: TFile, figurePath: string): Promise<number> {
        const content = await this.app.vault.cachedRead(file);
        const name = figurePath.split('/').pop() || figurePath;
        return Math.max(0, content.indexOf(name));
    }

    private async removeHighlight(layer: FigureLayer, highlight: HiNote): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(layer.sourcePath);
        if (!(file instanceof TFile)) return;

        const count = highlight.comments?.length ?? 0;
        if (count > 0) {
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

    private onContextMenu(event: MouseEvent): void {
        const target = event.target as Node | null;
        for (const layer of this.layers) {
            if (!target || !(layer.svg.contains(target) || target === (layer.img as unknown as Node))) continue;

            const highlight = layer.highlightAt(event.clientX, event.clientY);
            const picked = this.selectionInFigure();
            if (!highlight && !picked) return;

            event.preventDefault();
            event.stopPropagation();
            const menu = new Menu();
            if (picked) {
                menu.addItem(item => item.setTitle(t('Highlight')).setIcon('highlighter')
                    .onClick(() => void this.addHighlight(picked.layer, picked.selection, false)));
                menu.addItem(item => item.setTitle(t('Comment')).setIcon('message-circle')
                    .onClick(() => void this.addHighlight(picked.layer, picked.selection, true)));
            }
            if (highlight) {
                if (picked) menu.addSeparator();
                menu.addItem(item => item.setTitle(t('Comment')).setIcon('message-circle')
                    .onClick(() => void CommentWidgetHelper.openCommentPanel(this.app, highlight, this.eventManager)));
                menu.addItem(item => item.setTitle(t('Remove highlight')).setIcon('eraser')
                    .onClick(() => void this.removeHighlight(layer, highlight)));
            }
            menu.showAtMouseEvent(event);
            return;
        }
    }
}
