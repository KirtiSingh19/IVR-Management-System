/**
 * Shared UI services.
 *
 * Anything more than one page needs and that has no domain knowledge lives
 * here: toasts, the confirmation dialog, status badges, pagination, and the
 * placeholder rows a table shows while loading or when it has nothing to show.
 *
 * Kept separate from app.js so page controllers can import these without
 * importing the shell that loads them.
 *
 * The markup these depend on (#toastHost, #confirmModal) is injected by
 * app.js from components/modals.html before any controller runs.
 */

import { qs, escapeHtml, uid } from './utils.js';

/* ==========================================================================
   Toasts
   ========================================================================== */

const TOAST_TONES = {
  ok: { className: 'toast--ok', icon: 'bi-check-circle-fill' },
  danger: { className: 'toast--danger', icon: 'bi-exclamation-octagon-fill' },
  warn: { className: 'toast--warn', icon: 'bi-exclamation-triangle-fill' },
  neutral: { className: 'toast--neutral', icon: 'bi-info-circle-fill' },
};

/**
 * Show a toast.
 *
 * Titles name the action in the past tense, so the button that says "Create
 * IVR" produces a toast that says "IVR created" and the vocabulary stays
 * consistent across the flow.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} [options.text]
 * @param {'ok'|'danger'|'warn'|'neutral'} [options.tone]
 * @param {number} [options.delay]  ms before auto-dismiss
 */
export function toast({ title, text = '', tone = 'ok', delay = 4000 }) {
  const host = qs('#toastHost');
  if (!host) {
    console.warn('[ui] no toast host on this page:', title);
    return;
  }

  const { className, icon } = TOAST_TONES[tone] ?? TOAST_TONES.neutral;
  const element = document.createElement('div');
  element.className = `toast ${className}`;
  element.id = uid('toast');
  // Errors interrupt; confirmations do not.
  element.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
  element.innerHTML = `
    <div class="toast__body">
      <i class="bi ${icon} toast__icon" aria-hidden="true"></i>
      <div class="tw-min-w-0 tw-flex-1">
        <p class="toast__title">${escapeHtml(title)}</p>
        ${text ? `<p class="toast__text">${escapeHtml(text)}</p>` : ''}
      </div>
      <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Dismiss"></button>
    </div>`;

  host.append(element);
  const instance = new window.bootstrap.Toast(element, { delay, autohide: true });
  element.addEventListener('hidden.bs.toast', () => element.remove());
  instance.show();
}

/* ==========================================================================
   Confirmation dialog
   ========================================================================== */

/**
 * Ask the user to confirm a destructive action.
 *
 * Resolves true only when the confirm button was pressed. Escape, the backdrop
 * and Cancel all resolve false, so callers can rely on `if (!ok) return`.
 *
 * Bootstrap supplies focus trapping, Escape handling and focus restoration,
 * which is why this wraps a Bootstrap modal rather than a custom element.
 *
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = 'Are you sure?',
  body = 'This action cannot be undone.',
  confirmLabel = 'Delete',
  tone = 'danger',
} = {}) {
  const element = qs('#confirmModal');
  // Fall back to the browser dialog if the shared markup is missing, so a
  // destructive action can never proceed unconfirmed.
  if (!element || !window.bootstrap) {
    return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  }

  qs('[data-confirm-title]', element).textContent = title;
  qs('[data-confirm-body]', element).textContent = body;

  const acceptButton = qs('[data-confirm-accept]', element);
  acceptButton.textContent = confirmLabel;
  acceptButton.className = `btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`;

  const iconPlate = qs('[data-confirm-icon]', element);
  iconPlate.className = `modal-icon modal-icon--${tone === 'danger' ? 'danger' : 'warn'}`;
  qs('i', iconPlate).className = `bi ${tone === 'danger' ? 'bi-trash3' : 'bi-exclamation-triangle'}`;

  const modal = window.bootstrap.Modal.getOrCreateInstance(element);

  return new Promise((resolve) => {
    let accepted = false;

    const onAccept = () => {
      accepted = true;
      modal.hide();
    };
    // Resolving on 'hidden' rather than on click means the caller's follow-up
    // work never races the modal's own teardown and focus restoration.
    const onHidden = () => {
      acceptButton.removeEventListener('click', onAccept);
      element.removeEventListener('hidden.bs.modal', onHidden);
      resolve(accepted);
    };

    acceptButton.addEventListener('click', onAccept);
    element.addEventListener('hidden.bs.modal', onHidden);
    modal.show();
  });
}

/* ==========================================================================
   Status badges
   --------------------------------------------------------------------------
   One vocabulary for the whole product. The dot is decorative; the word is
   what carries the meaning, so the badge never depends on colour alone.
   ========================================================================== */

const STATUS_TONES = {
  active: { tone: 'ok', label: 'Active' },
  inactive: { tone: 'neutral', label: 'Inactive' },
  ready: { tone: 'ok', label: 'Ready' },
  processing: { tone: 'warn', label: 'Processing' },
  error: { tone: 'danger', label: 'Error' },
};

