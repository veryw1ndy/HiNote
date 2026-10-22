import { TFile } from 'obsidian';
import { HighlightInfo as HiNote } from '../types/highlight';
import { HiNoteDataManager } from '../storage/HiNoteDataManager';
import { IHighlightRepository } from './IHighlightRepository';

/**
 * 高亮数据仓储实现
 * 职责：
 * 1. 管理高亮数据的内存缓存
 * 2. 协调数据持久化操作
 * 3. 提供统一的数据访问接口
 */
export class HighlightRepository implements IHighlightRepository {
    private cache: Map<string, HiNote[]> = new Map();
    private dataManager: HiNoteDataManager;

    /** 每次写盘前先调用（撤销靠它记下写之前的样子），见 HighlightUndo */
    beforeWrite: ((filePath: string, next: HiNote[]) => Promise<void>) | null = null;

    constructor(dataManager: HiNoteDataManager) {
        this.dataManager = dataManager;
    }

    async initialize(): Promise<void> {
        await this.dataManager.initialize();
        await this.loadAllHighlightsToCache();
    }

    /**
     * 从存储层加载所有高亮到缓存
     */
    private async loadAllHighlightsToCache(): Promise<void> {
        try {
            const highlightFiles = await this.dataManager.getAllHighlightFiles();
            
            for (const filePath of highlightFiles) {
                if (!this.cache.has(filePath)) {
                    this.cache.set(filePath, []);
                }
            }
            
            for (const filePath of highlightFiles) {
                void this.loadFileHighlightsAsync(filePath);
            }
        } catch (error) {
            console.error('[HighlightRepository] 加载高亮文件列表失败:', error);
        }
    }

    /**
     * 异步加载单个文件的高亮数据
     */
    private async loadFileHighlightsAsync(filePath: string): Promise<void> {
        try {
            const highlights = await this.dataManager.getFileHighlights(filePath);
            if (highlights.length > 0) {
                this.cache.set(filePath, highlights);
            } else {
                this.cache.delete(filePath);
            }
        } catch (error) {
            console.warn(`[HighlightRepository] 加载文件 ${filePath} 的高亮数据失败:`, error);
        }
    }

    async getFileHighlights(filePath: string): Promise<HiNote[]> {
        if (this.cache.has(filePath)) {
            return this.cache.get(filePath) || [];
        }
        
        const highlights = await this.dataManager.getFileHighlights(filePath);
        this.cache.set(filePath, highlights);
        return highlights;
    }

    async saveFileHighlights(filePath: string, highlights: HiNote[]): Promise<void> {
        await this.beforeWrite?.(filePath, highlights);
        this.cache.set(filePath, highlights);
        // 盘上那份被外面改过的话，存下来的是合并后的那份：缓存要跟着它，不是跟着我们送进去的
        const persisted = await this.dataManager.saveFileHighlights(filePath, highlights);
        if (persisted && persisted !== highlights) {
            this.cache.set(filePath, persisted);
        }
    }

    /**
     * 盘上那份被外面改过（hinote.py、git、同步）就读回来，返回新的那份；没变返回 null。
     * 缓存里这份没有还没写出去的改动时，就是直接用盘上那份，不再把它盖掉。
     */
    async reloadFromDisk(filePath: string): Promise<HiNote[] | null> {
        const mine = this.cache.get(filePath) || [];
        const reloaded = await this.dataManager.reloadIfChangedOnDisk(filePath, mine);
        if (!reloaded) return null;

        if (reloaded.length > 0) {
            this.cache.set(filePath, reloaded);
        } else {
            this.cache.delete(filePath);
        }
        return reloaded;
    }

    async deleteFileHighlights(filePath: string): Promise<void> {
        await this.beforeWrite?.(filePath, []);
        this.cache.delete(filePath);
        await this.dataManager.deleteFileHighlights(filePath);
    }

    /** 盘上存的那份，不经过缓存：缓存里的可能已经是改过的了 */
    async readStoredHighlights(filePath: string): Promise<HiNote[]> {
        return this.dataManager.getFileHighlights(filePath);
    }

    async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        await this.dataManager.initialize();

        const cachedHighlights = this.cache.get(oldPath);
        const oldPathHighlights = cachedHighlights && cachedHighlights.length > 0
            ? cachedHighlights
            : await this.dataManager.getFileHighlights(oldPath);

        await this.dataManager.handleFileRename(oldPath, newPath);
        
        oldPathHighlights.forEach(highlight => {
            highlight.filePath = newPath;
        });

        if (oldPathHighlights.length > 0) {
            this.cache.set(newPath, oldPathHighlights);
        } else {
            this.cache.delete(newPath);
        }

        this.cache.delete(oldPath);
    }

    async getAllHighlightFiles(): Promise<string[]> {
        return await this.dataManager.getAllHighlightFiles();
    }

    getCachedHighlights(filePath: string): HiNote[] | null {
        return this.cache.get(filePath) || null;
    }

    invalidateCache(filePath: string): void {
        this.cache.delete(filePath);
    }

    getAllCachedHighlights(): Map<string, HiNote[]> {
        return new Map(this.cache);
    }

    findHighlightById(highlightId: string): HiNote | null {
        if (!highlightId) return null;
        
        for (const fileHighlights of this.cache.values()) {
            const highlight = fileHighlights.find(h => h.id === highlightId);
            if (highlight) {
                return highlight;
            }
        }
        
        return null;
    }

    findHighlightsByBlockId(file: TFile, blockId: string): HiNote[] {
        if (!file || !blockId) return [];
        
        const filePath = file.path;
        const fileHighlights = this.cache.get(filePath) || [];
        
        return fileHighlights.filter(highlight => highlight.blockId === blockId);
    }
}
