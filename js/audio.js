/**
 * Audio files controller.
 *
 * Owns the prompt library table, the upload control, and playback.
 *
 * Playback uses a single HTML5 Audio element for the whole page. Only one
 * prompt can sound at a time — which is also true of a real phone line — so
 * starting one file stops whatever was playing, and there is one set of
 * transport controls rather than a pair on every row.
 */

import {
  qs,
  qsa,
  delegate,
  debounce,
  escapeHtml,
  formatBytes,
  formatDate,
  formatDuration,
  getParam,
} from './utils.js';
import { AudioRepo, ValidationError } from './repo.js';
import {
  toast,
  confirmDialog,
  statusBadge,
  renderPagination,
  markSortState,
  nextSort,
  tableEmptyRow,
  tableSkeletonRows,
} from './ui.js';

const TABLE_COLUMNS = 6;

/** One request object, exactly as on the IVR list. */
const listState = {
  search: '',
  format: '',
  sort: 'createdAt',
  direction: 'desc',
  page: 1,
  pageSize: 8,
};

/* ==========================================================================
   Playback
   ========================================================================== */

/** The page's only Audio element. */
const player = new Audio();
player.preload = 'metadata';

/** Id of the file currently loaded into the player, or null. */
let playingId = null;

function playerElements() {
  return {
    bar: qs('#audioPlayer'),
    toggle: qs('[data-player-toggle]'),
    stop: qs('[data-player-stop]'),
    name: qs('[data-player-name]'),
    track: qs('[data-player-track]'),
    progress: qs('[data-player-progress]'),
    time: qs('[data-player-time]'),
  };
}

/** Reflect the player state onto the bar and the row that is sounding. */
function paintPlayerState() {
  const { bar, toggle, track, progress, time } = playerElements();
  if (!bar) return;

  const isPaused = player.paused;

  // Row state is repainted first and unconditionally. Doing it after the
  // early return below would mean stopping playback hid the bar but left the
  // previous row still marked as playing.
  qsa('#audioTableBody tr').forEach((row) => {
    const isPlaying = playingId !== null && row.dataset.id === playingId;
    row.classList.toggle('is-playing', isPlaying);
    const button = qs('[data-action="play"]', row);
    if (!button) return;
    qs('i', button).className = `bi ${isPlaying && !isPaused ? 'bi-pause-fill' : 'bi-play-fill'}`;
    button.setAttribute(
      'aria-label',
      `${isPlaying && !isPaused ? 'Pause' : 'Play'} ${row.dataset.name}`,
    );
  });

  bar.hidden = playingId === null;
  if (playingId === null) return;

  toggle.setAttribute('aria-label', isPaused ? 'Resume' : 'Pause');
  qs('i', toggle).className = `bi ${isPaused ? 'bi-play-fill' : 'bi-pause-fill'}`;

  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const share = duration ? (player.currentTime / duration) * 100 : 0;
  progress.style.width = `${share}%`;
  track.setAttribute('aria-valuenow', String(Math.round(share)));
  time.textContent = `${formatDuration(player.currentTime)} / ${formatDuration(duration)}`;
}

/** Stop playback and release the row highlight. */
function stopPlayback() {
  player.pause();
  player.currentTime = 0;
  playingId = null;
  paintPlayerState();
}

/**
 * Start, pause or resume a file.
 * Uploaded files whose session URL has been lost report that plainly instead
 * of failing silently.
 */
async function togglePlay(id) {
  let file;
  try {
    file = await AudioRepo.get(id);
  } catch {
    stopPlayback();
    await renderAudioTable();
    return;
  }

  // Same file: pause or resume rather than restart it.
  if (playingId === id) {
    if (player.paused) await player.play().catch(() => {});
    else player.pause();
    paintPlayerState();
    return;
  }

  const source = AudioRepo.sourceFor(file);
  if (!source) {
    // Only reachable when the row is in the database but the file has gone from
    // the server's audio directory — deleted by hand, or a failed upload.
    toast({
      title: 'That audio is missing',
      text: `${file.name} is in the library but its file is not on the server. Upload it again to replace it.`,
      tone: 'warn',
      delay: 6000,
    });
    return;
  }

  player.src = source;
  playingId = id;
  qs('[data-player-name]').textContent = file.name;

  try {
    await player.play();
  } catch (error) {
    console.error('[audio] playback failed', error);
    playingId = null;
    toast({ title: 'That file could not be played', text: file.name, tone: 'danger' });
  }
  paintPlayerState();
}

function wirePlayer() {
  const { toggle, stop, track } = playerElements();

  player.addEventListener('timeupdate', paintPlayerState);
  player.addEventListener('play', paintPlayerState);
  player.addEventListener('pause', paintPlayerState);
  player.addEventListener('ended', stopPlayback);

  toggle.addEventListener('click', () => playingId && togglePlay(playingId));
  stop.addEventListener('click', stopPlayback);

  // Click anywhere on the track to seek.
  track.addEventListener('click', (event) => {
    if (!playingId || !Number.isFinite(player.duration)) return;
    const bounds = track.getBoundingClientRect();
    player.currentTime = ((event.clientX - bounds.left) / bounds.width) * player.duration;
    paintPlayerState();
  });
}

