/**
 * Flow builder — the menu attached to one IVR.
 *
 * One row per key the caller can press: the digit, what the option is called,
 * and the extension the call is handed to. Mounted into the edit page by
 * js/ivr.js; the Test IVR page reads the same records back out, so a change
 * here is audible on the next simulated call.
 *
 * The single business rule is that a digit can only mean one thing, since a
 * caller can only press one key. It is enforced in the repository, and this
 * module also greys out taken digits so the collision is usually avoided.
 */

import { qs, qsa, delegate, escapeHtml, validateDigit, validateLabel, validateExtension, runValidators, clearFormErrors, setFieldError } from './utils.js';
import { FlowRepo, ValidationError } from './repo.js';
import { fillAudioSelect } from './audio-picker.js';
import { toast, confirmDialog } from './ui.js';

/** Which IVR the mounted builder belongs to, and where it draws. */
let currentIvrId = null;
let listContainer = null;

/** null while adding, the option id while editing. */
let editingOptionId = null;

/** Guards against binding the shared modal's listeners more than once. */
let modalWired = false;

/* ==========================================================================
   Rendering
   ========================================================================== */

/**
 * One row of the menu.
 *
 * Exported so the draft builder on the create page draws its rows from this
 * exact function rather than from a copy of the markup. Two templates for the
 * same thing would drift the moment either screen changed.
 */
export function renderOptionRow(option) {
  return `
    <li class="flow-row" data-option-id="${escapeHtml(option.id)}">
      <span class="flow-row__digit" aria-hidden="true">${escapeHtml(option.digit)}</span>
      <span class="flow-row__body">
        <span class="flow-row__label">${escapeHtml(option.label)}</span>
        <span class="flow-row__dest">
          <i class="bi bi-arrow-return-right" aria-hidden="true"></i>
          Extension <span class="num">${escapeHtml(option.destination)}</span>
          ${
            option.audioFile
              ? `<span class="flow-row__audio"><i class="bi bi-music-note-beamed" aria-hidden="true"></i>${escapeHtml(
                  option.audioFile,
                )}</span>`
              : ''
          }
        </span>
      </span>
      <span class="flow-row__actions">
        <button class="btn-icon" type="button" data-option-action="edit"
          title="Edit option ${escapeHtml(option.digit)}"
          aria-label="Edit option ${escapeHtml(option.digit)}, ${escapeHtml(option.label)}">
          <i class="bi bi-pencil" aria-hidden="true"></i>
        </button>
        <button class="btn-icon btn-icon--danger" type="button" data-option-action="delete"
          title="Delete option ${escapeHtml(option.digit)}"
          aria-label="Delete option ${escapeHtml(option.digit)}, ${escapeHtml(option.label)}">
          <i class="bi bi-trash3" aria-hidden="true"></i>
        </button>
      </span>
    </li>`;
}

async function renderOptions() {
  const options = await FlowRepo.list(currentIvrId);

  if (!options.length) {
    listContainer.innerHTML = `
      <div class="empty-state tw-py-8">
        <span class="empty-state__icon" aria-hidden="true"><i class="bi bi-list-ol"></i></span>
        <p class="empty-state__title">This menu is empty</p>
        <p class="empty-state__body">
          Callers will hear the welcome prompt and nothing else. Add an option to give them
          somewhere to go.
        </p>
        <button class="btn btn-primary btn-sm" type="button" data-add-option>
          <i class="bi bi-plus-lg" aria-hidden="true"></i>
          Add option
        </button>
      </div>`;
    return;
  }

  listContainer.innerHTML = `<ul class="flow-list">${options.map(renderOptionRow).join('')}</ul>`;
}

/* ==========================================================================
   The add / edit dialog
   ========================================================================== */

/**
 * Disable digits already spoken for, so the usual collision never happens.
 * The repository still checks, because another tab could take a digit while
 * this dialog is open.
 */
