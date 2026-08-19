/**
 * Audio Files. Ported from pages/audio-files.html + js/audio.js.
 *
 * One <audio> element for the whole page, held in a ref. Only one prompt can
 * sound at a time — which is also true of a real phone line — so starting one
 * stops whatever was playing, and there is one set of transport controls rather
 * than a pair on every row.
 *
 * The element is a ref rather than state because playback position changes
 * sixty times a second and none of that should re-render the table; only the
 * player bar reads it, and it does so from its own small piece of state.
 *
 * Unlike the phone, tearing this down on unmount is correct: it is a local
 * preview, not a connection somebody is relying on.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AudioRepo, ValidationError } from '../services/repo.js';
import { formatBytes, formatDate, formatDuration } from '../services/utils.js';
import { toast, confirmDialog } from '../services/notify.js';
import StatusBadge from '../components/ui/StatusBadge.jsx';
import Pagination from '../components/ui/Pagination.jsx';
import SortHeader, { nextSort } from '../components/ui/SortHeader.jsx';
import { EmptyRow, SkeletonRows } from '../components/ui/TableStates.jsx';

const TABLE_COLUMNS = 6;

/**
 * Ask the browser how long a file is.
 *
 * Reading the real duration from the decoder means the table shows the truth
 * rather than a guess, and it doubles as a format check: a file the browser
 * cannot decode is rejected here instead of failing later at playback.
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

export default function AudioFiles() {
  const [params] = useSearchParams();

  const [query, setQuery] = useState(() => ({
    search: params.get('search') ?? '',
    format: '',
    sort: 'createdAt',
    direction: 'desc',
    page: 1,
    pageSize: 8,
  }));

  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState({ count: 0, bytes: 0, seconds: 0 });
  const [formats, setFormats] = useState([]);
  const [dragging, setDragging] = useState(false);

  const player = useRef(null);
  const [playing, setPlaying] = useState({ id: null, name: '', paused: true, position: 0, duration: 0 });

  const filtered = Boolean(query.search || query.format);

  const load = useCallback(async () => {
    const [page, all, availableFormats] = await Promise.all([
      AudioRepo.list(query),
      AudioRepo.all(),
      AudioRepo.formats(),
    ]);
    setResult(page);
    setFormats(availableFormats);
    setSummary({
      count: all.length,
      bytes: all.reduce((sum, file) => sum + (file.sizeBytes || 0), 0),
      seconds: all.reduce((sum, file) => sum + (file.durationSeconds || 0), 0),
    });
  }, [query]);

  useEffect(() => {
    load();
    return AudioRepo.onChange(load);
  }, [load]);

  // One element for the page. Created once and stopped on unmount, so leaving
  // the page does not leave a prompt playing behind it.
  useEffect(() => {
    const element = new Audio();
    element.preload = 'metadata';
    player.current = element;

    const sync = () =>
      setPlaying((current) => ({
        ...current,
        paused: element.paused,
        position: element.currentTime,
        duration: Number.isFinite(element.duration) ? element.duration : 0,
      }));
    const ended = () => setPlaying({ id: null, name: '', paused: true, position: 0, duration: 0 });

    element.addEventListener('timeupdate', sync);
    element.addEventListener('play', sync);
    element.addEventListener('pause', sync);
    element.addEventListener('ended', ended);

    return () => {
      element.pause();
      element.removeEventListener('timeupdate', sync);
      element.removeEventListener('play', sync);
      element.removeEventListener('pause', sync);
      element.removeEventListener('ended', ended);
      player.current = null;
    };
  }, []);

  const update = (changes) => setQuery((current) => ({ ...current, page: 1, ...changes }));

  async function togglePlay(file) {
    const element = player.current;
    if (!element) return;

    // Same file: pause or resume rather than restart it.
    if (playing.id === file.id) {
      if (element.paused) await element.play().catch(() => {});
      else element.pause();
      return;
    }

    const source = AudioRepo.sourceFor(file);
    if (!source) {
      toast({
        title: 'That audio is missing',
        text: `${file.name} is in the library but its file is not on the server. Upload it again to replace it.`,
        tone: 'warn',
        delay: 6000,
      });
      return;
    }

    element.src = source;
    setPlaying({ id: file.id, name: file.name, paused: false, position: 0, duration: 0 });
    try {
      await element.play();
    } catch (error) {
      console.error('[audio] playback failed', error);
      setPlaying({ id: null, name: '', paused: true, position: 0, duration: 0 });
      toast({ title: 'That file could not be played', text: file.name, tone: 'danger' });
    }
  }

  function stopPlayback() {
    const element = player.current;
    if (element) {
      element.pause();
      element.currentTime = 0;
    }
    setPlaying({ id: null, name: '', paused: true, position: 0, duration: 0 });
  }

  function seek(event) {
    const element = player.current;
    if (!element || !Number.isFinite(element.duration)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    element.currentTime = ((event.clientX - bounds.left) / bounds.width) * element.duration;
  }

  async function upload(fileList) {
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
      setQuery((current) => ({ ...current, page: 1 }));
    }
  }

  async function remove(file) {
    const ok = await confirmDialog({
      title: `Delete ${file.name}?`,
      body: 'Any IVR using it as a welcome prompt will be left without one.',
      confirmLabel: 'Delete file',
      tone: 'danger',
    });
    if (!ok) return;

    if (playing.id === file.id) stopPlayback();
    try {
      await AudioRepo.remove(file.id);
      toast({ title: 'Audio deleted', text: `${file.name} has been removed.`, tone: 'ok' });
    } catch (error) {
      toast({ title: 'That could not be deleted', text: error.message, tone: 'danger' });
    }
  }

  const items = result?.items ?? [];
  const share = playing.duration ? (playing.position / playing.duration) * 100 : 0;
  const first = result ? (result.page - 1) * result.pageSize + 1 : 0;
  const last = result ? Math.min(result.page * result.pageSize, result.total) : 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Audio Files</h1>
          <p className="page-header__subtitle">
            The prompt library every IVR draws its welcome message from.
          </p>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-4">
          <section className="card h-100" aria-labelledby="uploadHeading">
            <div className="card-header">
              <div>
                <h2 id="uploadHeading">Upload</h2>
                <p className="card-header__hint">Add a prompt to the library</p>
              </div>
            </div>
            <div className="card-body">
              <label
                className={`dropzone${dragging ? ' is-dragover' : ''}`}
                htmlFor="audioInput"
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                // The default must be prevented on dragover too, or the browser
                // navigates to the dropped file instead of handing it over.
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  upload(event.dataTransfer?.files);
                }}
              >
                <span className="dropzone__icon" aria-hidden="true">
                  <i className="bi bi-cloud-arrow-up" />
                </span>
                <span className="dropzone__title tw-block">Drop an audio file here</span>
                <span className="dropzone__hint tw-block">
                  or click to choose one &middot; WAV, MP3, OGG
                </span>
                <input
                  className="dropzone__input"
                  type="file"
                  id="audioInput"
                  accept="audio/*"
                  multiple
                  onChange={(event) => {
                    upload(event.target.files);
                    // So re-selecting the same file fires change again.
                    event.target.value = '';
                  }}
                />
              </label>

              <dl className="asterisk-facts tw-mt-4">
                <div>
                  <dt>Files</dt>
                  <dd>{summary.count}</dd>
                </div>
                <div>
                  <dt>Total size</dt>
                  <dd className="num">{formatBytes(summary.bytes)}</dd>
                </div>
                <div>
                  <dt>Total length</dt>
                  <dd className="num">{formatDuration(summary.seconds)}</dd>
                </div>
              </dl>

              <div className="tw-mt-4 tw-text-xs tw-text-muted">
                <p className="tw-mb-2 tw-flex tw-items-start tw-gap-2">
                  <i className="bi bi-info-circle tw-mt-0.5" aria-hidden="true" />
                  <span>
                    Uploads are sent to the server, which stores the file on disk and its details in
                    MySQL. Prompts survive a reload, and every IVR on this server can use them. WAV,
                    MP3, OGG and GSM, up to 20&nbsp;MB.
                  </span>
                </p>
              </div>
            </div>
          </section>
        </div>

        <div className="col-12 col-xl-8">
          <section className="card h-100" aria-labelledby="libraryHeading">
            <div className="card-header">
              <div className="toolbar">
                <div className="toolbar__search">
                  <label className="visually-hidden" htmlFor="audioSearch">
                    Search audio files
                  </label>
                  <i className="bi bi-search" aria-hidden="true" />
                  <input
                    className="form-control"
                    type="search"
                    id="audioSearch"
                    placeholder="Search by file name"
                    autoComplete="off"
                    value={query.search}
                    onChange={(event) => update({ search: event.target.value })}
                  />
                </div>
                <div className="toolbar__select">
                  <label className="visually-hidden" htmlFor="audioFormatFilter">
                    Filter by format
                  </label>
                  <select
                    className="form-select"
                    id="audioFormatFilter"
                    value={query.format}
                    onChange={(event) => update({ format: event.target.value })}
                  >
                    <option value="">All formats</option>
                    {formats.map((format) => (
                      <option key={format} value={format}>
                        {format}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="toolbar__count">
                  {result?.total ?? 0} file{(result?.total ?? 0) === 1 ? '' : 's'}
                </span>
              </div>
            </div>

            {/* The player bar, shown only while something is loaded. */}
            {playing.id ? (
              <div className="player" id="audioPlayer">
                <button
                  className="player__button"
                  type="button"
                  aria-label={playing.paused ? 'Resume' : 'Pause'}
                  onClick={() => togglePlay({ id: playing.id })}
                >
                  <i className={`bi ${playing.paused ? 'bi-play-fill' : 'bi-pause-fill'}`} aria-hidden="true" />
                </button>
                <div className="player__body">
                  <p className="player__name">{playing.name}</p>
                  <div
                    className="player__track"
                    role="progressbar"
                    aria-label="Playback position"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(share)}
                    onClick={seek}
                  >
                    <div className="player__progress" style={{ width: `${share}%` }} />
                  </div>
                </div>
                <span className="player__time">
                  {formatDuration(playing.position)} / {formatDuration(playing.duration)}
                </span>
                <button className="player__button" type="button" aria-label="Stop" onClick={stopPlayback}>
                  <i className="bi bi-stop-fill" aria-hidden="true" />
                </button>
              </div>
            ) : null}

            <div className="table-responsive">
              <table className="table table-hover align-middle" id="audioTable">
                <thead>
                  <tr>
                    <SortHeader
                      column="name"
                      label="File"
                      sort={query.sort}
                      direction={query.direction}
                      onSort={(column) => setQuery((c) => ({ ...c, ...nextSort(c, column), page: 1 }))}
                    />
                    <th scope="col">Format</th>
                    <SortHeader
                      column="durationSeconds"
                      label="Length"
                      sort={query.sort}
                      direction={query.direction}
                      onSort={(column) => setQuery((c) => ({ ...c, ...nextSort(c, column), page: 1 }))}
                    />
                    <SortHeader
                      column="sizeBytes"
                      label="Size"
                      sort={query.sort}
                      direction={query.direction}
                      onSort={(column) => setQuery((c) => ({ ...c, ...nextSort(c, column), page: 1 }))}
                    />
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody id="audioTableBody">
                  {!result ? (
                    <SkeletonRows columnCount={TABLE_COLUMNS} rowCount={4} />
                  ) : items.length === 0 ? (
                    filtered ? (
                      <EmptyRow
                        columnCount={TABLE_COLUMNS}
                        icon="bi-search"
                        title="No audio files match those filters"
                        body="Try a different file name, or show all formats."
                      >
                        <button
                          className="btn btn-outline-secondary btn-sm"
                          type="button"
                          onClick={() => update({ search: '', format: '' })}
                        >
                          Clear filters
                        </button>
                      </EmptyRow>
                    ) : (
                      <EmptyRow
                        columnCount={TABLE_COLUMNS}
                        icon="bi-music-note-beamed"
                        title="The prompt library is empty"
                        body="Upload a WAV, MP3 or OGG file and your IVRs will be able to play it."
                      />
                    )
                  ) : (
                    items.map((file) => {
                      const missing = AudioRepo.isSourceMissing(file);
                      const isPlaying = playing.id === file.id;
                      return (
                        <tr key={file.id} className={isPlaying ? 'is-playing' : undefined}>
                          <td>
                            <span className="file-cell">
                              <span className="file-cell__icon" aria-hidden="true">
                                <i className="bi bi-file-earmark-music" />
                              </span>
                              <span className="tw-min-w-0">
                                <span className="file-cell__name">{file.name}</span>
                                <span className="file-cell__meta">
                                  {missing ? (
                                    <span className="session-note">
                                      <i className="bi bi-exclamation-triangle" aria-hidden="true" />
                                      Missing from the server
                                    </span>
                                  ) : file.seeded ? (
                                    'Shipped with the app'
                                  ) : (
                                    `Uploaded ${formatDate(file.createdAt)}`
                                  )}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className="format-chip">{file.format}</span>
                          </td>
                          <td className="num cell-muted">{formatDuration(file.durationSeconds)}</td>
                          <td className="num cell-muted">{formatBytes(file.sizeBytes)}</td>
                          <td>
                            <StatusBadge status={file.status} />
                          </td>
                          <td>
                            <span className="row-actions">
                              <button
                                className="btn-icon"
                                type="button"
                                title={`Play ${file.name}`}
                                aria-label={`${isPlaying && !playing.paused ? 'Pause' : 'Play'} ${file.name}`}
                                disabled={missing}
                                onClick={() => togglePlay(file)}
                              >
                                <i
                                  className={`bi ${isPlaying && !playing.paused ? 'bi-pause-fill' : 'bi-play-fill'}`}
                                  aria-hidden="true"
                                />
                              </button>
                              <button
                                className="btn-icon"
                                type="button"
                                title="Stop playback"
                                aria-label={`Stop playing ${file.name}`}
                                onClick={stopPlayback}
                              >
                                <i className="bi bi-stop-fill" aria-hidden="true" />
                              </button>
                              <button
                                className="btn-icon btn-icon--danger"
                                type="button"
                                title={`Delete ${file.name}`}
                                aria-label={`Delete ${file.name}`}
                                onClick={() => remove(file)}
                              >
                                <i className="bi bi-trash3" aria-hidden="true" />
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="card-footer">
              <span className="tw-text-xs tw-text-muted">
                {result?.total ? `Showing ${first}–${last} of ${result.total}` : 'Nothing to show'}
              </span>
              <nav aria-label="Audio file pages">
                <Pagination
                  page={result?.page ?? 1}
                  pageCount={result?.pageCount ?? 1}
                  onChange={(page) => setQuery((current) => ({ ...current, page }))}
                />
              </nav>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
