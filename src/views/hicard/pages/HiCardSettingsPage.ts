import { Notice } from 'obsidian';
import type CommentPlugin from '../../../../main';
import { t } from '../../../i18n';
import { FlashcardSettingsTab } from '../../../flashcard';
import { LicenseManager } from '../../../services/LicenseManager';
import { renderHiCardPageHeader } from './HiCardPageHeader';

export class HiCardSettingsPage {
    private container: HTMLElement | null = null;
    private generation = 0;
    constructor(private plugin: CommentPlugin) {}

    render(container: HTMLElement): void {
        const generation = ++this.generation;
        this.container = container;
        container.empty();
        container.addClass('hicard-page', 'hicard-settings-page');
        renderHiCardPageHeader(
            container,
            t('Learning settings'),
            t('Configure global daily limits and FSRS scheduling.')
        );
        void this.renderSettingsBody(container, generation);
    }

    destroy(): void {
        this.generation++;
        this.container = null;
    }

    private async renderSettingsBody(container: HTMLElement, generation: number): Promise<void> {
        const licenseManager = new LicenseManager(this.plugin);
        const activated = await licenseManager.isActivated();
        if (this.container !== container || generation !== this.generation) return;
        if (!activated) {
            this.renderActivation(container, licenseManager);
            return;
        }
        new FlashcardSettingsTab(this.plugin, container).display();
    }

    private renderActivation(container: HTMLElement, licenseManager: LicenseManager): void {
        const activation = container.createDiv({ cls: 'flashcard-activation-container' });
        activation.createDiv({ cls: 'flashcard-activation-header', text: t('Activate HiCard') });
        const description = activation.createDiv({ cls: 'flashcard-activation-description' });
        description.createSpan({ text: `${t('Enter your license key to activate HiCard feature.')} ` });
        description.createEl('br');
        description.createSpan({ text: `${t('Get your license key from')} ` });
        const locale = (window as Window & { moment?: { locale(): string } }).moment?.locale() || 'en';
        const websiteUrl = locale.startsWith('zh')
            ? 'https://www.hinote.vip/index.html'
            : 'https://www.hinote.vip/en.html';
        const link = description.createEl('a', {
            text: t('HiNote official website'),
            cls: 'external-link',
            href: websiteUrl
        });
        link.setAttr('target', '_blank');
        link.setAttr('rel', 'noopener noreferrer');
        const inputContainer = activation.createDiv({ cls: 'flashcard-activation-input-container' });
        const input = inputContainer.createEl('input', {
            cls: 'flashcard-activation-input',
            type: 'text',
            placeholder: t('Enter license key')
        });
        const button = inputContainer.createEl('button', {
            cls: 'flashcard-activation-button',
            text: t('Activate')
        });
        const message = activation.createDiv({ cls: 'activation-msg' });
        button.addEventListener('click', () => {
            void this.activateLicense(input, button, message, licenseManager, container);
        });
    }

    private async activateLicense(
        input: HTMLInputElement,
        button: HTMLButtonElement,
        message: HTMLElement,
        licenseManager: LicenseManager,
        container: HTMLElement
    ): Promise<void> {
        const licenseKey = input.value.trim();
        if (!licenseKey) {
            new Notice(t('Please enter a license key'));
            return;
        }
        button.disabled = true;
        message.textContent = t('Verifying...');
        const activated = await licenseManager.activateLicense(licenseKey);
        if (this.container !== container || !input.isConnected) return;
        if (!activated) {
            message.textContent = t('Activation failed. Please check your license key.');
            button.disabled = false;
            return;
        }
        new Notice(t('HiCard activated successfully!'));
        this.render(container);
    }

}
