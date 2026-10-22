import { App } from 'obsidian';
import { HighlightInfo as HiNote } from '../types/highlight';
import { FSRSStorage } from '../flashcard';
import { DataValidator } from './DataValidator';
import {
    convertToLegacyHighlight,
    convertToOptimizedHighlight,
    OptimizedHighlight,
    OptimizedHighlightData
} from './HighlightDataFormat';
import { FileMappingStore } from './FileMappingStore';
import { HighlightMap, mergeHighlights } from './HighlightMerge';
import {
    detectHighlightFilesFromStorage,
    ensureHiNoteDirectoryStructure
} from './HiNoteStorageLayout';
import { FlashcardDataStore } from './FlashcardDataStore';
import { FilePathUtils } from './FilePathUtils';

/**
 * HiNote数据管理器 - 存储层（已重构）
 * 职责：
 * 1. 纯粹的文件系统操作
 * 2. 数据序列化/反序列化
 * 3. 文件路径映射管理
 * 4. 不包含业务逻辑
 */
/** 上一次插件自己读到或写出去的那份高亮文件：合并时当 base，stamp 用来认出外面的写 */
interface LastSeen {
    mtime: number;
    size: number;
    highlights: HighlightMap;
}

/** base 存一份自己的拷贝：界面就地改缓存里的对象时，不能跟着变 */
function copyOf(highlights: HighlightMap): HighlightMap {
    return JSON.parse(JSON.stringify(highlights)) as HighlightMap;
}

export class HiNoteDataManager {
    private app: App;
    private vaultPath: string;
    private fileMappingStore: FileMappingStore;
    private flashcardDataStore: FlashcardDataStore;
    private readonly CURRENT_VERSION = '2.0';
    private initialized = false;
    private initializePromise: Promise<void> | null = null;
    /** storagePath -> 上一次插件看到的样子。文件不在盘上时是 null */
    private lastSeen: Map<string, LastSeen | null> = new Map();

    constructor(app: App) {
        this.app = app;
        // 对于Obsidian，我们直接使用相对路径，不需要获取绝对路径
        this.vaultPath = '';
        this.fileMappingStore = new FileMappingStore(app, this.vaultPath, this.CURRENT_VERSION);
        this.flashcardDataStore = new FlashcardDataStore(app, this.vaultPath);
    }

    /**
     * 初始化数据管理器
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        if (!this.initializePromise) {
            this.initializePromise = (async () => {
                await this.ensureDirectoryStructure();
                await this.loadFileMapping();
                this.initialized = true;
            })().catch(error => {
                this.initializePromise = null;
                throw error;
            });
        }

        await this.initializePromise;
    }

    /**
     * 确保目录结构存在
     */
    private async ensureDirectoryStructure(): Promise<void> {
        await ensureHiNoteDirectoryStructure(this.app, this.vaultPath);
    }

    /**
     * 加载文件映射
     */
    private async loadFileMapping(): Promise<void> {
        await this.fileMappingStore.load();
    }

    /**
     * 保存文件映射
     */
    private async saveFileMapping(): Promise<void> {
        await this.fileMappingStore.save();
    }

    /**
     * 获取文件的安全存储路径
     */
    private getStoragePathForFile(filePath: string): string {
        return this.fileMappingStore.getStoragePathForFile(filePath);
    }

    /**
     * 获取文件的所有高亮数据
     * @param filePath 文件路径
     * @returns 高亮数组
     */
    async getFileHighlights(filePath: string): Promise<HiNote[]> {
        const storagePath = this.getStoragePathForFile(filePath);
        const read = await this.readStorage(storagePath, filePath);
        this.lastSeen.set(storagePath, read);
        if (!read) return [];

        // 转换为旧格式以保持兼容性。base 要和交出去的那份互不相干：
        // 界面会就地改缓存里的对象，改到 base 上合并就比不出来了
        return this.toLegacy(copyOf(read.highlights), filePath);
    }

    /**
     * 只看一眼盘上那份，不把它记成"插件看到的"（撤销要记下写之前的样子，用这个）。
     * 用 getFileHighlights 会把 base 换成盘上现在那份，外面刚写进去的东西就被当成
     * 插件自己的了，下一次写盘又会把它盖掉。
     */
    async peekStoredHighlights(filePath: string): Promise<HiNote[]> {
        const storagePath = this.getStoragePathForFile(filePath);
        const read = await this.readStorage(storagePath, filePath);
        return read ? this.toLegacy(read.highlights, filePath) : [];
    }

