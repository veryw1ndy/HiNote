import type { HighlightCard } from './HighlightCard';

export class HighlightCardRegistry {
    private instances = new Set<HighlightCard>();

    register(card: HighlightCard): void {
        this.instances.add(card);
    }

    unregister(card: HighlightCard): void {
        this.instances.delete(card);
    }

    clearAll(): void {
        Array.from(this.instances).forEach(card => card.destroy());
        this.instances.clear();
    }

    clearAllUnfocusedInputs(): void {
        this.instances.forEach(card => card.clearUnfocusedInput());
    }

    /**
     * 侧栏重画时很多地方只清空了容器、没注销旧卡片，旧卡片还留在这里。
     * 按 ID 找到旧的那张，批注就改到看不见的卡片上，屏幕上那张不动。所以只认还在页面上的。
     */
    private liveInstances(): HighlightCard[] {
        // 只筛不删：刚建好、还没放进侧栏的卡片也不在页面上
        return Array.from(this.instances).filter(instance => instance.getElement().isConnected);
    }

    findByHighlightId(highlightId: string): HighlightCard | null {
        if (!highlightId) return null;
        return this.liveInstances().find(instance => instance.getHighlightId() === highlightId) || null;
    }

    findByElement(element: HTMLElement): HighlightCard | null {
        return this.liveInstances().find(instance => {
            const cardElement = instance.getElement();
            return cardElement === element || cardElement.contains(element);
        }) || null;
    }

    /**
     * 按 ID 找不到时的退路：同样的文字、同一类（图里的 / 正文里的），离原文位置最近的那张。
     * 以前是「第一张文字一样的」，于是点正文的 home MTSO 打开的是图里那张。
     */
    findByHighlight(highlight: { id?: string; text: string; position?: number; figure?: unknown }): HighlightCard | null {
        const byId = this.findByHighlightId(highlight.id || '');
        if (byId) return byId;

        const distance = (card: HighlightCard) =>
            typeof highlight.position === 'number' && typeof card.getHighlight().position === 'number'
                ? Math.abs(card.getHighlight().position! - highlight.position)
                : Number.MAX_SAFE_INTEGER;

        return this.liveInstances()
            .filter(card => {
                const other = card.getHighlight();
                return other.text === highlight.text && !other.figure === !highlight.figure;
            })
            .sort((a, b) => distance(a) - distance(b))[0] || null;
    }

    updateCardUIByHighlightId(highlightId: string): void {
        this.findByHighlightId(highlightId)?.updateIconsAfterCardCreation();
    }
}

export const defaultHighlightCardRegistry = new HighlightCardRegistry();
