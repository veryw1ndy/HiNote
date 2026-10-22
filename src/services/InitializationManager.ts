import { Notice } from 'obsidian';
import { HighlightDecorator } from '../editor/HighlightDecorator';
import { FSRSManager } from '../flashcard';
import { HighlightService } from './HighlightService';
import { HiNoteDataManager } from '../storage/HiNoteDataManager';
import { CanvasService } from './CanvasService';
import { EventManager } from './EventManager';
import { HighlightManager } from './HighlightManager';
import { HighlightRepository } from '../repositories/HighlightRepository';
import type CommentPlugin from '../../main';
import type { PluginServices } from '../plugin/PluginServices';
import { FigureHighlighter } from '../figure/FigureHighlighter';
import { MathHighlighter } from '../math/MathHighlighter';
import { CodeHighlighter } from '../code/CodeHighlighter';
import { HighlightUndo } from './HighlightUndo';
import { HighlightFileWatcher } from '../storage/HighlightFileWatcher';

/**
 * 初始化管理器
 * 负责管理插件的延迟初始化逻辑
 */
export class InitializationManager {
    // 延迟初始化标志
    private isInitialized: boolean = false;
    private initializationPromise: Promise<PluginServices> | null = null;
    private services: PluginServices | null = null;
    private figureHighlighter: FigureHighlighter | null = null;
    private mathHighlighter: MathHighlighter | null = null;
    private codeHighlighter: CodeHighlighter | null = null;
    private highlightUndo: HighlightUndo | null = null;
    private highlightFileWatcher: HighlightFileWatcher | null = null;

    constructor(private plugin: CommentPlugin) {}

    /**
     * 确保插件已初始化（延迟初始化）
     * 只在用户首次使用功能时才执行初始化
     */
    async ensureInitialized(): Promise<PluginServices> {
        // 如果已经初始化，直接返回
        if (this.isInitialized && this.services) {
            return this.services;
        }

        // 如果正在初始化，等待完成
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        // 开始初始化
        this.services = this.initialize();
        this.isInitialized = true;
        this.initializationPromise = Promise.resolve(this.services);
        return this.services;
    }

    /**
     * 实际的初始化逻辑
     */
    private initialize(): PluginServices {
        // 初始化事件管理器（共享实例）
        const eventManager = new EventManager(this.plugin.app);

        // 初始化数据管理器（共享实例）
        const dataManager = new HiNoteDataManager(this.plugin.app);

        // 初始化架构层
        const highlightRepository = new HighlightRepository(dataManager);

        // 初始化高亮服务（共享实例）
        const highlightService = new HighlightService(
            this.plugin.app,
            () => this.plugin.settings,
            () => highlightRepository
        );
        // 异步构建索引，不阻塞初始化
        void highlightService.initialize();

        // 初始化 Canvas 服务（共享实例）
        const canvasService = new CanvasService(this.plugin.app.vault);

        const highlightManager = new HighlightManager(
            this.plugin.app,
            highlightRepository,
            eventManager,
            highlightService
        );
        
        // 异步加载数据，不阻塞初始化
        highlightRepository.initialize().catch(error => {
            console.error('[HiNote] 加载高亮数据失败:', error);
        });

        // 初始化 FSRS 管理器（传入数据管理器以使用新存储层）
        const fsrsManager = new FSRSManager(this.plugin, dataManager);

        // 初始化高亮装饰器
        const highlightDecorator = new HighlightDecorator(this.plugin, highlightRepository, highlightService, eventManager);
        highlightDecorator.enable();

        // 图里的字也能划
        const figureHighlighter = new FigureHighlighter(
            this.plugin, highlightRepository, highlightManager, eventManager, highlightService
        );
        figureHighlighter.enable();
        this.figureHighlighter = figureHighlighter;

        // 公式的一部分也能划
        try {
            const mathHighlighter = new MathHighlighter(
                this.plugin, highlightRepository, highlightManager, eventManager, highlightService, highlightDecorator
            );
            mathHighlighter.enable();
            this.mathHighlighter = mathHighlighter;
        } catch (error) {
            console.error('[HiNote] 公式高亮启动失败:', error);
            new Notice(`Formula highlighting failed to start: ${error instanceof Error ? error.message : String(error)}`);
        }

        // 代码块里的字也能划
        try {
            const codeHighlighter = new CodeHighlighter(
                this.plugin, highlightRepository, highlightManager, eventManager, highlightService
            );
            codeHighlighter.enable();
            this.codeHighlighter = codeHighlighter;
        } catch (error) {
            console.error('[HiNote] 代码块高亮启动失败:', error);
        }

        // 外面改了 .hinote/highlights/*.json（hinote.py、git、同步）就读回来，不用重载插件
        const highlightFileWatcher = new HighlightFileWatcher(
            this.plugin, highlightRepository, eventManager
        );
        highlightFileWatcher.enable();
        this.highlightFileWatcher = highlightFileWatcher;

        // 批注和高亮的 Cmd-Z / Cmd-Shift-Z
        const highlightUndo = new HighlightUndo(this.plugin, highlightRepository, eventManager);
        highlightUndo.enable();
        this.highlightUndo = highlightUndo;

        return {
            eventManager,
            dataManager,
            highlightService,
            canvasService,
            fsrsManager,
            highlightDecorator,
            highlightRepository,
            highlightManager
        };
    }

    /**
     * 清理资源
     */
    async cleanup(): Promise<void> {
        // 数据自动保存，无需手动保存

        // 清理高亮装饰器
        if (this.services?.highlightDecorator) {
            this.services.highlightDecorator.disable();
        }
        this.figureHighlighter?.disable();
        this.mathHighlighter?.disable();
        this.codeHighlighter?.disable();
        this.highlightUndo?.disable();
        this.highlightFileWatcher?.disable();

        // 清理高亮服务（注销事件监听器，清空索引）
        if (this.services?.highlightService) {
            this.services.highlightService.destroy();
        }
    }

    /**
     * 检查是否已初始化
     */
    get initialized(): boolean {
        return this.isInitialized;
    }

    get currentServices(): PluginServices | null {
        return this.services;
    }
}
