import { App, TFile, Component, EventRef, MarkdownView } from "obsidian";
import { defaultHighlightCardRegistry } from "../../components/highlight";
import { HighlightInfo as HiNote } from "../../types/highlight";
import type { CommentInputTarget, EventManager } from "../../services/EventManager";

/**
 * 事件回调接口
 */
export interface EventCallbacks {
    onFileOpen?: (file: TFile, isInCanvas: boolean) => void;
    onFileModify?: (file: TFile, isInCanvas: boolean) => void;
    onFileCreate?: () => void;
    onFileDelete?: () => void;
    onLayoutChange?: () => void;
    onCommentInput?: (highlightId: string, text: string, highlight?: CommentInputTarget) => void;
}

/**
 * 事件协调器
 * 职责：
 * 1. 统一管理所有事件监听器
 * 2. 文件事件（打开、修改、创建、删除）
 * 3. 自定义事件（评论输入、多选）
 * 4. 布局变化事件
 */
export class EventCoordinator {
    private callbacks: EventCallbacks = {};
    private eventRefs: EventRef[] = [];
    constructor(
        private app: App,
        private component: Component,
        private eventManager: EventManager
    ) {}

    /**
     * 设置回调函数
     */
    setCallbacks(callbacks: EventCallbacks): void {
        this.callbacks = { ...this.callbacks, ...callbacks };
    }

    /**
     * 注册所有事件监听器
     */
    registerAllEvents(
        getCurrentFile: () => TFile | null,
        isDraggedToMainView: () => boolean
    ): void {
        // 监听文档切换
        this.registerFileOpenEvent(getCurrentFile, isDraggedToMainView);

        // 监听文档修改
        this.registerFileModifyEvent(getCurrentFile, isDraggedToMainView);

        // 监听文件创建和删除
        this.registerFileCreateEvent();
        this.registerFileDeleteEvent();

        // 监听布局变化
        this.registerLayoutChangeEvent();

        // 监听评论输入事件
        this.registerCommentInputEvent();

        // 图里的高亮变了：正文没改，modify 不会来
        this.registerFigureHighlightEvent(getCurrentFile, isDraggedToMainView);
    }

    private registerFigureHighlightEvent(
        getCurrentFile: () => TFile | null,
        isDraggedToMainView: () => boolean
    ): void {
        const ref = this.eventManager.on('figure-highlight:change', (filePath) => {
            const currentFile = getCurrentFile();
            if (currentFile?.path === filePath && !isDraggedToMainView() && this.callbacks.onFileModify) {
                this.callbacks.onFileModify(currentFile, false);
            }
        });

        this.component.registerEvent(ref);
        this.eventRefs.push(ref);
    }

    /**
     * 注册文件打开事件
     */
    private registerFileOpenEvent(
        getCurrentFile: () => TFile | null,
        isDraggedToMainView: () => boolean
    ): void {
        const ref = this.app.workspace.on('file-open', (file) => {
            // 只在非主视图时同步文件
            if (file && !isDraggedToMainView()) {
                const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
                const isInCanvas = !activeMarkdownView && this.app.workspace.getActiveFile()?.path !== file.path;
                
                if (this.callbacks.onFileOpen) {
                    this.callbacks.onFileOpen(file, isInCanvas);
                }
            }
        });
        
        this.component.registerEvent(ref);
        this.eventRefs.push(ref);
    }

    /**
     * 注册文件修改事件
     */
    private registerFileModifyEvent(
        getCurrentFile: () => TFile | null,
        isDraggedToMainView: () => boolean
    ): void {
        const ref = this.app.vault.on('modify', (file) => {
            const currentFile = getCurrentFile();
            
            // 只在非主视图时同步文件
            if (file === currentFile && !isDraggedToMainView() && file instanceof TFile) {
                const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
                const isInCanvas = !activeMarkdownView && this.app.workspace.getActiveFile()?.path !== file.path;
                
                if (this.callbacks.onFileModify) {
                    this.callbacks.onFileModify(file, isInCanvas);
                }
            }
        });
        
        this.component.registerEvent(ref);
        this.eventRefs.push(ref);
    }

    /**
     * 注册文件创建事件
     */
    private registerFileCreateEvent(): void {
        const ref = this.app.vault.on('create', () => {
            if (this.callbacks.onFileCreate) {
                this.callbacks.onFileCreate();
            }
        });
        
        this.component.registerEvent(ref);
        this.eventRefs.push(ref);
    }

    /**
     * 注册文件删除事件
     */
    private registerFileDeleteEvent(): void {
        const ref = this.app.vault.on('delete', () => {
            if (this.callbacks.onFileDelete) {
                this.callbacks.onFileDelete();
            }
        });
        
        this.component.registerEvent(ref);
        this.eventRefs.push(ref);
    }

    /**
     * 注册布局变化事件
     */
    private registerLayoutChangeEvent(): void {
        const ref = this.app.workspace.on('layout-change', () => {
            if (this.callbacks.onLayoutChange) {
                this.callbacks.onLayoutChange();
            }
        });
        
        this.component.registerEvent(ref);
        this.eventRefs.push(ref);
    }

    /**
     * 注册评论输入事件
     */
    private registerCommentInputEvent(): void {
        const ref = this.eventManager.on('comment-input:open', (highlightId, text, highlight) => {
            if (this.callbacks.onCommentInput) {
                this.callbacks.onCommentInput(highlightId, text, highlight);
            }
        });

        this.component.registerEvent(ref);
        this.eventRefs.push(ref);
    }

    /**
     * 注册键盘事件（用于多选）
     */
    registerKeyboardEvents(highlightContainer: HTMLElement): void {
        // 按住 Shift 键进行多选
        const keydownHandler = (e: KeyboardEvent) => {
            if (e.key === 'Shift') {
                highlightContainer.addClass('multi-select-mode');
            }
        };

        const keyupHandler = (e: KeyboardEvent) => {
            if (e.key === 'Shift') {
                highlightContainer.removeClass('multi-select-mode');
            }
        };

        this.component.registerDomEvent(activeDocument, 'keydown', keydownHandler);
        this.component.registerDomEvent(activeDocument, 'keyup', keyupHandler);
    }

    /**
     * 处理评论输入显示
     */
    handleCommentInputDisplay(
        highlightId: string,
        text: string,
        highlight: CommentInputTarget | undefined,
        highlightContainer: HTMLElement,
        onShowCommentInput: (card: HTMLElement, highlight: HiNote) => void
    ): void {
        // 等待一下确保视图已经更新
        window.setTimeout(() => {
            // 移除所有卡片的选中状态
            highlightContainer.querySelectorAll('.highlight-card').forEach(card => {
                card.removeClass('selected');
            });

            // 先按 ID 找；找不到才按文字，而且只挑同一类（图里的 / 正文里的）、离得最近的那张。
            // 以前按文字找的是「第一张文字一样的」：点正文的 home MTSO，打开的是图里那张。
            const cardInstance = defaultHighlightCardRegistry.findByHighlight(highlight ?? { id: highlightId, text });
            if (!cardInstance) return;

            const cardElement = cardInstance.getElement();
            if (!highlightContainer.contains(cardElement)) return;

            cardElement.addClass('selected');
            cardElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
            cardInstance.showCommentInput();
        }, 100);
    }

    /**
     * 销毁事件协调器
     */
    destroy(): void {
        // 清理事件引用
        this.eventRefs = [];
        this.callbacks = {};
    }
}
