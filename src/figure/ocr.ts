import { App, FileSystemAdapter, Platform, TFile } from "obsidian";

/**
 * 截图、照片这类图里没有文字，只有像素。先用 macOS 自带的 Vision（实况文本那套）
 * 把字认出来，再和 .svg 图一样盖一层透明的字上去。
 *
 * 认字的是插件目录里的 hinote-ocr（源码 scripts/ocr/hinote-ocr.swift），只在 Mac 桌面版上有。
 * 每张图只认一次，结果存在 .hinote/ocr/ 里：高亮记的是「第几个词」，
 * 要是每次重新认、系统升级后认得稍有不同，旧高亮就对不上了。图片本身改了才重新认。
 */

export const RASTER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic']);

const OCR_DIR = '.hinote/ocr';
const HELPER = 'hinote-ocr';
const SVG_NS = "http://www.w3.org/2000/svg";

interface OcrToken {
    t: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

interface OcrResult {
    width: number;
    height: number;
    dark: boolean;
    lines: { tokens: OcrToken[] }[];
}

interface CachedOcr extends OcrResult {
    /** 认的是哪张图、哪个版本：mtime 变了再比 sha1，同步/检出改了 mtime 但内容没变就不重认 */
    image: { path: string; size: number; mtime: number; sha1: string };
}

type ExecFile = (
    file: string,
    args: string[],
    options: { maxBuffer: number; timeout: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

export class OcrReader {
    private helperPath: string | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private inflight = new Map<string, Promise<OcrResult | null>>();

    constructor(private app: App, pluginDir: string | undefined) {
        const adapter = app.vault.adapter;
        if (Platform.isDesktopApp && Platform.isMacOS && adapter instanceof FileSystemAdapter && pluginDir) {
            this.helperPath = `${adapter.getBasePath()}/${pluginDir}/${HELPER}`;
        }
    }

    get available(): boolean {
        return this.helperPath !== null;
    }

    async read(file: TFile): Promise<OcrResult | null> {
        if (!this.helperPath) return null;
        let running = this.inflight.get(file.path);
        if (!running) {
            running = this.readFresh(file).finally(() => this.inflight.delete(file.path));
            this.inflight.set(file.path, running);
        }
        return running;
    }

    private async readFresh(file: TFile): Promise<OcrResult | null> {
        const adapter = this.app.vault.adapter;
        const cachePath = `${OCR_DIR}/${cacheName(file.path)}`;

        let cached: CachedOcr | null = null;
        if (await adapter.exists(cachePath)) {
            try {
                cached = JSON.parse(await adapter.read(cachePath)) as CachedOcr;
            } catch {
                cached = null;
            }
        }

        if (cached && cached.image.path === file.path && cached.image.size === file.stat.size) {
            if (cached.image.mtime === file.stat.mtime) return cached;
            const sha1 = await this.sha1(file);
            if (sha1 === cached.image.sha1) {
                cached.image.mtime = file.stat.mtime;
                await adapter.write(cachePath, JSON.stringify(cached));
                return cached;
            }
        }

        // 一次只认一张：一篇笔记几十张截图同时开几十个进程不值得
        const result = await (this.queue = this.queue.then(() => this.run(file), () => this.run(file)));
        if (!result) return null;

        const fresh: CachedOcr = {
            ...result,
            image: { path: file.path, size: file.stat.size, mtime: file.stat.mtime, sha1: await this.sha1(file) }
        };
        if (!(await adapter.exists(OCR_DIR))) await adapter.mkdir(OCR_DIR);
        await adapter.write(cachePath, JSON.stringify(fresh));
        return fresh;
    }

    private run(file: TFile): Promise<OcrResult | null> {
        const adapter = this.app.vault.adapter as FileSystemAdapter;
        const helper = this.helperPath!;
        const imagePath = adapter.getFullPath(file.path);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execFile } = require('child_process') as { execFile: ExecFile };

        return new Promise(resolve => {
            execFile(helper, [imagePath], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('[HiNote] 认图里的字失败:', file.path, stderr || error);
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout) as OcrResult);
                } catch (parseError) {
                    console.error('[HiNote] 认字结果读不懂:', file.path, parseError);
                    resolve(null);
                }
            });
        });
    }

    private async sha1(file: TFile): Promise<string> {
        const digest = await crypto.subtle.digest('SHA-1', await this.app.vault.readBinary(file));
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
}

/**
 * 把认出来的词做成和 .svg 图一样的字层：每个词一个 <text>，放在认出来的位置，
 * textLength 把它撑到和图里那个词一样宽。字层是透明的，字体是什么无所谓，
 * 要紧的是每个字落在图里那个字上面。
 */
export function ocrSvg(result: OcrResult): SVGSVGElement | null {
    const tokens = result.lines.flatMap(line => line.tokens);
    if (tokens.length === 0) return null;

    const svg = activeDocument.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${result.width} ${result.height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    // <img> 默认把图拉满整个框，这层也一样
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('font-family', 'sans-serif');
    if (result.dark) svg.addClass('is-dark');

    for (const token of tokens) {
        const text = activeDocument.createElementNS(SVG_NS, 'text');
        const size = token.h * 0.95;
        text.setAttribute('x', `${token.x}`);
        text.setAttribute('y', `${token.y + token.h * 0.74}`);
        text.setAttribute('font-size', `${size}`);
        text.setAttribute('textLength', `${Math.max(token.w, 1)}`);
        text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        // 高亮的上下边用认出来的框，比字体量出来的准
        text.dataset.boxY = `${token.y}`;
        text.dataset.boxH = `${token.h}`;
        text.textContent = token.t;
        svg.appendChild(text);
    }
    return svg;
}

function cacheName(path: string): string {
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
        hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
    }
    const safe = path.replace(/[/\\:*?"<>|\s]+/g, '_').toLowerCase().slice(-80);
    return `${safe}-${(hash >>> 0).toString(36)}.json`;
}
