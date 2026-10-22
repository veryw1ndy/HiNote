import { MarkdownView, TFile } from 'obsidian';
import type { HiNotePluginContext } from '../types/plugin';
import type { HighlightRepository } from '../repositories/HighlightRepository';
import type { EventManager } from '../services/EventManager';

/**
 * 盯着 .hinote/highlights/<note>.json：外面改了就读回来，不用重载插件。
 *
 * 批注不写在笔记里，写在 .hinote/ 下的 JSON 里，而 `.hinote` 是点目录、不在 vault 的
 * 文件树里，所以 vault.on('modify') 收不到这些文件的改动。只能自己隔一会儿 stat 一下
 * 打开着的笔记对应的那个 JSON（打开着的才是侧栏正在显示的那几个，一次就一两次 stat）。
 *
 * 读回来之后发 figure-highlight:change：正文没变，侧栏只认这个事件。
 */
export class HighlightFileWatcher {
    private interval: number | null = null;
    private running = false;

    constructor(
        private plugin: HiNotePluginContext,
        private repository: HighlightRepository,
        private eventManager: EventManager,
        private intervalMs = 2000
    ) {}

    enable(): void {
        this.interval = window.setInterval(() => void this.check(), this.intervalMs);
        this.plugin.registerInterval(this.interval);
        // 切笔记、切回 Obsidian 的时候马上看一眼，不用等下一次轮询
        this.plugin.registerEvent(this.plugin.app.workspace.on('file-open', () => void this.check()));
        this.plugin.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => void this.check()));
        this.plugin.registerDomEvent(window, 'focus', () => void this.check());
    }

    disable(): void {
        if (this.interval !== null) {
            window.clearInterval(this.interval);
            this.interval = null;
        }
    }

    /** 侧栏正在显示的那几个文件：打开着的 Markdown 笔记 */
    watchedFiles(): string[] {
        const paths = new Set<string>();
        const active = this.plugin.app.workspace.getActiveFile();
        if (active && active.extension === 'md') paths.add(active.path);

        for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            const file = view instanceof MarkdownView ? view.file : null;
            if (file instanceof TFile && file.extension === 'md') paths.add(file.path);
        }

        return [...paths];
    }

    /** @returns 被外面改过、已经读回来的文件 */
    async check(): Promise<string[]> {
        if (this.running) return [];
        this.running = true;
        const reloaded: string[] = [];
        try {
            for (const path of this.watchedFiles()) {
                try {
                    if (await this.repository.reloadFromDisk(path)) {
                        reloaded.push(path);
                        this.eventManager.emitFigureHighlightChange(path);
                    }
                } catch (error) {
                    console.warn(`[HiNote] 读回 ${path} 的批注失败:`, error);
                }
            }
        } finally {
            this.running = false;
        }
        return reloaded;
    }
}
