/**
 * Dashboard controller.
 *
 * Read-only: it summarises what the other pages manage. Everything it shows is
 * derived from the repositories, so creating or deleting a record anywhere in
 * the app is reflected here on the next visit — and immediately in another
 * open tab, through the repository change events.
 */

import { qs, escapeHtml, formatBytes, formatDuration, formatRelative, initials } from './utils.js';
import { IvrRepo, AudioRepo, FlowRepo } from './repo.js';
import { fetchAsteriskStatus, fetchAsteriskExtensions } from './api.js';
import { statusBadge } from './ui.js';

const RECENT_LIMIT = 5;

/* ==========================================================================
   Statistics
   ========================================================================== */

async function renderStats() {
  const [ivrStats, audioStats] = await Promise.all([IvrRepo.stats(), AudioRepo.stats()]);

  const values = {
    total: ivrStats.total,
    active: ivrStats.active,
    inactive: ivrStats.inactive,
    audio: audioStats.total,
  };

  for (const [key, value] of Object.entries(values)) {
    const target = qs(`[data-stat="${key}"]`);
    if (target) target.textContent = String(value);
  }

  // Footers say something the number alone does not.
  const audioFoot = qs('[data-stat-foot="audio"]');
  if (audioFoot) {
    audioFoot.textContent = audioStats.total
      ? `${formatBytes(audioStats.totalBytes)} in the prompt library`
      : 'No prompts uploaded yet';
  }

  const activeFoot = qs('[data-stat-foot="active"]');
  if (activeFoot) {
    activeFoot.textContent = ivrStats.total
      ? `${Math.round((ivrStats.active / ivrStats.total) * 100)}% of all IVRs`
      : 'Nothing configured yet';
  }
}

/* ==========================================================================
   Status overview
   ========================================================================== */

async function renderStatusOverview() {
  const container = qs('[data-status-overview]');
  if (!container) return;

  const { total, active, inactive } = await IvrRepo.stats();

  if (!total) {
    container.innerHTML = `
      <div class="empty-state tw-py-6">
        <span class="empty-state__icon" aria-hidden="true"><i class="bi bi-diagram-3"></i></span>
        <p class="empty-state__title">No IVRs yet</p>
        <p class="empty-state__body">Create the first one and this will fill in.</p>
        <a class="btn btn-primary btn-sm" href="create-ivr.html">Create IVR</a>
      </div>`;
    return;
  }

  const activeShare = Math.round((active / total) * 100);

  // The bar is decorative; the legend below carries the same figures as text.
  container.innerHTML = `
    <div class="status-bar" aria-hidden="true">
      <div class="status-bar__segment status-bar__segment--ok" data-segment="active"></div>
      <div class="status-bar__segment status-bar__segment--idle" data-segment="inactive"></div>
    </div>
    <ul class="status-legend">
      <li>
        <span class="status-legend__swatch status-legend__swatch--ok" aria-hidden="true"></span>
        <span class="status-legend__label">Active</span>
        <span class="status-legend__value">${active}</span>
        <span class="status-legend__share">${activeShare}%</span>
      </li>
      <li>
        <span class="status-legend__swatch status-legend__swatch--idle" aria-hidden="true"></span>
        <span class="status-legend__label">Inactive</span>
        <span class="status-legend__value">${inactive}</span>
        <span class="status-legend__share">${100 - activeShare}%</span>
      </li>
    </ul>
    <p class="tw-mt-4 tw-mb-0 tw-text-xs tw-text-muted">
      ${
        inactive
          ? `${inactive} IVR${inactive === 1 ? '' : 's'} ${
              inactive === 1 ? 'is' : 'are'
            } configured but not answering calls.`
          : 'Every IVR is answering calls.'
      }
    </p>`;

  // Segment widths are data, not styling, so they are set here rather than
  // written into the markup as a style attribute.
  qs('[data-segment="active"]', container).style.width = `${activeShare}%`;
  qs('[data-segment="inactive"]', container).style.width = `${100 - activeShare}%`;
}

/* ==========================================================================
   Recent IVRs
   ========================================================================== */

async function renderRecentIvrs() {
  const list = qs('[data-recent-ivrs]');
  if (!list) return;

  const { items } = await IvrRepo.list({
    sort: 'updatedAt',
    direction: 'desc',
    pageSize: RECENT_LIMIT,
  });
  const menuCounts = await FlowRepo.countsByIvr();

  if (!items.length) {
    list.innerHTML = `
      <li>
        <div class="empty-state">
          <span class="empty-state__icon" aria-hidden="true"><i class="bi bi-diagram-3"></i></span>
          <p class="empty-state__title">No IVRs yet</p>
          <p class="empty-state__body">
            Create your first IVR and it will appear here with everything else you change.
          </p>
          <a class="btn btn-primary btn-sm" href="create-ivr.html">
            <i class="bi bi-plus-lg" aria-hidden="true"></i> Create IVR
          </a>
        </div>
      </li>`;
    return;
  }

  list.innerHTML = items
    .map((ivr) => {
      const optionCount = menuCounts[ivr.id] ?? 0;
      return `
        <li>
          <a class="recent-item" href="edit-ivr.html?id=${encodeURIComponent(ivr.id)}">
            <span class="recent-item__icon" aria-hidden="true">${escapeHtml(initials(ivr.name))}</span>
            <span class="recent-item__body">
              <span class="recent-item__title">${escapeHtml(ivr.name)}</span>
              <span class="recent-item__meta">
                <span class="num">Ext ${escapeHtml(ivr.extension)}</span>
                <span class="recent-item__sep" aria-hidden="true">&bull;</span>
                <span>${optionCount} menu option${optionCount === 1 ? '' : 's'}</span>
                <span class="recent-item__sep" aria-hidden="true">&bull;</span>
                <span>Updated ${escapeHtml(formatRelative(ivr.updatedAt))}</span>
              </span>
            </span>
            ${statusBadge(ivr.status)}
          </a>
        </li>`;
    })
    .join('');
}