/* ==========================================================================
   Table
   ========================================================================== */

function renderAudioRow(file) {
  const missingSource = AudioRepo.isSourceMissing(file);

  return `
    <tr data-id="${escapeHtml(file.id)}" data-name="${escapeHtml(file.name)}">
      <td>
        <span class="file-cell">
          <span class="file-cell__icon" aria-hidden="true"><i class="bi bi-file-earmark-music"></i></span>
          <span class="tw-min-w-0">
            <span class="file-cell__name">${escapeHtml(file.name)}</span>
            <span class="file-cell__meta">${
              missingSource
                ? '<span class="session-note"><i class="bi bi-exclamation-triangle"></i>Missing from the server</span>'
                : file.seeded
                  ? 'Shipped with the app'
                  : `Uploaded ${escapeHtml(formatDate(file.createdAt))}`
            }</span>
          </span>
        </span>
      </td>
      <td><span class="format-chip">${escapeHtml(file.format)}</span></td>
      <td class="num cell-muted">${formatDuration(file.durationSeconds)}</td>
      <td class="num cell-muted">${formatBytes(file.sizeBytes)}</td>
      <td>${statusBadge(file.status)}</td>
      <td>
        <span class="row-actions">
          <button class="btn-icon" type="button" data-action="play" data-id="${escapeHtml(file.id)}"
            title="Play ${escapeHtml(file.name)}" aria-label="Play ${escapeHtml(file.name)}"
            ${missingSource ? 'disabled' : ''}>
            <i class="bi bi-play-fill" aria-hidden="true"></i>
          </button>
          <button class="btn-icon" type="button" data-action="stop" data-id="${escapeHtml(file.id)}"
            title="Stop playback" aria-label="Stop playing ${escapeHtml(file.name)}">
            <i class="bi bi-stop-fill" aria-hidden="true"></i>
          </button>
          <button class="btn-icon btn-icon--danger" type="button" data-action="delete" data-id="${escapeHtml(
            file.id,
          )}" title="Delete ${escapeHtml(file.name)}" aria-label="Delete ${escapeHtml(file.name)}">
            <i class="bi bi-trash3" aria-hidden="true"></i>
          </button>
        </span>
      </td>
    </tr>`;
}

function hasActiveFilters() {
  return Boolean(listState.search || listState.format);
}

async function renderAudioTable() {
  const body = qs('#audioTableBody');
  if (!body) return;

  body.innerHTML = tableSkeletonRows(TABLE_COLUMNS, 4);
  const result = await AudioRepo.list(listState);
  listState.page = result.page;

  if (!result.items.length) {
    body.innerHTML = hasActiveFilters()
      ? tableEmptyRow({
          columnCount: TABLE_COLUMNS,
          icon: 'bi-search',
          title: 'No audio files match those filters',
          body: 'Try a different file name, or show all formats.',
          actionHtml:
            '<button class="btn btn-outline-secondary btn-sm" type="button" data-action="clear-filters">Clear filters</button>',
        })
      : tableEmptyRow({
          columnCount: TABLE_COLUMNS,
          icon: 'bi-music-note-beamed',
          title: 'The prompt library is empty',
          body: 'Upload a WAV, MP3 or OGG file and your IVRs will be able to play it.',
          actionHtml:
            '<button class="btn btn-primary btn-sm" type="button" data-action="open-upload"><i class="bi bi-upload"></i> Upload audio</button>',
        });
  } else {
    body.innerHTML = result.items.map(renderAudioRow).join('');
  }

  const count = qs('[data-result-count]');
  if (count) {
    count.textContent = `${result.total} file${result.total === 1 ? '' : 's'}`;
  }

  const status = qs('[data-page-status]');
  if (status) {
    const first = (result.page - 1) * result.pageSize + 1;
    const last = Math.min(result.page * result.pageSize, result.total);
    status.textContent = result.total
      ? `Showing ${first}–${last} of ${result.total}`
      : 'Nothing to show';
  }

  renderPagination(qs('#audioPagination'), result);
  markSortState(qs('#audioTable'), listState.sort, listState.direction);
  paintPlayerState();
}

