/**
 * Call History — recordings of browser calls, for administrators.
 *
 * Built from the same table, player and empty-state pieces as Audio Files, so it
 * reads as part of the product rather than a bolted-on report.
 *
 * The admin check here is a courtesy that keeps the UI tidy. The real control is
 * on the server: /api/recordings answers 403 to a non-admin whatever the page
 * does, because a hidden link is not a permission.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '../hooks/useAuth.js';
import { formatBytes, formatDateTime, formatDuration } from '../services/utils.js';
import { toast, confirmDialog } from '../services/notify.js';
import { EmptyRow, SkeletonRows } from '../components/ui/TableStates.jsx';

const TABLE_COLUMNS = 6;

export default function CallHistory() {
  const { role } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  const player = useRef(null);
  const [playing, setPlaying] = useState({ id: null, paused: true, position: 0, duration: 0 });

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/recordings');
      if (response.status === 403) {
        setError('Only administrators can view call recordings.');
        setRows([]);
        return;
      }
      const payload = await response.json();
      setRows(payload.recordings ?? []);
    } catch {
      setError('Could not reach the API.');
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // One element for the page, stopped on unmount so leaving does not leave a
  // recording playing behind it.
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
    const ended = () => setPlaying({ id: null, paused: true, position: 0, duration: 0 });

    ['timeupdate', 'play', 'pause'].forEach((name) => element.addEventListener(name, sync));
    element.addEventListener('ended', ended);
    return () => {
      element.pause();
      ['timeupdate', 'play', 'pause'].forEach((name) => element.removeEventListener(name, sync));
      element.removeEventListener('ended', ended);
      player.current = null;
    };
  }, []);

  async function toggle(row) {
    const element = player.current;
    if (!element) return;

    if (playing.id === row.id) {
      if (element.paused) await element.play().catch(() => {});
      else element.pause();
      return;
    }

    element.src = `/api/recordings/${row.id}/file`;
    setPlaying({ id: row.id, paused: false, position: 0, duration: 0 });
    try {
      await element.play();
    } catch {
      setPlaying({ id: null, paused: true, position: 0, duration: 0 });
      toast({ title: 'That recording could not be played', tone: 'danger' });
    }
  }

  async function remove(row) {
    const ok = await confirmDialog({
      title: 'Delete this recording?',
      body: `The call from ${row.from_extension} to ${row.to_extension} on ${formatDateTime(row.started_at)} will be permanently removed.`,
      confirmLabel: 'Delete recording',
      tone: 'danger',
    });
    if (!ok) return;

    if (playing.id === row.id) player.current?.pause();
    const response = await fetch(`/api/recordings/${row.id}`, { method: 'DELETE' });
    if (!response.ok) {
      toast({ title: 'That could not be deleted', tone: 'danger' });
      return;
    }
    toast({ title: 'Recording deleted', tone: 'ok' });
    load();
  }

  const share = playing.duration ? (playing.position / playing.duration) * 100 : 0;

  if (role !== 'admin') {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-header__title">Call History</h1>
          </div>
        </div>
        <section className="card">
          <div className="card-body">
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                <i className="bi bi-shield-lock" />
              </span>
              <p className="empty-state__title">Administrators only</p>
              <p className="empty-state__body">
                Call recordings are restricted. Ask an administrator if you need access.
              </p>
            </div>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Call History</h1>
          <p className="page-header__subtitle">
            Recordings of calls made through the browser phone, newest first.
          </p>
        </div>
      </div>

      {error ? (
        <div className="alert alert-warning" role="alert">
          {error}
        </div>
      ) : null}

      <section className="card">
        <div className="card-header">
          <div>
            <h2 id="historyHeading">Recordings</h2>
            <p className="card-header__hint">Both sides of each call, mixed</p>
          </div>
          <span className="toolbar__count">
            {rows?.length ?? 0} recording{(rows?.length ?? 0) === 1 ? '' : 's'}
          </span>
        </div>

        {playing.id ? (
          <div className="player">
            <button
              className="player__button"
              type="button"
              aria-label={playing.paused ? 'Resume' : 'Pause'}
              onClick={() => toggle({ id: playing.id })}
            >
              <i className={`bi ${playing.paused ? 'bi-play-fill' : 'bi-pause-fill'}`} aria-hidden="true" />
            </button>
            <div className="player__body">
              <p className="player__name">Recording #{playing.id}</p>
              <div className="player__track" role="progressbar" aria-label="Playback position"
                   aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}
                   onClick={(event) => {
                     const element = player.current;
                     if (!element || !Number.isFinite(element.duration)) return;
                     const bounds = event.currentTarget.getBoundingClientRect();
                     element.currentTime = ((event.clientX - bounds.left) / bounds.width) * element.duration;
                   }}>
                <div className="player__progress" style={{ width: `${share}%` }} />
              </div>
            </div>
            <span className="player__time">
              {formatDuration(playing.position)} / {formatDuration(playing.duration)}
            </span>
          </div>
        ) : null}

        <div className="table-responsive">
          <table className="table table-hover align-middle">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Length</th>
                <th scope="col">Recorded by</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                <SkeletonRows columnCount={TABLE_COLUMNS} rowCount={4} />
              ) : rows.length === 0 ? (
                <EmptyRow
                  columnCount={TABLE_COLUMNS}
                  icon="bi-record-circle"
                  title="No recordings yet"
                  body="Calls made from the browser phone are recorded automatically and will appear here."
                />
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className={playing.id === row.id ? 'is-playing' : undefined}>
                    <td className="cell-muted num">{formatDateTime(row.started_at)}</td>
                    <td>
                      <span className="num-ext">{row.from_extension}</span>
                    </td>
                    <td>
                      <span className="num-ext">{row.to_extension}</span>
                      <span className="tw-ml-2 tw-text-xs tw-text-muted">
                        <i
                          className={`bi ${row.direction === 'inbound' ? 'bi-arrow-down-left' : 'bi-arrow-up-right'}`}
                          aria-hidden="true"
                        />{' '}
                        {row.direction}
                      </span>
                    </td>
                    <td className="num cell-muted">
                      {formatDuration(row.duration_seconds)}
                      <span className="tw-ml-2 tw-text-xs">{formatBytes(row.size_bytes)}</span>
                    </td>
                    <td className="cell-muted">{row.username ?? '—'}</td>
                    <td>
                      <span className="row-actions">
                        <button
                          className="btn-icon"
                          type="button"
                          title="Play"
                          aria-label={`Play the call from ${row.from_extension} to ${row.to_extension}`}
                          disabled={row.missing}
                          onClick={() => toggle(row)}
                        >
                          <i
                            className={`bi ${
                              playing.id === row.id && !playing.paused ? 'bi-pause-fill' : 'bi-play-fill'
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                        {/* A plain link, so the browser's own download handling
                            applies and the file keeps a sensible name. */}
                        <a
                          className="btn-icon"
                          href={`/api/recordings/${row.id}/file`}
                          download={`call-${row.from_extension}-${row.to_extension}-${row.id}`}
                          title="Download"
                          aria-label="Download this recording"
                        >
                          <i className="bi bi-download" aria-hidden="true" />
                        </a>
                        <button
                          className="btn-icon btn-icon--danger"
                          type="button"
                          title="Delete"
                          aria-label="Delete this recording"
                          onClick={() => remove(row)}
                        >
                          <i className="bi bi-trash3" aria-hidden="true" />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}