/**
 * IVR controller.
 *
 * Serves three pages, because they operate on the same record and share the
 * same validation rules:
 *   ivr-list    the table, its filters and its row actions
 *   create-ivr  the create form
 *   edit-ivr    the edit form, the flow builder, and deletion
 *
 * init() branches on data-page and wires up only what that page needs.
 */

import {
  qs,
  qsa,
  delegate,
  debounce,
  escapeHtml,
  formatDate,
  formatDateTime,
  formatRelative,
  initials,
  getParam,
  validateName,
  validateExtension,
  validateDescription,
  runValidators,
  setFieldError,
} from './utils.js';
import { IvrRepo, FlowRepo, ValidationError, NotFoundError } from './repo.js';
import { fillAudioSelect } from './audio-picker.js';
import { syncIvrToAsterisk } from './api.js';
import {
  toast,
  confirmDialog,
  statusBadge,
  renderPagination,
  markSortState,
  nextSort,
  tableEmptyRow,
  tableSkeletonRows,
  setSubmitting,
} from './ui.js';
import { mountFlowBuilder } from './flow-builder.js';
import { mountMenuDraft, getDraftMenu, draftMenuCount } from './menu-draft.js';

const TABLE_COLUMNS = 7;

/* ==========================================================================
   Shared form pieces
   ========================================================================== */

/**
 * Fill the welcome audio picker from the prompt library.
 * "None" stays available: an IVR can legitimately go straight to its menu.
 */
function populateAudioSelect(select, selectedName = '') {
  return fillAudioSelect(select, selectedName, { emptyLabel: 'No welcome audio' });
}

/** The validation rules every IVR form runs. Written once, used by both pages. */
const IVR_VALIDATORS = {
  ivrName: validateName,
  ivrExtension: validateExtension,
  ivrDescription: validateDescription,
};

/** Read the form into the shape the repository expects. */
function readIvrForm(form) {
  return {
    name: qs('#ivrName', form).value,
    extension: qs('#ivrExtension', form).value,
    description: qs('#ivrDescription', form).value,
    welcomeAudio: qs('#ivrWelcomeAudio', form).value,
    status: qs('#ivrStatus', form).value,
  };
}

/**
 * Surface a repository ValidationError on the field that caused it.
 * Uniqueness is checked by the repository, not the form, so this is how a
 * duplicate extension gets back to the input the user typed it into.
 */
function showRepoError(form, error) {
  const fieldMap = { extension: '#ivrExtension', name: '#ivrName' };
  const field = qs(fieldMap[error.field] ?? '', form);
  if (field) {
    setFieldError(field, error.message);
    field.focus();
  } else {
    toast({ title: 'That could not be saved', text: error.message, tone: 'danger' });
  }
}

/* ==========================================================================
   IVR list
   ========================================================================== */

/** One request object. Every control writes into it, then the table redraws. */
const listState = {
  search: '',
  status: '',
  extensionPrefix: '',
  sort: 'createdAt',
  direction: 'desc',
  page: 1,
  pageSize: 10,
};

function renderIvrRow(ivr, menuCount) {
  const id = encodeURIComponent(ivr.id);
  const description = ivr.description || '—';

  return `
    <tr data-id="${escapeHtml(ivr.id)}">
      <td>
        <span class="ivr-cell">
          <span class="ivr-cell__mark" aria-hidden="true">${escapeHtml(initials(ivr.name))}</span>
          <span class="ivr-cell__body">
            <a class="ivr-cell__name" href="edit-ivr.html?id=${id}">${escapeHtml(ivr.name)}</a>
            <span class="ivr-cell__id">Updated ${escapeHtml(formatRelative(ivr.updatedAt))}</span>
          </span>
        </span>
      </td>
      <td><span class="num-ext">${escapeHtml(ivr.extension)}</span></td>
      <td class="cell-muted"><span class="cell-clamp" title="${escapeHtml(description)}">${escapeHtml(
        description,
      )}</span></td>
      <td class="cell-muted num">${menuCount}</td>
      <td>${statusBadge(ivr.status)}</td>
      <td class="cell-muted num">${escapeHtml(formatDate(ivr.createdAt))}</td>
      <td>
        <span class="row-actions">
          <button class="btn-icon" type="button" data-action="view" data-id="${escapeHtml(ivr.id)}"
            title="View ${escapeHtml(ivr.name)}" aria-label="View ${escapeHtml(ivr.name)}">
            <i class="bi bi-eye" aria-hidden="true"></i>
          </button>
          <a class="btn-icon" href="edit-ivr.html?id=${id}"
            title="Edit ${escapeHtml(ivr.name)}" aria-label="Edit ${escapeHtml(ivr.name)}">
            <i class="bi bi-pencil" aria-hidden="true"></i>
          </a>
          <a class="btn-icon" href="test-ivr.html?id=${id}"
            title="Test ${escapeHtml(ivr.name)}" aria-label="Test ${escapeHtml(ivr.name)}">
            <i class="bi bi-telephone-outbound" aria-hidden="true"></i>
          </a>
          <button class="btn-icon btn-icon--danger" type="button" data-action="delete" data-id="${escapeHtml(
            ivr.id,
          )}" title="Delete ${escapeHtml(ivr.name)}" aria-label="Delete ${escapeHtml(ivr.name)}">
            <i class="bi bi-trash3" aria-hidden="true"></i>
          </button>
        </span>
      </td>
    </tr>`;
}