    /**
     * 盘上现在存的那份，和插件上一次看到的那份比过了：一样就是 null。
     * `.hinote` 是点目录，不在 vault 的文件树里，所以 vault.on('modify') 不会来，
     * 只能靠 adapter.stat() 自己比。
     */
    private async statStorage(storagePath: string): Promise<{ mtime: number; size: number } | null> {
        try {
            const stat = await this.app.vault.adapter.stat(storagePath);
            return stat ? { mtime: stat.mtime, size: stat.size } : null;
        } catch {
            return null;
        }
    }

    private async readStorage(storagePath: string, filePath: string): Promise<LastSeen | null> {
        try {
            const content = await this.app.vault.adapter.read(storagePath);
            const data: OptimizedHighlightData = JSON.parse(content);

            // 验证数据格式
            const validation = DataValidator.validateHighlightData(data);
            if (!validation.valid) {
                console.warn(`文件 ${filePath} 的高亮数据验证失败:`, validation.errors);
                return null;
            }

            const stamp = await this.statStorage(storagePath);
            return {
                mtime: stamp?.mtime ?? 0,
                size: stamp?.size ?? content.length,
                highlights: data.highlights
            };
        } catch {
            // 文件不存在或读取失败
            return null;
        }
    }

    private toLegacy(highlights: HighlightMap, filePath: string): HiNote[] {
        return Object.entries(highlights).map(([id, highlight]) =>
            convertToLegacyHighlight(id, highlight, filePath)
        );
    }

    private toOptimized(highlights: HiNote[]): HighlightMap {
        const optimizedHighlights: { [id: string]: OptimizedHighlight } = {};

        for (const highlight of highlights) {
            if (!highlight.id) continue; // 跳过没有 ID 的高亮
            optimizedHighlights[highlight.id] = convertToOptimizedHighlight(highlight);
        }

        return optimizedHighlights;
    }

    /** 盘上那份是不是在插件背后被人改过了 */
    private async changedOnDisk(storagePath: string): Promise<boolean> {
        const seen = this.lastSeen.get(storagePath) ?? null;
        const stamp = await this.statStorage(storagePath);
        // 还没读过这个文件：盘上有东西就当成外面写的，合并时 base 为空，谁的都不会丢
        if (!this.lastSeen.has(storagePath)) return !!stamp;
        if (!seen || !stamp) return !!seen !== !!stamp;       // 一边有一边没有：被删了或被建了
        return stamp.mtime !== seen.mtime || stamp.size !== seen.size;
    }

    private async writeStorage(storagePath: string, highlights: HighlightMap): Promise<void> {
        const data: OptimizedHighlightData = {
            version: this.CURRENT_VERSION,
            lastModified: Date.now(),
            highlights
        };

        const text = JSON.stringify(data, null, 2);
        await this.app.vault.adapter.write(storagePath, text);
        const stamp = await this.statStorage(storagePath);
        this.lastSeen.set(storagePath, {
            mtime: stamp?.mtime ?? Date.now(),
            size: stamp?.size ?? text.length,
            highlights: copyOf(highlights)
        });
    }

    /**
     * 保存文件的高亮数据。
     * 写之前先看盘上那份有没有被外面改过（hinote.py、git、同步）：改过就三方合并，
     * 内存里这份没改动的地方以盘上那份为准，不再把外面写进去的东西盖掉。
     * @returns 真正存下来的那份（合并过的话就是合并后的）
     */
    async saveFileHighlights(filePath: string, highlights: HiNote[]): Promise<HiNote[]> {
        const storagePath = this.getStoragePathForFile(filePath);
        const mine = this.toOptimized(highlights);

        if (!await this.changedOnDisk(storagePath)) {
            await this.writeStorage(storagePath, mine);
            return highlights;
        }

        const base = this.lastSeen.get(storagePath)?.highlights ?? {};
        const theirs = (await this.readStorage(storagePath, filePath))?.highlights ?? {};
        const merged = mergeHighlights(base, mine, theirs);

        for (const note of merged.notes) {
            console.warn(`[HiNote] ${filePath}: ${note}`);
        }

        if (merged.changedFromTheirs) {
            await this.writeStorage(storagePath, merged.highlights);
        } else {
            // 盘上那份就是合并结果：只记下它，别白写一遍（省掉一次自己触发的变化）
            const stamp = await this.statStorage(storagePath);
            this.lastSeen.set(storagePath, {
                mtime: stamp?.mtime ?? Date.now(),
                size: stamp?.size ?? 0,
                highlights: copyOf(merged.highlights)
            });
        }

        return merged.changedFromMine ? this.toLegacy(merged.highlights, filePath) : highlights;
    }