/** The summary beside the upload zone. */
async function renderLibrarySummary() {
  const files = await AudioRepo.all();
  const totalSeconds = files.reduce((sum, file) => sum + (file.durationSeconds || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);

  qs('[data-audio-count]').textContent = String(files.length);
  qs('[data-audio-size]').textContent = formatBytes(totalBytes);
  qs('[data-audio-duration]').textContent = formatDuration(totalSeconds);
}

async function populateFormatFilter() {
  const select = qs('#audioFormatFilter');
  if (!select) return;
  const formats = await AudioRepo.formats();
  const current = select.value;
  select.innerHTML = [
    '<option value="">All formats</option>',
    ...formats.map((format) => `<option value="${format}">${format}</option>`),
  ].join('');
  select.value = current;
}

/* ==========================================================================
   Upload
   ========================================================================== */

/**
 * Ask the browser how long a file is.
 *
 * Reading the real duration from the decoder means the table shows the truth
 * rather than a guess, and it doubles as a format check: a file the browser
 * cannot decode rejects here instead of failing later at playback.
 *
 * @returns {Promise<number>} seconds
 */
function readDuration(file) {
  return new Promise((resolve, reject) => {
    const probe = new Audio();
    const objectUrl = URL.createObjectURL(file);

    const cleanUp = () => URL.revokeObjectURL(objectUrl);

    probe.addEventListener('loadedmetadata', () => {
      const seconds = Number.isFinite(probe.duration) ? probe.duration : 0;
      cleanUp();
      resolve(seconds);
    });
    probe.addEventListener('error', () => {
      cleanUp();
      reject(new Error('This browser cannot read that audio file.'));
    });

    probe.src = objectUrl;
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList ?? []);
  if (!files.length) return;

  let added = 0;
  for (const file of files) {
    try {
      const duration = await readDuration(file);
      await AudioRepo.create(file, duration);
      added += 1;
    } catch (error) {
      const message =
        error instanceof ValidationError ? error.message : `${file.name} could not be added.`;
      toast({ title: 'Upload failed', text: message, tone: 'danger', delay: 6000 });
    }
  }

  if (added) {
    toast({
      title: added === 1 ? 'Audio uploaded' : `${added} files uploaded`,
      text: 'Available to every IVR as a welcome prompt.',
      tone: 'ok',
    });
    listState.page = 1;
    await Promise.all([renderAudioTable(), renderLibrarySummary(), populateFormatFilter()]);
  }
}

function wireUpload() {
  const dropzone = qs('#audioDropzone');
  const input = qs('#audioInput');

  input.addEventListener('change', async () => {
    await uploadFiles(input.files);
    input.value = ''; // so re-selecting the same file fires change again
  });

  // Drag and drop. The default must be prevented on dragover too, or the
  // browser navigates to the dropped file instead of handing it over.
  ['dragenter', 'dragover'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  });
  dropzone.addEventListener('drop', (event) => uploadFiles(event.dataTransfer?.files));

  qs('[data-upload-trigger]').addEventListener('click', () => input.click());
}

/* ==========================================================================
   Delete
   ========================================================================== */

async function deleteFile(id) {
  let file;
  try {
    file = await AudioRepo.get(id);
  } catch {
    await renderAudioTable();
    return;
  }

  const confirmed = await confirmDialog({
    title: `Delete ${file.name}?`,
    body: 'Any IVR using it as a welcome prompt will be left without one.',
    confirmLabel: 'Delete file',
    tone: 'danger',
  });
  if (!confirmed) return;

  if (playingId === id) stopPlayback();

  try {
    await AudioRepo.remove(id);
    toast({ title: 'Audio deleted', text: `${file.name} has been removed.`, tone: 'ok' });
    await Promise.all([renderAudioTable(), renderLibrarySummary(), populateFormatFilter()]);
  } catch (error) {
    toast({ title: 'That could not be deleted', text: error.message, tone: 'danger' });
  }
}

/* ==========================================================================
   Init
   ========================================================================== */

export async function init() {
  // Arriving from the dashboard link to a specific prompt.
  const initialSearch = getParam('search');
  if (initialSearch) {
    listState.search = initialSearch;
    qs('#audioSearch').value = initialSearch;
  }

  await populateFormatFilter();
  await Promise.all([renderAudioTable(), renderLibrarySummary()]);

  wirePlayer();
  wireUpload();

  const applyAndRender = () => {
    listState.page = 1;
    renderAudioTable();
  };

  qs('#audioSearch').addEventListener(
    'input',
    debounce((event) => {
      listState.search = event.target.value;
      applyAndRender();
    }, 220),
  );

  qs('#audioFormatFilter').addEventListener('change', (event) => {
    listState.format = event.target.value;
    applyAndRender();
  });

  delegate(qs('#audioTable'), 'click', '[data-sort]', (_event, button) => {
    Object.assign(listState, nextSort(listState, button.dataset.sort));
    listState.page = 1;
    renderAudioTable();
  });

  delegate(qs('#audioPagination'), 'click', '[data-page]', (_event, button) => {
    listState.page = Number(button.dataset.page);
    renderAudioTable();
  });

  delegate(qs('#audioTableBody'), 'click', '[data-action]', async (_event, button) => {
    const { action, id } = button.dataset;
    if (action === 'play') await togglePlay(id);
    else if (action === 'stop') stopPlayback();
    else if (action === 'delete') await deleteFile(id);
    else if (action === 'open-upload') qs('#audioInput').click();
    else if (action === 'clear-filters') {
      listState.search = '';
      listState.format = '';
      qs('#audioSearch').value = '';
      qs('#audioFormatFilter').value = '';
      applyAndRender();
    }
  });

  // Arriving from the dashboard's "Upload audio" quick action.
  if (getParam('upload')) {
    const dropzone = qs('#audioDropzone');
    dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    qs('#audioInput').focus();
  }

  AudioRepo.onChange(async () => {
    await Promise.all([renderAudioTable(), renderLibrarySummary(), populateFormatFilter()]);
  });
}