/** True when any filter is narrowing the result set. */
function hasActiveFilters() {
  return Boolean(listState.search || listState.status || listState.extensionPrefix);
}

async function renderIvrTable() {
  const body = qs('#ivrTableBody');
  if (!body) return;

  body.innerHTML = tableSkeletonRows(TABLE_COLUMNS);

  const [result, menuCounts] = await Promise.all([
    IvrRepo.list(listState),
    FlowRepo.countsByIvr(),
  ]);
  listState.page = result.page; // the repository clamps out-of-range pages

  if (!result.items.length) {
    body.innerHTML = hasActiveFilters()
      ? tableEmptyRow({
          columnCount: TABLE_COLUMNS,
          icon: 'bi-search',
          title: 'No IVRs match those filters',
          body: 'Try a different search term, or clear the filters to see everything.',
          actionHtml:
            '<button class="btn btn-outline-secondary btn-sm" type="button" data-action="clear-filters">Clear filters</button>',
        })
      : tableEmptyRow({
          columnCount: TABLE_COLUMNS,
          icon: 'bi-diagram-3',
          title: 'No IVRs yet',
          body: 'Create your first IVR and it will show up here.',
          actionHtml:
            '<a class="btn btn-primary btn-sm" href="create-ivr.html"><i class="bi bi-plus-lg"></i> Create IVR</a>',
        });
  } else {
    body.innerHTML = result.items
      .map((ivr) => renderIvrRow(ivr, menuCounts[ivr.id] ?? 0))
      .join('');
  }

  // Counts and range, so the table never leaves you guessing what you are seeing.
  const count = qs('[data-result-count]');
  if (count) {
    count.textContent = hasActiveFilters()
      ? `${result.total} of ${(await IvrRepo.all()).length} IVRs`
      : `${result.total} IVR${result.total === 1 ? '' : 's'}`;
  }

  const status = qs('[data-page-status]');
  if (status) {
    const first = (result.page - 1) * result.pageSize + 1;
    const last = Math.min(result.page * result.pageSize, result.total);
    status.textContent = result.total
      ? `Showing ${first}–${last} of ${result.total}`
      : 'Nothing to show';
  }

  renderPagination(qs('#ivrPagination'), result);
  markSortState(qs('#ivrTable'), listState.sort, listState.direction);
  qs('#ivrClearFilters').hidden = !hasActiveFilters();
}

/** Build the extension-range filter from the extensions actually in use. */
async function populateExtensionFilter() {
  const select = qs('#ivrExtensionFilter');
  if (!select) return;
  const prefixes = await IvrRepo.extensionPrefixes();
  const current = select.value;
  select.innerHTML = [
    '<option value="">All extensions</option>',
    ...prefixes.map((prefix) => `<option value="${prefix}">${prefix}xx range</option>`),
  ].join('');
  select.value = current;
}

