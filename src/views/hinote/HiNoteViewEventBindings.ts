import { Component } from "obsidian";
import { CommentController, HighlightListController } from "../highlight";
import { EventCoordinator, FileListManager } from "../managers";
import { SelectionManager } from "../selection";
import { ViewState } from "./ViewState";

interface HiNoteViewEventBindingOptions {
    component: Component;
    container: HTMLElement;
    state: ViewState;
    eventCoordinator: EventCoordinator;
    highlightContainer: HTMLElement;
    selectionManager: SelectionManager;
    fileListManager: FileListManager;
    highlightListController: HighlightListController;
    commentController: CommentController;
    checkViewPosition: () => Promise<void>;
}

export function registerHiNoteViewEvents(options: HiNoteViewEventBindingOptions): void {
    const {
        component,
        container,
        state,
        eventCoordinator,
        highlightContainer,
        selectionManager,
        fileListManager,
        highlightListController,
        commentController,
        checkViewPosition
    } = options;

    const handleMultiSelect = () => {
        selectionManager.updateSelectedHighlights();
    };
    container.addEventListener("highlight-multi-select", handleMultiSelect);
    component.register(() => {
        container.removeEventListener("highlight-multi-select", handleMultiSelect);
    });

    component.registerDomEvent(activeDocument, "click", (e: MouseEvent) => {
        if (selectionManager.isInSelectionMode()) {
            return;
        }

        const selectedCount = selectionManager.getSelectedCount();
        if (selectedCount <= 1) {
            return;
        }

        const target = e.target as HTMLElement;
        if (!target.closest(".multi-select-actions") &&
            !target.closest(".highlight-card.selected") &&
            !target.closest(".highlight-container")) {
            selectionManager.clearSelection();
        }
    });

    eventCoordinator.setCallbacks({
        onFileOpen: (file, isInCanvas) => {
            state.currentFile = file;
            void highlightListController.updateHighlights(isInCanvas);
        },
        onFileModify: (file, isInCanvas) => {
            fileListManager.invalidateCache();
            void highlightListController.updateHighlights(isInCanvas);
        },
        onFileCreate: () => {
            fileListManager.invalidateCache();
        },
        onFileDelete: () => {
            fileListManager.invalidateCache();
        },
        onLayoutChange: () => {
            void checkViewPosition();
        },
        onCommentInput: (highlightId, text, highlight) => {
            eventCoordinator.handleCommentInputDisplay(
                highlightId,
                text,
                highlight,
                highlightContainer,
                (card, highlight) => commentController.showCommentInput(card, highlight)
            );
        }
    });
    eventCoordinator.registerAllEvents(
        () => state.currentFile,
        () => state.isDraggedToMainView
    );
    eventCoordinator.registerKeyboardEvents(highlightContainer);
}
