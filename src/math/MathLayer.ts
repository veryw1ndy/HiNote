import type { HighlightInfo as HiNote } from '../types/highlight';
import { MathBox, MathDom } from './mathDom';

interface DrawnHighlight {
    highlight: HiNote;
    boxes: MathBox[];
    rects: HTMLElement[];
}

/** 一个公式上面的那层：画高亮的色块、拖框时的蓝色预选 */
export class MathLayer {
    private highlights: HiNote[] = [];
    private pending: number[] = [];
    private drawn: DrawnHighlight[] = [];
    private marks: HTMLElement;
    private resizeObserver: ResizeObserver;

    /** 每次画完调用：在画上的高亮旁边放批注按钮 */
    onDrawn: ((layer: MathLayer, drawn: HiNote[]) => void) | null = null;

    constructor(
        readonly container: HTMLElement,
        readonly sig: string,
        readonly sourcePath: string
    ) {
        container.classList.add('hi-note-math-host');
        this.marks = activeDocument.createElement('span');
        this.marks.className = 'hi-note-math-marks';
        container.insertBefore(this.marks, container.firstChild);
        this.resizeObserver = new ResizeObserver(() => this.draw());
        this.resizeObserver.observe(container);
    }

    get connected(): boolean {
        return this.container.isConnected && this.marks.isConnected;
    }

    destroy(): void {
        this.resizeObserver.disconnect();
        this.marks.remove();
        this.container.classList.remove('hi-note-math-host');
    }

    setHighlights(list: HiNote[]): void {
        this.highlights = list;
        this.draw();
    }

    setPending(idxs: number[]): void {
        this.pending = idxs;
        this.draw();
    }

    draw(): void {
        this.marks.textContent = '';
        this.drawn = [];
        // 藏起来的那一页（阅读 / 编辑只显示一个）没有大小，画不了
        if (this.container.offsetWidth === 0) {
            this.onDrawn?.(this, []);
            return;
        }
        const add = (boxes: MathBox[], cls: string, h: HiNote | null) => boxes.map(b => {
            const d = activeDocument.createElement('span');
            d.className = `hi-note-math-mark ${cls}`;
            d.style.left = `${b.x}px`;
            d.style.top = `${b.y}px`;
            d.style.width = `${b.width}px`;
            d.style.height = `${b.height}px`;
            if (h?.id) d.dataset.highlightId = h.id;
            this.marks.appendChild(d);
            return d;
        });
        for (const h of this.highlights) {
            const f = h.figure;
            if (f?.kind !== 'math' || !Array.isArray(f.leaves)) continue;
            const boxes = MathDom.boxes(this.container, f.leaves);
            if (!boxes.length) continue;
            const commented = !!h.comments?.length;
            const rects = add(boxes, commented ? 'hi-note-commented' : '', h);
            if (!commented && h.backgroundColor) rects.forEach(r => (r.style.background = h.backgroundColor!));
            this.drawn.push({ highlight: h, boxes, rects });
        }
        if (this.pending.length) add(MathDom.boxes(this.container, this.pending), 'hi-note-math-pending', null);
        this.onDrawn?.(this, this.drawn.map(d => d.highlight));
    }

    highlightAt(x: number, y: number): HiNote | null {
        const cr = this.container.getBoundingClientRect();
        const px = x - cr.left + this.container.scrollLeft;
        const py = y - cr.top + this.container.scrollTop;
        const hit = this.drawn.find(d => d.boxes.some(b =>
            px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height));
        return hit ? hit.highlight : null;
    }

    /** 批注按钮放在最后一块的右上角 */
    anchorPoint(id: string): { left: number; top: number } | null {
        const d = this.drawn.find(q => q.highlight.id === id);
        const b = d && d.boxes[d.boxes.length - 1];
        return b ? { left: b.x + b.width + 1, top: b.y - 9 } : null;
    }

    hasHighlight(id: string): boolean {
        return this.drawn.some(d => d.highlight.id === id);
    }

    flash(id: string): void {
        const d = this.drawn.find(q => q.highlight.id === id);
        if (!d) return;
        this.container.scrollIntoView({ block: 'center', behavior: 'smooth' });
        d.rects.forEach(r => {
            r.classList.remove('hi-note-math-flash');
            r.getBoundingClientRect(); // 让动画从头再放一遍
            r.classList.add('hi-note-math-flash');
        });
    }
}