/** Open the read-only detail dialog for one IVR. */
async function openDetail(id) {
  const modalElement = qs('#ivrDetailModal');
  if (!modalElement) return;

  let ivr;
  try {
    ivr = await IvrRepo.get(id);
  } catch (error) {
    toast({ title: 'IVR not found', text: error.message, tone: 'danger' });
    await renderIvrTable();
    return;
  }

  const options = await FlowRepo.list(id);
  const encodedId = encodeURIComponent(ivr.id);

  qs('#ivrDetailTitle', modalElement).textContent = ivr.name;
  qs('[data-detail-edit]', modalElement).href = `edit-ivr.html?id=${encodedId}`;
  qs('[data-detail-test]', modalElement).href = `test-ivr.html?id=${encodedId}`;

  qs('[data-detail-body]', modalElement).innerHTML = `
    <dl class="detail-list">
      <dt>Extension</dt>
      <dd><span class="num-ext">${escapeHtml(ivr.extension)}</span></dd>

      <dt>Status</dt>
      <dd>${statusBadge(ivr.status)}</dd>

      <dt>Description</dt>
      <dd>${escapeHtml(ivr.description || '—')}</dd>

      <dt>Welcome audio</dt>
      <dd class="num">${escapeHtml(ivr.welcomeAudio || 'None')}</dd>

      <dt>Created</dt>
      <dd>${escapeHtml(formatDateTime(ivr.createdAt))}</dd>

      <dt>Last updated</dt>
      <dd>${escapeHtml(formatDateTime(ivr.updatedAt))}</dd>
    </dl>

    <h3 class="tw-mt-6 tw-mb-3 tw-text-sm tw-font-semibold">
      Menu options
      <span class="tw-font-normal tw-text-muted">(${options.length})</span>
    </h3>
    ${
      options.length
        ? `<ul class="flow-list">${options
            .map(
              (option) => `
                <li class="flow-row">
                  <span class="flow-row__digit" aria-hidden="true">${escapeHtml(option.digit)}</span>
                  <span class="flow-row__body">
                    <span class="flow-row__label">${escapeHtml(option.label)}</span>
                    <span class="flow-row__dest">
                      <i class="bi bi-arrow-return-right" aria-hidden="true"></i>
                      Extension <span class="num">${escapeHtml(option.destination)}</span>
                    </span>
                  </span>
                </li>`,
            )
            .join('')}</ul>`
        : `<p class="tw-mb-0 tw-text-sm tw-text-muted">
             No menu options yet. Add them on the edit screen so callers have something to choose.
           </p>`
    }`;

  window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
}

/** Confirm and delete, from either the list or the edit page. */
async function deleteIvr(id, { afterDelete } = {}) {
  let ivr;
  try {
    ivr = await IvrRepo.get(id);
  } catch {
    toast({ title: 'Already deleted', text: 'That IVR no longer exists.', tone: 'warn' });
    return false;
  }

  const optionCount = (await FlowRepo.list(id)).length;
  const confirmed = await confirmDialog({
    title: `Delete ${ivr.name}?`,
    body: optionCount
      ? `Extension ${ivr.extension} and ${optionCount} menu option${
          optionCount === 1 ? '' : 's'
        } will be removed. This cannot be undone.`
      : `Extension ${ivr.extension} will be removed. This cannot be undone.`,
    confirmLabel: 'Delete IVR',
    tone: 'danger',
  });
  if (!confirmed) return false;

  try {
    await IvrRepo.remove(id);
  } catch (error) {
    toast({ title: 'That could not be deleted', text: error.message, tone: 'danger' });
    return false;
  }

  toast({ title: 'IVR deleted', text: `${ivr.name} has been removed.`, tone: 'ok' });
  await afterDelete?.();
  return true;
}