async function markTakenDigits(currentDigit) {
  const options = await FlowRepo.list(currentIvrId);
  const taken = new Set(
    options.filter((option) => option.id !== editingOptionId).map((option) => option.digit),
  );

  qsa('#optionDigit option').forEach((choice) => {
    const isTaken = taken.has(choice.value);
    choice.disabled = isTaken;
    choice.textContent = isTaken ? `${choice.value} — already used` : choice.value;
  });

  // Prefer the option being edited, otherwise the first free digit.
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
  await markTakenDigits(option?.digit ?? null);

  const modal = window.bootstrap.Modal.getOrCreateInstance(modalElement);
  // Focus the first field the user actually types into.
  modalElement.addEventListener('shown.bs.modal', () => qs('#optionLabel').focus(), { once: true });
  modal.show();
}

const OPTION_VALIDATORS = {
  optionDigit: validateDigit,
  optionLabel: validateLabel,
  // A destination is an extension, so it obeys the same rule as an IVR's own.
  optionDestination: validateExtension,
};

async function submitOptionForm(event) {
  event.preventDefault();
  const form = qs('#optionForm');
  if (!runValidators(form, OPTION_VALIDATORS)) return;

  const input = {
    digit: qs('#optionDigit').value,
    label: qs('#optionLabel').value,
    destination: qs('#optionDestination').value,
    audioFile: qs('#optionAudio').value,
  };

  try {
    if (editingOptionId) {
      const updated = await FlowRepo.update(currentIvrId, editingOptionId, input);
      toast({
        title: 'Option saved',
        text: `Pressing ${updated.digit} now goes to ${updated.label}.`,
        tone: 'ok',
      });
    } else {
      const created = await FlowRepo.create(currentIvrId, input);
      toast({
        title: 'Option added',
        text: `Pressing ${created.digit} goes to ${created.label} on ${created.destination}.`,
        tone: 'ok',
      });
    }
    window.bootstrap.Modal.getOrCreateInstance(qs('#optionModal')).hide();
    await renderOptions();
  } catch (error) {
    if (error instanceof ValidationError) {
      // Digit collisions land back on the digit field.
      setFieldError(qs('#optionDigit'), error.message);
      return;
    }
    console.error('[flow-builder] could not save the option', error);
    toast({ title: 'That could not be saved', text: error.message, tone: 'danger' });
  }
}

/* ==========================================================================
   Actions
   ========================================================================== */

async function editOption(optionId) {
  const options = await FlowRepo.list(currentIvrId);
  const option = options.find((candidate) => candidate.id === optionId);
  if (!option) {
    toast({ title: 'Already removed', text: 'That option no longer exists.', tone: 'warn' });
    await renderOptions();
    return;
  }
  await openOptionDialog(option);
}

async function deleteOption(optionId) {
  const options = await FlowRepo.list(currentIvrId);
  const option = options.find((candidate) => candidate.id === optionId);
  if (!option) return;

  const confirmed = await confirmDialog({
    title: `Delete option ${option.digit}?`,
    body: `Callers pressing ${option.digit} will hear the invalid-option prompt instead of reaching ${option.label}.`,
    confirmLabel: 'Delete option',
    tone: 'danger',
  });
  if (!confirmed) return;

  try {
    await FlowRepo.remove(currentIvrId, optionId);
    toast({ title: 'Option deleted', text: `Digit ${option.digit} is free again.`, tone: 'ok' });
    await renderOptions();
  } catch (error) {
    toast({ title: 'That could not be deleted', text: error.message, tone: 'danger' });
  }
}

/* ==========================================================================
   Mount
   ========================================================================== */

/**
 * Mount the builder for one IVR.
 * @param {Object} options
 * @param {string} options.ivrId
 * @param {HTMLElement} options.container  where the option list is drawn
 */
export async function mountFlowBuilder({ ivrId, container }) {
  if (!container) return;
  currentIvrId = ivrId;
  listContainer = container;

  await renderOptions();

  if (!modalWired) {
    modalWired = true;
    qs('#optionForm')?.addEventListener('submit', submitOptionForm);
  }

  // "Add option" appears in the card header and again in the empty state, so
  // the listener is delegated from the document rather than bound to a button.
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-add-option]')) openOptionDialog(null);
  });

  delegate(container, 'click', '[data-option-action]', async (_event, button) => {
    const optionId = button.closest('[data-option-id]')?.dataset.optionId;
    if (!optionId) return;
    if (button.dataset.optionAction === 'edit') await editOption(optionId);
    else await deleteOption(optionId);
  });

  // Another tab edited this menu.
  FlowRepo.onChange(renderOptions);
}
