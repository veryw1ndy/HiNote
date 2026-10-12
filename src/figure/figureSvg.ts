import { TFile, Vault } from "obsidian";

/**
 * 读一张 .svg，做成「只有字」的那一层：原图的副本，盖在 <img> 上面，
 * 除了 <text> 什么都不显示，字本身也是透明的 —— 看到的还是原图，选中的是这层的字。
 *
 * 同一张图在一篇笔记里、几篇笔记里都可能出现，解析结果按路径 + 修改时间缓存，
 * 每次拿一份新的副本。
 */

interface CachedFigure {
    mtime: number;
    svg: SVGSVGElement | null;
}

const cache = new Map<string, CachedFigure>();

export async function loadFigureSvg(vault: Vault, file: TFile): Promise<SVGSVGElement | null> {
    let hit = cache.get(file.path);
    if (!hit || hit.mtime !== file.stat.mtime) {
        hit = { mtime: file.stat.mtime, svg: parseFigure(await vault.cachedRead(file)) };
        cache.set(file.path, hit);
    }
    return hit.svg ? activeDocument.importNode(hit.svg, true) : null;
}

/** 图里所有 <text>，按出现顺序。存下来的高亮就是按这个顺序数的。 */
export function figureTexts(svg: SVGSVGElement): SVGTextElement[] {
    return Array.from(svg.querySelectorAll('text'));
}

function parseFigure(source: string): SVGSVGElement | null {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName !== 'svg' || doc.querySelector('parsererror')) return null;

    const svg = root as unknown as SVGSVGElement;
    if (figureTexts(svg).length === 0) return null;

    // 这层放进笔记页面里，不是关在 <img> 里：脚本、外部内容、链接、事件属性都不能留。
    // <style> 也拿掉 —— 放进页面后它对整个 Obsidian 生效。
    svg.querySelectorAll('script, style, foreignObject, image, iframe').forEach(el => el.remove());
    [svg, ...Array.from(svg.querySelectorAll('*'))].forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase();
            // id 也去掉：几张图里都有 id="a" 的话，页面里就重名了
            if (name.startsWith('on') || name === 'href' || name === 'xlink:href' || name === 'id') {
                el.removeAttribute(attr.name);
            }
        });
    });

    // 跟着 <img> 的大小缩放：<img> 里的 SVG 也是把 viewBox 撑满整个框
    if (!svg.getAttribute('viewBox')) {
        const width = parseFloat(svg.getAttribute('width') || '');
        const height = parseFloat(svg.getAttribute('height') || '');
        if (!(width > 0 && height > 0)) return null;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');

    return svg;
}