async function initList() {
  await populateExtensionFilter();

  // Arriving from the global search box carries the term through.
  const initialSearch = getParam('search');
  if (initialSearch) {
    listState.search = initialSearch;
    qs('#ivrSearch').value = initialSearch;
  }

  await renderIvrTable();

  const applyAndRender = () => {
    listState.page = 1; // a changed filter always returns to the first page
    renderIvrTable();
  };

  qs('#ivrSearch').addEventListener(
    'input',
    debounce((event) => {
      listState.search = event.target.value;
      applyAndRender();
    }, 220),
  );

  qs('#ivrStatusFilter').addEventListener('change', (event) => {
    listState.status = event.target.value;
    applyAndRender();
  });

  qs('#ivrExtensionFilter').addEventListener('change', (event) => {
    listState.extensionPrefix = event.target.value;
    applyAndRender();
  });

  const clearFilters = () => {
    listState.search = '';
    listState.status = '';
    listState.extensionPrefix = '';
    qs('#ivrSearch').value = '';
    qs('#ivrStatusFilter').value = '';
    qs('#ivrExtensionFilter').value = '';
    applyAndRender();
  };
  qs('#ivrClearFilters').addEventListener('click', clearFilters);

  // Sorting
  delegate(qs('#ivrTable'), 'click', '[data-sort]', (_event, button) => {
    Object.assign(listState, nextSort(listState, button.dataset.sort));
    listState.page = 1;
    renderIvrTable();
  });

  // Pagination
  delegate(qs('#ivrPagination'), 'click', '[data-page]', (_event, button) => {
    listState.page = Number(button.dataset.page);
    renderIvrTable();
    qs('#ivrTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Row actions and the empty-state button. Bound once to the table body, so
  // they keep working across every redraw.
  delegate(qs('#ivrTableBody'), 'click', '[data-action]', async (_event, button) => {
    const { action, id } = button.dataset;
    if (action === 'view') await openDetail(id);
    else if (action === 'delete') await deleteIvr(id, { afterDelete: renderIvrTable });
    else if (action === 'clear-filters') clearFilters();
  });

  // Another tab changed the data.
  IvrRepo.onChange(async () => {
    await populateExtensionFilter();
    await renderIvrTable();
  });
}

/* ==========================================================================
   Create IVR
   ========================================================================== */

async function initCreate() {
  const form = qs('#ivrForm');
  await populateAudioSelect(qs('#ivrWelcomeAudio', form), '');

  // The menu is built in memory and sent with the IVR, so both are written in one
  // transaction on the server rather than the IVR existing for a moment without
  // the options that were meant to come with it.
  const submitButton = qs('[data-submit]', form);
  const submitLabel = qs('[data-submit-label]', submitButton);

  const describeSubmit = () => {
    if (!submitLabel) return;
    const count = draftMenuCount();
    submitLabel.textContent = count
      ? `Create IVR with ${count} option${count === 1 ? '' : 's'}`
      : 'Create IVR';
  };

  mountMenuDraft({ container: qs('[data-draft-flow-list]', form), onChange: describeSubmit });

  // Validate a field once the user has left it, not while they are still typing.
  qsa('#ivrName, #ivrExtension, #ivrDescription', form).forEach((field) => {
    field.addEventListener('blur', () => {
      setFieldError(field, IVR_VALIDATORS[field.id](field.value));
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!runValidators(form, IVR_VALIDATORS)) return;

    setSubmitting(submitButton, true);

    const menu = getDraftMenu();

    try {
      const ivr = await IvrRepo.create({ ...readIvrForm(form), menu });
      toast({
        title: 'IVR created',
        text: menu.length
          ? `${ivr.name} is on extension ${ivr.extension} with ${menu.length} menu option${
              menu.length === 1 ? '' : 's'
            }.`
          : `${ivr.name} is on extension ${ivr.extension}. Add its menu options next.`,
        tone: 'ok',
      });
      // On to the edit screen, where the menu can be refined.
      window.location.href = `edit-ivr.html?id=${encodeURIComponent(ivr.id)}&created=1`;
    } catch (error) {
      setSubmitting(submitButton, false);
      // The draft menu is untouched by a failure, so a rejected extension can be
      // corrected and resubmitted without the options being typed again.
      if (error instanceof ValidationError) showRepoError(form, error);
      else {
        console.error('[ivr] create failed', error);
        toast({ title: 'That could not be saved', text: error.message, tone: 'danger' });
      }
    }
  });
}

/* ==========================================================================
   Sync to Asterisk
   ========================================================================== */

/**
 * Push this IVR into the Asterisk dialplan.
 *
 * Reads from MySQL server-side, so the button syncs what is *saved*, not what is
 * currently typed into the form. Unsaved edits are therefore not pushed — which
 * is the safe way round: the dialplan should only ever reflect a record that
 * survived validation and was written to the database.
 */
function wireSyncButton(ivr) {
  const button = qs('[data-sync-asterisk]');
  const state = qs('[data-sync-state]');
  if (!button) return;

  const show = (text, tone) => {
    if (!state) return;
    state.hidden = !text;
    state.textContent = text;
    state.className = `sync-state${tone ? ` sync-state--${tone}` : ''}`;
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    show('Syncing…', 'busy');

    const result = await syncIvrToAsterisk(ivr.id);

    if (!result.success) {
      show('✗ Sync failed', 'danger');
      toast({
        title: 'Sync failed',
        text: result.message || 'Asterisk could not be updated.',
        tone: 'danger',
        delay: 9000,
      });
      button.disabled = false;
      return;
    }

    show('✓ Synced successfully', 'ok');

    // Sounds live on the web server; Asterisk plays from its own directory and
    // AMI cannot copy between them. Saying so is the difference between a prompt
    // that is silent for a known reason and one that is mysteriously silent.
    const notes = [...(result.warnings ?? [])];
    if (result.unverified_sounds?.length) {
      notes.push(
        `Copy these prompts to Asterisk if they are not there already: ${result.unverified_sounds.join(', ')}.`,
      );
    }

    toast({
      title: result.message,
      text: notes.join(' ') || 'The dialplan was written and reloaded.',
      tone: notes.length ? 'warn' : 'ok',
      delay: notes.length ? 9000 : 5000,
    });
    button.disabled = false;
  });
}

/* ==========================================================================
   Edit IVR
   ========================================================================== */

async function initEdit() {
  const id = getParam('id');
  const notFound = qs('[data-not-found]');
  const body = qs('[data-edit-body]');

  let ivr;
  try {
    if (!id) throw new NotFoundError();
    ivr = await IvrRepo.get(id);
  } catch {
    notFound.hidden = false;
    return;
  }

  body.hidden = false;
  qs('[data-edit-actions]').hidden = false;

  // Header and links now that the record is known.
  document.title = `Edit ${ivr.name} · IVR Manager`;
  qs('[data-crumb-name]').textContent = ivr.name;
  qs('[data-edit-title]').textContent = ivr.name;
  qs('[data-edit-subtitle]').textContent =
    `Extension ${ivr.extension}. Change the details, or build the menu callers hear.`;
  qsa('[data-test-link]').forEach((link) => {
    link.href = `test-ivr.html?id=${encodeURIComponent(ivr.id)}`;
  });

  // Fill the form.
  const form = qs('#ivrForm');
  qs('#ivrName', form).value = ivr.name;
  qs('#ivrExtension', form).value = ivr.extension;
  qs('#ivrDescription', form).value = ivr.description;
  qs('#ivrStatus', form).value = ivr.status;
  await populateAudioSelect(qs('#ivrWelcomeAudio', form), ivr.welcomeAudio);

  const lastSaved = qs('[data-last-saved]');
  const showLastSaved = (iso) => {
    lastSaved.textContent = `Last saved ${formatRelative(iso)}`;
  };
  showLastSaved(ivr.updatedAt);

  qsa('#ivrName, #ivrExtension, #ivrDescription', form).forEach((field) => {
    field.addEventListener('blur', () => {
      setFieldError(field, IVR_VALIDATORS[field.id](field.value));
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!runValidators(form, IVR_VALIDATORS)) return;

    const submitButton = qs('[data-submit]', form);
    setSubmitting(submitButton, true);

    try {
      const updated = await IvrRepo.update(ivr.id, readIvrForm(form));
      ivr = updated;
      showLastSaved(updated.updatedAt);
      qs('[data-crumb-name]').textContent = updated.name;
      qs('[data-edit-title]').textContent = updated.name;
      toast({ title: 'Changes saved', text: `${updated.name} has been updated.`, tone: 'ok' });
    } catch (error) {
      if (error instanceof ValidationError) showRepoError(form, error);
      else {
        console.error('[ivr] update failed', error);
        toast({ title: 'That could not be saved', text: error.message, tone: 'danger' });
      }
    } finally {
      setSubmitting(submitButton, false);
    }
  });

  wireSyncButton(ivr);

  qs('[data-delete-ivr]').addEventListener('click', async () => {
    const deleted = await deleteIvr(ivr.id, {
      afterDelete: async () => {
        // Let the toast land before leaving the page.
        setTimeout(() => {
          window.location.href = 'ivr-list.html';
        }, 700);
      },
    });
    if (!deleted) return;
  });

  // The menu builder is its own module; it owns everything inside this card.
  await mountFlowBuilder({ ivrId: ivr.id, container: qs('[data-flow-list]') });

  // Landed here straight after creating the IVR.
  if (getParam('created')) {
    toast({
      title: 'Now build the menu',
      text: 'Add one option for each key you want callers to be able to press.',
      tone: 'neutral',
      delay: 6000,
    });
  }
}

/* ==========================================================================
   Init
   ========================================================================== */

export async function init() {
  switch (document.body.dataset.page) {
    case 'ivr-list':
      return initList();
    case 'create-ivr':
      return initCreate();
    case 'edit-ivr':
      return initEdit();
    default:
      return undefined;
  }
}
