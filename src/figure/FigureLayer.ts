import { FigureAnchor, HighlightInfo as HiNote } from "../types/highlight";
import { figureTexts } from "./figureSvg";

const SVG_NS = "http://www.w3.org/2000/svg";
/** 高亮比字框四周多出来一点，看起来才像马克笔划的，而不是贴着字边的框 */
const PAD = 0.8;
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

export interface FigureSelection {
    from: FigureAnchor['from'];
    to: FigureAnchor['to'];
    text: string;
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface DrawnHighlight {
    highlight: HiNote;
    boxes: Box[];
    rects: SVGRectElement[];
}

/**
 * 盖在一张图上的字层。
 *
 * <img> 原样不动，旁边放一份只有字的 SVG（见 figureSvg.ts），大小位置跟着 <img> 走。
 * 字是透明的，所以看到的还是原图，但鼠标能选中它们。高亮画成这层最底下的半透明方块，
 * 用 multiply 叠上去，底下原图的字还是清清楚楚。
 */
export class FigureLayer {
    readonly svg: SVGSVGElement;
    private readonly host: HTMLElement;
    private readonly texts: SVGTextElement[];
    private readonly marks: SVGGElement;
    private readonly resizeObserver: ResizeObserver;
    private drawn: DrawnHighlight[] = [];
    private highlights: HiNote[] = [];
    /** 每次重画完调用：批注图标要跟着高亮挪 */
    onDrawn: ((highlights: HiNote[]) => void) | null = null;

    constructor(
        readonly img: HTMLImageElement,
        readonly figurePath: string,
        readonly sourcePath: string,
        svg: SVGSVGElement
    ) {
        this.svg = svg;
        this.svg.addClass('hi-note-figure-layer');
        this.texts = figureTexts(svg);

        this.marks = activeDocument.createElementNS(SVG_NS, 'g');
        this.marks.addClass('hi-note-figure-marks');
        this.svg.insertBefore(this.marks, this.svg.firstChild);

        this.host = img.parentElement as HTMLElement;
        if (getComputedStyle(this.host).position === 'static') {
            this.host.addClass('hi-note-figure-host');
        }
        img.insertAdjacentElement('afterend', this.svg as unknown as Element);

        // 实时预览里点到字上，编辑器会抢走鼠标去移光标、选中整个嵌入，字就选不了了
        this.svg.addEventListener('mousedown', event => event.stopPropagation());

        this.resizeObserver = new ResizeObserver(() => this.layout());
        this.resizeObserver.observe(img);
        img.addEventListener('load', this.onImgLoad);
        this.layout();
    }

    get connected(): boolean {
        return this.img.isConnected && this.svg.isConnected;
    }

    destroy(): void {
        this.resizeObserver.disconnect();
        this.img.removeEventListener('load', this.onImgLoad);
        this.svg.remove();
        if (this.host.querySelectorAll('.hi-note-figure-layer').length === 0) {
            this.host.removeClass('hi-note-figure-host');
        }
    }

    private onImgLoad = () => this.layout();

    /** 跟着 <img> 摆：同样的位置，同样的大小 */
    private layout(): void {
        const style = this.svg.style;
        style.left = `${this.img.offsetLeft}px`;
        style.top = `${this.img.offsetTop}px`;
        style.width = `${this.img.offsetWidth}px`;
        style.height = `${this.img.offsetHeight}px`;
        // 字框要等摆好、有尺寸了才量得出来
        this.draw();
    }

    setHighlights(highlights: HiNote[]): void {
        this.highlights = highlights;
        this.draw();
    }

    /** 选区落在这张图的字上的话，换成「第几个字到第几个字」 */
    selectionFrom(range: Range): FigureSelection | null {
        const hit = this.texts
            .map((el, index) => ({ el, index }))
            .filter(({ el }) => range.intersectsNode(el));
        if (hit.length === 0) return null;

        const first = hit[0];
        const last = hit[hit.length - 1];
        let fromChar = first.el.contains(range.startContainer)
            ? charOffset(first.el, range.startContainer, range.startOffset)
            : 0;
        let toChar = last.el.contains(range.endContainer)
            ? charOffset(last.el, range.endContainer, range.endOffset)
            : (last.el.textContent || '').length;

        // 拖选常常带上两头的空格，高亮别把空格也涂上
        const firstText = first.el.textContent || '';
        const lastText = last.el.textContent || '';
        while (fromChar < firstText.length && /\s/.test(firstText[fromChar])) fromChar++;
        while (toChar > 0 && /\s/.test(lastText[toChar - 1])) toChar--;

        const pieces = hit.map(({ el, index }) => {
            const all = el.textContent || '';
            const start = index === first.index ? fromChar : 0;
            const end = index === last.index ? toChar : all.length;
            return all.slice(start, end).trim();
        }).filter(Boolean);

        // 词和词之间补空格；中文一个字一个 <text>，字和字之间不补
        const text = pieces.reduce((joined, piece) =>
            joined && !(CJK.test(joined[joined.length - 1]) && CJK.test(piece[0])) ? `${joined} ${piece}` : joined + piece, '');
        if (!text) return null;

        return { from: [first.index, fromChar], to: [last.index, toChar], text };
    }

    /** 屏幕上这一点落在哪处高亮上 */
    highlightAt(clientX: number, clientY: number): HiNote | null {
        const point = this.toFigure(clientX, clientY);
        if (!point) return null;
        const found = this.drawn.find(d => d.boxes.some(b =>
            point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height
        ));
        return found?.highlight ?? null;
    }

