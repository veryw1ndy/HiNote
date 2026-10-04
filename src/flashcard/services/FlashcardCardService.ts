import type { FlashcardState, FSRSStorage } from '../types/FSRSTypes';
import { CardGroupFilterMatcher } from './CardGroupFilterMatcher';
import type { CardGroupRepository } from './CardGroupRepository';

interface FlashcardCardServiceOptions {
    getStorage: () => FSRSStorage;
    createCard: (text: string, answer: string, filePath?: string) => FlashcardState;
    getGroupRepository: () => CardGroupRepository;
    addCardToGroup: (cardId: string, groupId: string) => boolean;
    saveDebounced: () => void;
}

export class FlashcardCardService {
    constructor(private options: FlashcardCardServiceOptions) {}

    addCard(
        text: string,
        answer: string,
        filePath?: string,
        sourceId?: string,
        sourceType?: 'highlight' | 'comment'
    ): FlashcardState {
        const card = this.options.createCard(text, answer, filePath);

        if (sourceId && sourceType) {
            card.sourceId = sourceId;
            card.sourceType = sourceType;
        }

        this.options.getStorage().cards[card.id] = card;
        this.checkAndAddCardToGroups(card);
        this.options.saveDebounced();

        return card;
    }

    getCardsByFile(filePath: string): FlashcardState[] {
        return Object.values(this.options.getStorage().cards).filter(card => card.filePath === filePath);
    }

    getAllCards(): FlashcardState[] {
        return Object.values(this.options.getStorage().cards);
    }

    getTotalCardsCount(): number {
        return Object.keys(this.options.getStorage().cards).length;
    }

    private checkAndAddCardToGroups(card: FlashcardState): number {
        if (!card || !card.id) {
            return 0;
        }

        const allGroups = this.options.getGroupRepository().getCardGroups();
        if (!allGroups || allGroups.length === 0) {
            return 0;
        }

        let addedCount = 0;
        for (const group of allGroups) {
            if (!group.filter || group.filter.trim().length === 0) {
                continue;
            }

            if (CardGroupFilterMatcher.matches(card, group.filter)
                && this.options.addCardToGroup(card.id, group.id)) {
                addedCount++;
            }
        }

        return addedCount;
    }
}
