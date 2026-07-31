import { html } from '../vendor/preact-htm.js';
import { t } from '../utils/i18n.js';

export function OobePanel({
  kind = 'hidden',
  onSetupProvider,
  onDismiss,
}) {
  if (kind === 'hidden') return null;

  const isProviderMissing = kind === 'provider-missing';
  const title = isProviderMissing ? t('oobe.needsSetupTitle') : t('oobe.configuredTitle');
  const body = isProviderMissing
    ? t('oobe.needsSetupBody')
    : t('oobe.configuredBody');
  return html`
    <section class=${`oobe-panel oobe-panel-${kind}`} aria-label=${t('oobe.gettingStarted')}>
      <div class="oobe-panel-copy">
        <div class="oobe-panel-eyebrow">${t('oobe.gettingStarted')}</div>
        <h2 class="oobe-panel-title">${title}</h2>
        <p class="oobe-panel-body">${body}</p>
      </div>
      <div class="oobe-panel-actions">
        <button type="button" class="oobe-panel-btn oobe-panel-btn-primary" onClick=${() => onSetupProvider?.()}>
          ${t('oobe.openSettings')}
        </button>
        <button type="button" class="oobe-panel-btn" onClick=${() => onDismiss?.()}>
          ${isProviderMissing ? t('oobe.dismiss') : t('oobe.done')}
        </button>
      </div>
    </section>
  `;
}
