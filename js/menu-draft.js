/**
 * The menu builder for an IVR that does not exist yet.
 *
 * The create page has no IVR id, so there is nothing for menu options to belong
 * to and nowhere to save them. They are collected here in memory and handed to
 * js/ivr.js, which sends them nested inside the create request — so the IVR and
 * its whole menu are written in a single transaction on the server. Either both
 * land or neither does; a rejected menu never leaves a half-made IVR behind.
 *
 * Deliberately a sibling of js/flow-builder.js rather than a mode inside it. The
 * two look identical to the user and share their row markup, their modal, their
 * validators and their CSS, but their storage models are genuinely different —
 * the flow builder persists every edit immediately against a known id, this one
 * cannot persist anything at all. Folding them together would mean threading a
 * "do not save" flag through the code that runs on the working edit page.
 */

import {
  qs,
  qsa,
  delegate,
  uid,
  validateDigit,
  validateLabel,
  validateExtension,
  runValidators,
  clearFormErrors,
  setFieldError,
} from './utils.js';
import { renderOptionRow } from './flow-builder.js';
import { fillAudioSelect } from './audio-picker.js';
import { toast } from './ui.js';

/** The draft menu, in the order it was built. Sorted by digit for display. */
let draftOptions = [];

/** Where the list is drawn. */
let listContainer = null;

/** null while adding, the draft option's id while editing. */
let editingOptionId = null;

/** Told after every change, so the page can restate how many options are queued. */
let notifyChanged = null;

let wired = false;

/* ==========================================================================
   Rendering
   ========================================================================== */

/** Ordered by digit, so the list reads in the order a caller hears it. */
function sortedOptions() {
  return [...draftOptions].sort((a, b) =>
    a.digit.localeCompare(b.digit, undefined, { numeric: true }),
  );
}

function renderOptions() {
  if (!listContainer) return;
  try {
    drawList();
  } finally {
    // Runs even if drawing threw, so the count on the submit button can never be
    // left disagreeing with the menu that is actually held.
    notifyChanged?.();
  }
}

function drawList() {
  if (!draftOptions.length) {
    listContainer.innerHTML = `
      <div class="empty-state tw-py-8">
        <span class="empty-state__icon" aria-hidden="true"><i class="bi bi-list-ol"></i></span>
        <p class="empty-state__title">No menu options yet</p>
        <p class="empty-state__body">
          Callers will hear the welcome prompt and nothing else. Add an option to give them
          somewhere to go — or create the IVR now and build its menu afterwards.
        </p>
        <button class="btn btn-primary btn-sm" type="button" data-add-option>
          <i class="bi bi-plus-lg" aria-hidden="true"></i>
          Add option
        </button>
      </div>`;
    return;
  }

  listContainer.innerHTML = `<ul class="flow-list">${sortedOptions()
    .map(renderOptionRow)
    .join('')}</ul>`;
}

/* ==========================================================================
   The add / edit dialog
   ========================================================================== */

/**
 * Disable digits already spoken for.
 *
 * Nothing else can take a digit while this dialog is open — the draft lives in
 * this tab and has not been sent anywhere — so unlike the flow builder, this is
 * the whole guarantee rather than a convenience on top of a server check. The
 * server validates the menu again on create regardless.
 */
function markTakenDigits(currentDigit) {
  const taken = new Set(
    draftOptions.filter((option) => option.id !== editingOptionId).map((option) => option.digit),
  );

  qsa('#optionDigit option').forEach((choice) => {
    const isTaken = taken.has(choice.value);
    choice.disabled = isTaken;
    choice.textContent = isTaken ? `${choice.value} — already used` : choice.value;
  });

  const firstFree = qs('#optionDigit option:not([disabled])');
  qs('#optionDigit').value = currentDigit ?? firstFree?.value ?? '';
}

async function openOptionDialog(option = null) {
  const modalElement = qs('#optionModal');
  if (!modalElement) return;

  editingOptionId = option?.id ?? null;
  const form = qs('#optionForm');
  clearFormErrors(form);

  qs('#optionModalTitle').textContent = option ? 'Edit menu option' : 'Add menu option';
  qs('[data-option-submit]').textContent = option ? 'Save option' : 'Add option';
  qs('#optionLabel').value = option?.label ?? '';
  qs('#optionDestination').value = option?.destination ?? '';
  await fillAudioSelect(qs('#optionAudio'), option?.audioFile ?? '', {
    emptyLabel: 'No audio — transfer silently',
  });
  markTakenDigits(option?.digit ?? null);

  const modal = window.bootstrap.Modal.getOrCreateInstance(modalElement);
  modalElement.addEventListener('shown.bs.modal', () => qs('#optionLabel').focus(), { once: true });
  modal.show();
}

