// Move the native toggle so its click handler and game-owned state stay intact.
export function setupTapDropButton(): void {
    const selector = '.inventory-touch-actions > button';

    const mount = (root: ParentNode) => {
        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(selector));
        if (root instanceof HTMLButtonElement && root.matches(selector)) buttons.push(root);

        for (const button of buttons) {
            const shell = button.closest<HTMLElement>('#side-panel-shell');
            if (!shell) continue;

            // Inventory tabs can be rebuilt. Discard the previous tab's toggle.
            shell.querySelector(':scope > .camelkit-tap-drop-button')?.remove();
            button.classList.add('camelkit-tap-drop-button');
            const updateLabel = () => {
                const active = button.getAttribute('aria-pressed') === 'true';
                const label = `Tap to drop: ${active ? 'On' : 'Off'}`;
                button.setAttribute('aria-label', label);
                button.title = label;
            };
            updateLabel();
            new MutationObserver(updateLabel).observe(button, {
                attributes: true,
                attributeFilter: ['aria-pressed'],
            });
            shell.appendChild(button);
        }
    };

    mount(document);
    new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element) mount(node);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}