/** @returns {string} HTML for a status badge. */
export function statusBadge(status) {
  const { tone, label } = STATUS_TONES[status] ?? { tone: 'neutral', label: status ?? 'Unknown' };
  return `<span class="status status--${tone}"><span class="status__dot" aria-hidden="true"></span>${escapeHtml(
    label,
  )}</span>`;
}

/* ==========================================================================
   Table placeholder rows
   ========================================================================== */

/** Skeleton rows shown while a repository read is in flight. */
export function tableSkeletonRows(columnCount, rowCount = 5) {
  const cells = Array.from(
    { length: columnCount },
    () => '<td><span class="skeleton skeleton--wide"></span></td>',
  ).join('');
  return Array.from({ length: rowCount }, () => `<tr>${cells}</tr>`).join('');
}

/**
 * The row a table shows when it has nothing to list.
 *
 * An empty screen is an invitation to act, so it always offers one, and the
 * message distinguishes "nothing here yet" from "nothing matched your filters".
 */
export function tableEmptyRow({ columnCount, icon, title, body, actionHtml = '' }) {
  return `
    <tr>
      <td colspan="${columnCount}">
        <div class="empty-state">
          <span class="empty-state__icon" aria-hidden="true"><i class="bi ${icon}"></i></span>
          <p class="empty-state__title">${escapeHtml(title)}</p>
          <p class="empty-state__body">${escapeHtml(body)}</p>
          ${actionHtml}
        </div>
      </td>
    </tr>`;
}

/* ==========================================================================
   Pagination
   ========================================================================== */

/**
 * Render pagination into a <ul class="pagination">.
 *
 * Long ranges are collapsed around the current page so the control never wraps
 * onto a second line. Page buttons carry data-page, which the caller reads in
 * a single delegated listener.
 *
 * @param {HTMLElement} container
 * @param {{page:number, pageCount:number}} state
 */
export function renderPagination(container, { page, pageCount }) {
  if (!container) return;

  if (pageCount <= 1) {
    container.innerHTML = '';
    return;
  }

  const item = (label, targetPage, { disabled = false, active = false, ariaLabel } = {}) => `
    <li class="page-item${disabled ? ' disabled' : ''}${active ? ' active' : ''}">
      <button
        class="page-link"
        type="button"
        data-page="${targetPage}"
        ${disabled ? 'disabled' : ''}
        ${active ? 'aria-current="page"' : ''}
        ${ariaLabel ? `aria-label="${ariaLabel}"` : ''}
      >${label}</button>
    </li>`;

  // Show first, last, current and its immediate neighbours; ellipsis the rest.
  const pages = new Set([1, pageCount, page, page - 1, page + 1]);
  const visible = [...pages].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);

  let html = item('<i class="bi bi-chevron-left"></i>', page - 1, {
    disabled: page === 1,
    ariaLabel: 'Previous page',
  });

  visible.forEach((n, index) => {
    if (index > 0 && n - visible[index - 1] > 1) {
      html += '<li class="page-item disabled"><span class="page-link">&hellip;</span></li>';
    }
    html += item(String(n), n, { active: n === page, ariaLabel: `Page ${n}` });
  });

  html += item('<i class="bi bi-chevron-right"></i>', page + 1, {
    disabled: page === pageCount,
    ariaLabel: 'Next page',
  });

  container.innerHTML = html;
}

/* ==========================================================================
   Sortable column headers
   ========================================================================== */

/**
 * Reflect the current sort onto the table head.
 * aria-sort is what assistive tech reads; the chevron is the visual echo of it.
 */
export function markSortState(table, sort, direction) {
  table.querySelectorAll('[data-sort-col]').forEach((header) => {
    const isSorted = header.dataset.sortCol === sort;
    header.setAttribute('aria-sort', isSorted ? `${direction}ending` : 'none');
    const icon = header.querySelector('i');
    if (!icon) return;
    icon.className = isSorted
      ? `bi bi-chevron-${direction === 'asc' ? 'up' : 'down'}`
      : 'bi bi-chevron-expand';
  });
}

/**
 * Next sort state for a clicked column: a new column starts ascending, the
 * current column flips direction.
 */
export function nextSort(current, clickedColumn) {
  if (current.sort !== clickedColumn) return { sort: clickedColumn, direction: 'asc' };
  return { sort: clickedColumn, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

/* ==========================================================================
   Submit buttons
   ========================================================================== */

/**
 * Put a submit button into its busy state and back.
 * Disabling on submit is what stops a double click creating two records.
 */
export function setSubmitting(button, isSubmitting) {
  if (!button) return;
  button.disabled = isSubmitting;
  button.querySelector('[data-submit-spinner]')?.classList.toggle('tw-hidden', !isSubmitting);
  button.querySelector('[data-submit-icon]')?.classList.toggle('tw-hidden', isSubmitting);
}