/** The same three rules the flow builder uses, imported rather than restated. */
const OPTION_VALIDATORS = {
  optionDigit: validateDigit,
  optionLabel: validateLabel,
  optionDestination: validateExtension,
};

function submitOptionForm(event) {
  event.preventDefault();
  const form = qs('#optionForm');
  if (!runValidators(form, OPTION_VALIDATORS)) return;

  const digit = qs('#optionDigit').value.trim();
  const label = qs('#optionLabel').value.trim();
  const destination = qs('#optionDestination').value.trim();
  const audioFile = qs('#optionAudio').value.trim();

  // The digit select disables what is taken, but a keyboard user can still
  // submit a stale form, so the rule is enforced here too rather than trusted.
  const clash = draftOptions.find(
    (option) => option.digit === digit && option.id !== editingOptionId,
  );
  if (clash) {
    setFieldError(qs('#optionDigit'), `Digit ${digit} is already assigned to ${clash.label}.`);
    return;
  }

  if (editingOptionId) {
    draftOptions = draftOptions.map((option) =>
      option.id === editingOptionId ? { ...option, digit, label, destination, audioFile } : option,
    );
    toast({ title: 'Option updated', text: `Pressing ${digit} goes to ${label}.`, tone: 'ok' });
  } else {
    // The id is local and temporary. MySQL assigns the real one when the IVR is
    // created; nothing here is allowed to outlive this page.
    draftOptions.push({ id: uid('draft'), digit, label, destination, audioFile });
    toast({ title: 'Option added', text: `Pressing ${digit} goes to ${label}.`, tone: 'ok' });
  }

  window.bootstrap.Modal.getOrCreateInstance(qs('#optionModal')).hide();
  renderOptions();
}

/* ==========================================================================
   Actions
   ========================================================================== */

function editOption(optionId) {
  const option = draftOptions.find((candidate) => candidate.id === optionId);
  if (option) openOptionDialog(option);
}

/**
 * Remove an option.
 *
 * No confirmation dialog, unlike the flow builder. Nothing has been saved yet —
 * this discards something typed seconds ago, not a live menu a caller is
 * reaching — and a modal to confirm undoing an unsaved draft is friction for its
 * own sake.
 */
function removeOption(optionId) {
  const option = draftOptions.find((candidate) => candidate.id === optionId);
  if (!option) return;
  draftOptions = draftOptions.filter((candidate) => candidate.id !== optionId);
  toast({ title: 'Option removed', text: `Digit ${option.digit} is free again.`, tone: 'ok' });
  renderOptions();
}

/* ==========================================================================
   Mount
   ========================================================================== */

/**
 * The draft menu, in the shape IvrRepo.create() expects.
 * Sorted so the rows are inserted in menu order.
 */
export function getDraftMenu() {
  return sortedOptions().map(({ digit, label, destination, audioFile }) => ({
    digit,
    label,
    destination,
    audioFile: audioFile ?? '',
    destinationType: 'extension',
  }));
}

/** How many options are queued. Used for the submit button's wording. */
export function draftMenuCount() {
  return draftOptions.length;
}

/**
 * Mount the draft builder.
 * @param {Object} options
 * @param {HTMLElement} options.container  where the option list is drawn
 * @param {() => void} [options.onChange]  called after the menu changes
 */
export function mountMenuDraft({ container, onChange }) {
  if (!container) return;
  listContainer = container;
  draftOptions = [];
  notifyChanged = onChange ?? null;

  renderOptions();

  if (!wired) {
    wired = true;
    qs('#optionForm')?.addEventListener('submit', submitOptionForm);

    // "Add option" appears in the card header and again in the empty state, so
    // the listener is delegated from the document rather than bound to a button.
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-add-option]')) openOptionDialog(null);
    });
  }

  delegate(container, 'click', '[data-option-action]', (_event, button) => {
    const optionId = button.closest('[data-option-id]')?.dataset.optionId;
    if (!optionId) return;
    if (button.dataset.optionAction === 'edit') editOption(optionId);
    else removeOption(optionId);
  });
}