    /**
     * 盘上那份被外面改过的话，读回来（和内存里这份合并后的结果）。
     * 没变就返回 null。侧栏靠它在不重载插件的情况下跟上外面的写。
     */
    async reloadIfChangedOnDisk(filePath: string, mine: HiNote[]): Promise<HiNote[] | null> {
        const storagePath = this.getStoragePathForFile(filePath);
        if (!await this.changedOnDisk(storagePath)) return null;

        const base = this.lastSeen.get(storagePath)?.highlights ?? {};
        const theirs = (await this.readStorage(storagePath, filePath))?.highlights ?? {};
        const merged = mergeHighlights(base, this.toOptimized(mine), theirs);

        for (const note of merged.notes) {
            console.warn(`[HiNote] ${filePath}: ${note}`);
        }

        if (merged.changedFromTheirs) {
            // 这边还有没写出去的改动：合并后的那份要写回盘上
            await this.writeStorage(storagePath, merged.highlights);
        } else {
            const stamp = await this.statStorage(storagePath);
            this.lastSeen.set(storagePath, {
                mtime: stamp?.mtime ?? Date.now(),
                size: stamp?.size ?? 0,
                highlights: copyOf(merged.highlights)
            });
        }

        return merged.changedFromMine ? this.toLegacy(merged.highlights, filePath) : null;
    }

    /**
     * 删除文件的所有高亮数据
     * @param filePath 文件路径
     */
    async deleteFileHighlights(filePath: string): Promise<void> {
        const storagePath = this.getStoragePathForFile(filePath);
        
        try {
            await this.app.vault.adapter.remove(storagePath);
            this.lastSeen.set(storagePath, null);
            this.fileMappingStore.delete(filePath);
            await this.saveFileMapping();
        } catch {
            // 文件可能不存在，忽略错误
        }
    }

    /**
     * 处理文件重命名
     * @param oldPath 旧路径
     * @param newPath 新路径
     */
    async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        await this.initialize();

        const highlightsDir = FilePathUtils.getHighlightsDir(this.vaultPath);
        const mappedOldSafeFileName = this.fileMappingStore.get(oldPath);
        const oldSafeFileName = mappedOldSafeFileName ?? FilePathUtils.toSafeFileName(oldPath);
        const newSafeFileName = FilePathUtils.toSafeFileName(newPath);
        const oldStoragePath = `${highlightsDir}/${oldSafeFileName}`;
        const newStoragePath = `${highlightsDir}/${newSafeFileName}`;

        const oldStorageExists = await this.app.vault.adapter.exists(oldStoragePath);
        if (!oldStorageExists) {
            if (mappedOldSafeFileName) {
                this.fileMappingStore.delete(oldPath);
                await this.saveFileMapping();
            }
            return;
        }

        const content = await this.app.vault.adapter.read(oldStoragePath);
        await this.app.vault.adapter.write(newStoragePath, content);
        // 新路径记成刚写出去的那份，旧路径忘掉：别拿旧的 stamp 去比
        this.lastSeen.delete(oldStoragePath);
        this.lastSeen.set(newStoragePath, await this.readStorage(newStoragePath, newPath));

        // Only publish the new mapping after the highlight data is safely written.
        this.fileMappingStore.delete(oldPath);
        this.fileMappingStore.set(newPath, newSafeFileName);
        await this.saveFileMapping();

        if (oldStoragePath !== newStoragePath) {
            try {
                await this.app.vault.adapter.remove(oldStoragePath);
            } catch (error) {
                // The new mapping is already valid; leaving an orphaned old file is safer than rollback.
                console.warn('[HiNote] Failed to remove old highlight data after file rename:', error);
            }
        }
    }

    /**
     * 获取所有高亮文件列表
     */
    async getAllHighlightFiles(): Promise<string[]> {
        // 首先从文件映射获取
        const mappedFiles = this.fileMappingStore.getMappedFiles();
        
        // 如果映射为空，尝试扫描高亮目录
        if (mappedFiles.length === 0) {
            const detectedFiles = await detectHighlightFilesFromStorage(
                this.app,
                this.vaultPath,
                (originalPath, baseName) => {
                    this.fileMappingStore.set(originalPath, baseName);
                }
            );
                
            if (detectedFiles.length > 0) {
                this.saveFileMapping().catch(err =>
                    console.warn('保存文件映射失败:', err)
                );
            }

            return detectedFiles;
        }
        
        return mappedFiles;
    }


    /**
     * 获取闪卡数据
     */
    async getFlashcardData(): Promise<FSRSStorage | null> {
        return this.flashcardDataStore.load();
    }

    /**
     * 保存闪卡数据
     */
    async saveFlashcardData(data: FSRSStorage): Promise<void> {
        await this.flashcardDataStore.save(data);
    }
}
