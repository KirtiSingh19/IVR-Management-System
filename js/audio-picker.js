/**
 * Filling an audio <select> from the prompt library.
 *
 * Three places need this now — the IVR's welcome prompt on the create and edit
 * forms, and the per-option prompt in the menu dialog — and they all need the
 * same two behaviours: match the current value the way the database does, and
 * never silently drop a prompt that has since been deleted.
 *
 * Its own module rather than an export from js/ivr.js, because js/flow-builder.js
 * and js/menu-draft.js would then have to import js/ivr.js, which imports them
 * back.
 */

import { escapeHtml } from './utils.js';
import { AudioRepo } from './repo.js';

/**
 * Fill a select with the audio library.
 *
 * @param {HTMLSelectElement|null} select
 * @param {string} [selectedName]  file name to preselect
 * @param {Object} [options]
 * @param {string} [options.emptyLabel]  wording for the "nothing chosen" entry
 */
export async function fillAudioSelect(select, selectedName = '', { emptyLabel = 'No audio' } = {}) {
  if (!select) return;

  const files = await AudioRepo.all();

  // Compared lowercased, because the unique index on audio_files.name uses a
  // case-insensitive collation. Without this, an IVR saved against "Invalid.wav"
  // would be told its prompt is missing when the library holds "invalid.wav".
  const wanted = String(selectedName ?? '').trim().toLowerCase();

  select.innerHTML = [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...files.map(
      (file) =>
        `<option value="${escapeHtml(file.name)}"${
          file.name.toLowerCase() === wanted ? ' selected' : ''
        }>${escapeHtml(file.name)}</option>`,
    ),
  ].join('');

  // A prompt that was assigned and has since been deleted must not vanish from
  // the control, or simply opening the form and saving it would quietly clear the
  // assignment without anyone choosing to.
  if (wanted && !files.some((file) => file.name.toLowerCase() === wanted)) {
    select.insertAdjacentHTML(
      'afterbegin',
      `<option value="${escapeHtml(selectedName)}" selected>${escapeHtml(
        selectedName,
      )} (missing from the library)</option>`,
    );
  }
}
