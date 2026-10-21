import { MathSource } from './mathSource';

/** 拖出来的框，屏幕坐标 */
export interface DragBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface MathBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 读 MathJax 画出来的公式。
 *
 * 渲染出来的公式里没有能选的字，图那套靠 <text> 的办法用不上。MathJax 有两种画法：
 *   HTML（Obsidian 1.14 用的）：每个字形是一个 <mjx-c>，分数线是 <mjx-line>；
 *   SVG（旧版 Obsidian）：每个字形是一个里面没有别的节点的 <g data-mml-node>，线是 <rect>。
 * 每个字形或线叫一个「叶子」，按出现的顺序编号。拖框碰到的叶子就是高亮。
 */
export class MathDom {
    static readonly SEL = 'svg g[data-mml-node], svg rect, mjx-c, mjx-line';

    /** MathJax 画完了没有 */
    static ready(c: Element): boolean {
        return !!c.querySelector('svg g[data-mml-node], mjx-math mjx-c');
    }

    static isBar(el: Element): boolean {
        return el.tagName === 'rect' || el.tagName === 'MJX-LINE';
    }

    /** 一个 mjx-container 的叶子，按文档顺序 */
    static leaves(c: Element): Element[] {
        const out: Element[] = [];
        c.querySelectorAll(this.SEL).forEach(el => {
            if (el.closest('defs, mjx-assistive-mml, .hi-note-math-marks')) return;
            if (el.tagName === 'rect') {
                const g = el.parentElement?.closest('g[data-mml-node]');
                if (g && !g.querySelector('g[data-mml-node]')) return; // 是某个字形的一部分
                out.push(el);
            } else if (el.tagName === 'g') {
                if (!el.querySelector('g[data-mml-node]')) out.push(el);
            } else {
                out.push(el);
            }
        });
        return out;
    }

    /** MathJax 用数学字母区（𝑥 之类）画的字母，换回普通字母 */
    static fold(cp: number): string {
        if (cp >= 0x1d400 && cp <= 0x1d6a3) {
            const i = (cp - 0x1d400) % 52;
            return String.fromCharCode(i < 26 ? 65 + i : 97 + i - 26);
        }
        if (cp >= 0x1d7ce && cp <= 0x1d7ff) return String.fromCharCode(48 + ((cp - 0x1d7ce) % 10));
        return String.fromCodePoint(cp);
    }

    static codes(el: Element): string[] {
        if (el.tagName === 'MJX-C') {
            const m = /(?:^|\s)mjx-c([0-9A-F]+)/i.exec(el.className);
            if (m) return [m[1].toUpperCase()];
            const t = el.textContent;
            return t ? [(t.codePointAt(0) ?? 0).toString(16).toUpperCase()] : [];
        }
        const out: string[] = [];
        el.querySelectorAll('[data-c]').forEach(u => out.push(u.getAttribute('data-c') || ''));
        return out;
    }

    static kind(el: Element): string {
        if (this.isBar(el)) return 'bar';
        return el.tagName === 'MJX-C' ? 'c' : el.getAttribute('data-mml-node') || '';
    }

    static chain(el: Element, root: Element): string {
        const out: string[] = [];
        for (let n = el.parentElement; n && n !== root; n = n.parentElement) {
            const t = n.getAttribute('data-mml-node') ||
                (n.tagName.startsWith('MJX-') ? n.tagName.slice(4).toLowerCase() : null);
            if (t) out.push(t);
        }
        return out.reverse().join('>');
    }

    /**
     * 公式的指纹：每个叶子的字形编码和它外面的节点类型，算个哈希。
     * 高亮跟着公式走，不跟行号走；公式一改，指纹就变，高亮消失，而不是落到别的字形上。
     */
    static signature(c: Element): string {
        const key = this.leaves(c)
            .map(el => `${this.kind(el)}@${this.chain(el, c)}:${this.codes(el).join('.')}`)
            .join('|');
        let h = 5381;
        for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
        return `math-${(h >>> 0).toString(36)}-${key.length.toString(36)}`;
    }

    /** 公式自己的 LaTeX（MathJax 留着的话） */
    static latex(c: Element): string {
        return c.querySelector('[data-latex]')?.getAttribute('data-latex') || '';
    }

    /** 去掉空白的 LaTeX，用来认出同一个公式的几份 */
    static strip(c: Element): string {
        return MathSource.strip(this.latex(c));
    }

    /** 划中的叶子是哪些字，给侧栏看 */
    static textOf(c: Element, idxs: number[]): string {
        const L = this.leaves(c);
        const parts: string[] = [];
        idxs.forEach(i => {
            const el = L[i];
            if (!el) return;
            if (this.isBar(el)) {
                parts.push('―');
                return;
            }
            const s = this.codes(el).map(x => this.fold(parseInt(x, 16))).join('');
            if (s) parts.push(s);
        });
        return parts.join(' ').replace(/([\\`*_{}[\]<>#~|$=])/g, '\\$1');
    }

    /** 拖的框碰到了哪些叶子。很扁的框当一行算，所以沿着公式拖就像拖文字一样 */
    static pick(c: Element, b: DragBox): number[] {
        const x0 = Math.min(b.x0, b.x1);
        const x1 = Math.max(b.x0, b.x1);
        let y0 = Math.min(b.y0, b.y1);
        let y1 = Math.max(b.y0, b.y1);
        const thin = y1 - y0 < 14;
        if (thin) {
            const m = (y0 + y1) / 2;
            y0 = m - 9;
            y1 = m + 9;
        }
        const out: number[] = [];
        this.leaves(c).forEach((el, i) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const ox = Math.min(r.right, x1) - Math.max(r.left, x0);
            const oy = Math.min(r.bottom, y1) - Math.max(r.top, y0);
            const inX = (cx >= x0 && cx <= x1) || ox >= r.width * 0.5;
            const inY = thin ? oy > 0 : (cy >= y0 && cy <= y1) || oy >= r.height * 0.5;
            if (inX && inY) out.push(i);
        });
        return out;
    }

    /** 盖住这些叶子的框（相对公式容器）；同一行挨着的合成一个 */
    static boxes(c: HTMLElement, idxs: number[]): MathBox[] {
        const L = this.leaves(c);
        const cr = c.getBoundingClientRect();
        const pad = 1.5;
        const bs: { x: number; y: number; r: number; b: number }[] = [];
        idxs.forEach(i => {
            const el = L[i];
            if (!el) return;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return;
            bs.push({
                x: r.left - cr.left + c.scrollLeft - pad,
                y: r.top - cr.top + c.scrollTop - pad,
                r: r.right - cr.left + c.scrollLeft + pad,
                b: r.bottom - cr.top + c.scrollTop + pad
            });
        });
        for (let again = true; again;) {
            again = false;
            outer: for (let i = 0; i < bs.length; i++) {
                for (let j = i + 1; j < bs.length; j++) {
                    const a = bs[i];
                    const d = bs[j];
                    const oy = Math.min(a.b, d.b) - Math.max(a.y, d.y);
                    const gap = Math.max(a.x, d.x) - Math.min(a.r, d.r);
                    if (oy >= Math.min(a.b - a.y, d.b - d.y) * 0.5 && gap <= 5) {
                        bs[i] = { x: Math.min(a.x, d.x), y: Math.min(a.y, d.y), r: Math.max(a.r, d.r), b: Math.max(a.b, d.b) };
                        bs.splice(j, 1);
                        again = true;
                        break outer;
                    }
                }
            }
        }
        return bs.map(q => ({ x: q.x, y: q.y, width: q.r - q.x, height: q.b - q.y }));
    }
}