/* ==========================================================================
   Recent audio
   ========================================================================== */

async function renderRecentAudio() {
  const list = qs('[data-recent-audio]');
  if (!list) return;

  const { items } = await AudioRepo.list({
    sort: 'createdAt',
    direction: 'desc',
    pageSize: RECENT_LIMIT,
  });

  if (!items.length) {
    list.innerHTML = `
      <li>
        <div class="empty-state">
          <span class="empty-state__icon" aria-hidden="true"><i class="bi bi-music-note-beamed"></i></span>
          <p class="empty-state__title">The prompt library is empty</p>
          <p class="empty-state__body">Upload an audio file and your IVRs will be able to play it.</p>
          <a class="btn btn-primary btn-sm" href="audio-files.html">
            <i class="bi bi-upload" aria-hidden="true"></i> Upload audio
          </a>
        </div>
      </li>`;
    return;
  }

  list.innerHTML = items
    .map(
      (file) => `
        <li>
          <a class="recent-item" href="audio-files.html?search=${encodeURIComponent(file.name)}">
            <span class="recent-item__icon" aria-hidden="true"><i class="bi bi-file-earmark-music"></i></span>
            <span class="recent-item__body">
              <span class="recent-item__title num">${escapeHtml(file.name)}</span>
              <span class="recent-item__meta">
                <span>${escapeHtml(file.format)}</span>
                <span class="recent-item__sep" aria-hidden="true">&bull;</span>
                <span class="num">${formatDuration(file.durationSeconds)}</span>
                <span class="recent-item__sep" aria-hidden="true">&bull;</span>
                <span class="num">${formatBytes(file.sizeBytes)}</span>
              </span>
            </span>
            ${statusBadge(file.status)}
          </a>
        </li>`,
    )
    .join('');
}

/* ==========================================================================
   Init
   ========================================================================== */

async function renderAll() {
  // Independent reads, so they run together rather than in sequence.
  await Promise.all([
    renderStats(),
    renderStatusOverview(),
    renderRecentIvrs(),
    renderRecentAudio(),
  ]);
}

/* ==========================================================================
   Asterisk
   ========================================================================== */

/**
 * Report whether the PBX is reachable, and what it says it has.
 *
 * Deliberately not part of renderAll(): the Asterisk calls cross the network to
 * another machine and can take seconds when it is down, while the rest of the
 * dashboard reads MySQL and returns in milliseconds. Holding the whole page on
 * an unresponsive PBX would make a healthy site look broken.
 *
 * Nothing here can throw — js/api.js turns every failure into a report — so a
 * switch that is off simply shows as Disconnected.
 */
async function renderAsterisk() {
  const statusCell = qs('[data-asterisk-status]');
  if (!statusCell) return;

  const button = qs('[data-asterisk-refresh]');
  const message = qs('[data-asterisk-message]');
  const list = qs('[data-asterisk-extensions]');

  if (button) button.disabled = true;
  statusCell.innerHTML = '<span class="skeleton"></span>';

  const [status, endpoints] = await Promise.all([
    fetchAsteriskStatus(),
    fetchAsteriskExtensions(),
  ]);

  statusCell.innerHTML = status.connected
    ? '<span class="status status--ok"><span class="status__dot" aria-hidden="true"></span>Connected</span>'
    : '<span class="status status--danger"><span class="status__dot" aria-hidden="true"></span>Disconnected</span>';

  // Straight from the server's own view of its settings, so the panel cannot
  // drift from what the API is actually dialling. No credential is included.
  qs('[data-asterisk-host]').textContent = status.host || '—';
  qs('[data-asterisk-port]').textContent = status.port || '—';
  qs('[data-asterisk-extension-count]').textContent = endpoints.success
    ? String(endpoints.extensions.length)
    : '—';

  if (message) {
    message.textContent = status.connected
      ? endpoints.status_source
        ? `Extensions read from ${endpoints.status_source}.`
        : ''
      : status.message || 'Asterisk could not be reached.';
  }

  if (list) {
    const rows = endpoints.extensions ?? [];
    list.hidden = rows.length === 0;
    list.innerHTML = rows.length
      ? `<ul class="asterisk-extensions">${rows
          .map(
            (row) => `
              <li>
                <span class="num">${escapeHtml(row.extension)}</span>
                <span class="asterisk-extensions__meta">
                  ${escapeHtml(row.status)}${row.context ? ` · ${escapeHtml(row.context)}` : ''}
                </span>
              </li>`,
          )
          .join('')}</ul>`
      : '';
  }

  if (button) button.disabled = false;
}

export async function init() {
  await renderAll();

  // Started after the MySQL-backed panels have drawn, and not awaited, so the
  // dashboard is usable while the PBX is still being asked.
  renderAsterisk();
  qs('[data-asterisk-refresh]')?.addEventListener('click', renderAsterisk);

  // Keep the dashboard truthful when another tab changes the data.
  IvrRepo.onChange(renderAll);
  AudioRepo.onChange(renderAll);
  FlowRepo.onChange(renderRecentIvrs);
}