    /** 某处高亮最后一块的右上角，在 host 里的像素位置 —— 批注图标放这儿 */
    anchorPoint(highlightId: string): { left: number; top: number } | null {
        const found = this.drawn.find(d => d.highlight.id === highlightId);
        const rect = found?.rects[found.rects.length - 1];
        if (!rect) return null;
        const box = rect.getBoundingClientRect();
        const hostBox = this.host.getBoundingClientRect();
        return {
            left: box.right - hostBox.left + this.host.scrollLeft,
            top: box.top - hostBox.top + this.host.scrollTop
        };
    }

    hasHighlight(highlightId: string): boolean {
        return this.drawn.some(d => d.highlight.id === highlightId);
    }

    get hostEl(): HTMLElement {
        return this.host;
    }

    flash(highlightId: string): void {
        const found = this.drawn.find(d => d.highlight.id === highlightId);
        if (!found) return;
        this.img.scrollIntoView({ block: 'center', behavior: 'smooth' });
        found.rects.forEach(rect => {
            rect.removeClass('hi-note-figure-flash');
            // 读一下布局让动画能重新开始
            void rect.getBoundingClientRect();
            rect.addClass('hi-note-figure-flash');
        });
    }

    private draw(): void {
        this.marks.empty();
        this.drawn = [];
        if (this.img.offsetWidth === 0) {
            this.onDrawn?.([]);
            return;
        }

        for (const highlight of this.highlights) {
            const figure = highlight.figure;
            if (!figure || figure.kind !== undefined) continue;

            const boxes = this.boxesFor(figure);
            if (boxes.length === 0) continue;

            const commented = !!highlight.comments?.length;
            const rects = boxes.map(box => {
                const rect = activeDocument.createElementNS(SVG_NS, 'rect');
                rect.setAttribute('x', `${box.x}`);
                rect.setAttribute('y', `${box.y}`);
                rect.setAttribute('width', `${box.width}`);
                rect.setAttribute('height', `${box.height}`);
                rect.setAttribute('rx', '1.5');
                rect.addClass('hi-note-figure-mark');
                if (commented) rect.addClass('hi-note-commented');
                if (!commented && highlight.backgroundColor) {
                    rect.style.fill = highlight.backgroundColor;
                }
                if (highlight.id) rect.dataset.highlightId = highlight.id;
                this.marks.appendChild(rect);
                return rect;
            });

            this.drawn.push({ highlight, boxes, rects });
        }
        this.onDrawn?.(this.drawn.map(d => d.highlight));
    }

    /** 一处高亮在图里占的方块：每个 <text> 一块，用整张图的坐标 */
    private boxesFor(figure: FigureAnchor): Box[] {
        const [fromText, fromChar] = figure.from;
        const [toText, toChar] = figure.to;
        const boxes: Box[] = [];

        for (let index = fromText; index <= toText; index++) {
            const el = this.texts[index];
            if (!el) continue;

            let count: number;
            try {
                count = el.getNumberOfChars();
            } catch {
                continue;
            }
            const start = index === fromText ? fromChar : 0;
            const end = Math.min(index === toText ? toChar : count, count);
            if (end <= start) continue;

            try {
                const a = el.getExtentOfChar(start);
                const b = el.getExtentOfChar(end - 1);
                const local = {
                    x: Math.min(a.x, b.x),
                    y: Math.min(a.y, b.y),
                    right: Math.max(a.x + a.width, b.x + b.width),
                    bottom: Math.max(a.y + a.height, b.y + b.height)
                };
                // 截图里认出来的词带着自己的框（见 ocr.ts），上下边以它为准
                const boxY = parseFloat(el.dataset.boxY ?? '');
                const boxH = parseFloat(el.dataset.boxH ?? '');
                if (boxY >= 0 && boxH > 0) {
                    local.y = boxY;
                    local.bottom = boxY + boxH;
                }
                const box = this.toRoot(el, local);
                if (box) boxes.push(box);
            } catch {
                // 图还没摆出来（比如在折叠的段落里），下次 layout 再画
            }
        }
        return boxes;
    }

    /** <text> 自己坐标里的框 → 整张图的坐标（字可能在带 transform 的 <g> 里） */
    private toRoot(el: SVGTextElement, r: { x: number; y: number; right: number; bottom: number }): Box | null {
        const rootCtm = this.svg.getScreenCTM();
        const elCtm = el.getScreenCTM();
        if (!rootCtm || !elCtm) return null;
        const m = rootCtm.inverse().multiply(elCtm);

        const corners = [
            new DOMPoint(r.x, r.y), new DOMPoint(r.right, r.y),
            new DOMPoint(r.x, r.bottom), new DOMPoint(r.right, r.bottom)
        ].map(p => p.matrixTransform(m));
        const xs = corners.map(p => p.x);
        const ys = corners.map(p => p.y);
        const x = Math.min(...xs) - PAD;
        const y = Math.min(...ys) - PAD;
        return {
            x,
            y,
            width: Math.max(...xs) + PAD - x,
            height: Math.max(...ys) + PAD - y
        };
    }

    private toFigure(clientX: number, clientY: number): DOMPoint | null {
        const ctm = this.svg.getScreenCTM();
        if (!ctm) return null;
        return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    }
}

/** 选区一端在这个 <text> 里是第几个字 */
function charOffset(el: Element, node: Node, offset: number): number {
    const range = activeDocument.createRange();
    range.setStart(el, 0);
    range.setEnd(node, offset);
    return range.toString().length;
}
