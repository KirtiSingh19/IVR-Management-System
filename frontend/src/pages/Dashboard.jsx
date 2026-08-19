/**
 * Dashboard. Ported from pages/dashboard.html + js/dashboard.js.
 *
 * Read-only: it summarises what the other pages manage. Same markup, same
 * classes, so css/dashboard.css styles it unchanged.
 *
 * The old controller re-rendered on IvrRepo/AudioRepo change events. Those still
 * fire, so the effect below re-reads on them — but a route change now remounts
 * this component anyway, which covers the common case of editing an IVR and
 * coming back.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { IvrRepo, AudioRepo, FlowRepo } from '../services/repo.js';
import { formatBytes, formatDuration, formatRelative, initials } from '../services/utils.js';
import StatusBadge from '../components/ui/StatusBadge.jsx';
import AsteriskPanel from '../components/AsteriskPanel.jsx';

const RECENT_LIMIT = 5;

function StatCard({ label, icon, value, foot }) {
  return (
    <div className="stat-card">
      <div className="stat-card__head">
        <p className="stat-card__label">{label}</p>
        <span className={`stat-card__icon stat-card__icon--${icon.tone}`} aria-hidden="true">
          <i className={`bi ${icon.name}`} />
        </span>
      </div>
      <p className="stat-card__value">{value}</p>
      <p className="stat-card__foot">{foot}</p>
    </div>
  );
}

/** The active/inactive split. The bar is decorative; the legend carries the figures. */
function StatusOverview({ stats }) {
  if (!stats.total) {
    return (
      <div className="empty-state tw-py-6">
        <span className="empty-state__icon" aria-hidden="true">
          <i className="bi bi-diagram-3" />
        </span>
        <p className="empty-state__title">No IVRs yet</p>
        <p className="empty-state__body">Create the first one and this will fill in.</p>
        <Link className="btn btn-primary btn-sm" to="/create-ivr">
          Create IVR
        </Link>
      </div>
    );
  }

  const activeShare = Math.round((stats.active / stats.total) * 100);

  return (
    <>
      <div className="status-bar" aria-hidden="true">
        <div className="status-bar__segment status-bar__segment--ok" style={{ width: `${activeShare}%` }} />
        <div className="status-bar__segment status-bar__segment--idle" style={{ width: `${100 - activeShare}%` }} />
      </div>
      <ul className="status-legend">
        <li>
          <span className="status-legend__swatch status-legend__swatch--ok" aria-hidden="true" />
          <span className="status-legend__label">Active</span>
          <span className="status-legend__value">{stats.active}</span>
          <span className="status-legend__share">{activeShare}%</span>
        </li>
        <li>
          <span className="status-legend__swatch status-legend__swatch--idle" aria-hidden="true" />
          <span className="status-legend__label">Inactive</span>
          <span className="status-legend__value">{stats.inactive}</span>
          <span className="status-legend__share">{100 - activeShare}%</span>
        </li>
      </ul>
      <p className="tw-mt-4 tw-mb-0 tw-text-xs tw-text-muted">
        {stats.inactive
          ? `${stats.inactive} IVR${stats.inactive === 1 ? '' : 's'} ${
              stats.inactive === 1 ? 'is' : 'are'
            } configured but not answering calls.`
          : 'Every IVR is answering calls.'}
      </p>
    </>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    const [ivrStats, audioStats, ivrs, audio, menuCounts] = await Promise.all([
      IvrRepo.stats(),
      AudioRepo.stats(),
      IvrRepo.list({ sort: 'updatedAt', direction: 'desc', pageSize: RECENT_LIMIT }),
      AudioRepo.list({ sort: 'createdAt', direction: 'desc', pageSize: RECENT_LIMIT }),
      FlowRepo.countsByIvr(),
    ]);
    setData({ ivrStats, audioStats, recentIvrs: ivrs.items, recentAudio: audio.items, menuCounts });
  }, []);

  useEffect(() => {
    load();
    // The repositories still announce changes made in this tab, so a delete on
    // another page is reflected without a reload.
    const offIvr = IvrRepo.onChange(load);
    const offAudio = AudioRepo.onChange(load);
    return () => {
      offIvr();
      offAudio();
    };
  }, [load]);

  const ivrStats = data?.ivrStats ?? { total: 0, active: 0, inactive: 0 };
  const audioStats = data?.audioStats ?? { total: 0, totalBytes: 0 };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Dashboard</h1>
          <p className="page-header__subtitle">Everything configured on this system, at a glance.</p>
        </div>
      </div>

      <section aria-labelledby="statsHeading">
        <h2 className="visually-hidden" id="statsHeading">
          Summary
        </h2>
        <div className="row g-3">
          <div className="col-12 col-sm-6 col-xl-3">
            <StatCard
              label="Total IVRs"
              icon={{ tone: 'signal', name: 'bi-diagram-3' }}
              value={ivrStats.total}
              foot="Across the whole system"
            />
          </div>
          <div className="col-12 col-sm-6 col-xl-3">
            <StatCard
              label="Active IVRs"
              icon={{ tone: 'ok', name: 'bi-broadcast-pin' }}
              value={ivrStats.active}
              foot={
                ivrStats.total
                  ? `${Math.round((ivrStats.active / ivrStats.total) * 100)}% of all IVRs`
                  : 'Nothing configured yet'
              }
            />
          </div>
          <div className="col-12 col-sm-6 col-xl-3">
            <StatCard
              label="Inactive IVRs"
              icon={{ tone: 'neutral', name: 'bi-pause-circle' }}
              value={ivrStats.inactive}
              foot="Configured but not live"
            />
          </div>
          <div className="col-12 col-sm-6 col-xl-3">
            <StatCard
              label="Audio Files"
              icon={{ tone: 'warn', name: 'bi-music-note-beamed' }}
              value={audioStats.total}
              foot={
                audioStats.total
                  ? `${formatBytes(audioStats.totalBytes)} in the prompt library`
                  : 'No prompts uploaded yet'
              }
            />
          </div>
        </div>
      </section>

      <AsteriskPanel />

      <div className="row g-3 tw-mt-1">
        <div className="col-12 col-lg-8">
          <section className="card h-100" aria-labelledby="recentIvrsHeading">
            <div className="card-header">
              <div>
                <h2 id="recentIvrsHeading">Recent IVRs</h2>
                <p className="card-header__hint">The five most recently changed</p>
              </div>
              <Link className="btn btn-outline-secondary btn-sm" to="/ivr-list">
                View all <i className="bi bi-arrow-right" aria-hidden="true" />
              </Link>
            </div>
            <div className="card-body tw-p-0">
              <ul className="recent-list">
                {!data ? (
                  <li className="tw-px-5 tw-py-4">
                    <span className="skeleton skeleton--wide" />
                  </li>
                ) : data.recentIvrs.length === 0 ? (
                  <li>
                    <div className="empty-state">
                      <span className="empty-state__icon" aria-hidden="true">
                        <i className="bi bi-diagram-3" />
                      </span>
                      <p className="empty-state__title">No IVRs yet</p>
                      <p className="empty-state__body">
                        Create your first IVR and it will appear here with everything else you change.
                      </p>
                      <Link className="btn btn-primary btn-sm" to="/create-ivr">
                        <i className="bi bi-plus-lg" aria-hidden="true" /> Create IVR
                      </Link>
                    </div>
                  </li>
                ) : (
                  data.recentIvrs.map((ivr) => {
                    const count = data.menuCounts[ivr.id] ?? 0;
                    return (
                      <li key={ivr.id}>
                        <Link className="recent-item" to={`/edit-ivr?id=${encodeURIComponent(ivr.id)}`}>
                          <span className="recent-item__icon" aria-hidden="true">
                            {initials(ivr.name)}
                          </span>
                          <span className="recent-item__body">
                            <span className="recent-item__title">{ivr.name}</span>
                            <span className="recent-item__meta">
                              <span className="num">Ext {ivr.extension}</span>
                              <span className="recent-item__sep" aria-hidden="true">
                                &bull;
                              </span>
                              <span>
                                {count} menu option{count === 1 ? '' : 's'}
                              </span>
                              <span className="recent-item__sep" aria-hidden="true">
                                &bull;
                              </span>
                              <span>Updated {formatRelative(ivr.updatedAt)}</span>
                            </span>
                          </span>
                          <StatusBadge status={ivr.status} />
                        </Link>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          </section>
        </div>

        <div className="col-12 col-lg-4">
          <section className="card h-100" aria-labelledby="statusHeading">
            <div className="card-header">
              <div>
                <h2 id="statusHeading">IVR status overview</h2>
                <p className="card-header__hint">Share of IVRs answering calls</p>
              </div>
            </div>
            <div className="card-body">
              <StatusOverview stats={ivrStats} />
            </div>
          </section>
        </div>
      </div>

      <div className="row g-3 tw-mt-1">
        <div className="col-12">
          <section className="card" aria-labelledby="recentAudioHeading">
            <div className="card-header">
              <div>
                <h2 id="recentAudioHeading">Recent audio files</h2>
                <p className="card-header__hint">The newest prompts in the library</p>
              </div>
              <Link className="btn btn-outline-secondary btn-sm" to="/audio-files">
                View all <i className="bi bi-arrow-right" aria-hidden="true" />
              </Link>
            </div>
            <div className="card-body tw-p-0">
              <ul className="recent-list">
                {!data ? (
                  <li className="tw-px-5 tw-py-4">
                    <span className="skeleton skeleton--wide" />
                  </li>
                ) : data.recentAudio.length === 0 ? (
                  <li>
                    <div className="empty-state">
                      <span className="empty-state__icon" aria-hidden="true">
                        <i className="bi bi-music-note-beamed" />
                      </span>
                      <p className="empty-state__title">The prompt library is empty</p>
                      <p className="empty-state__body">
                        Upload an audio file and your IVRs will be able to play it.
                      </p>
                      <Link className="btn btn-primary btn-sm" to="/audio-files">
                        <i className="bi bi-upload" aria-hidden="true" /> Upload audio
                      </Link>
                    </div>
                  </li>
                ) : (
                  data.recentAudio.map((file) => (
                    <li key={file.id}>
                      <Link className="recent-item" to={`/audio-files?search=${encodeURIComponent(file.name)}`}>
                        <span className="recent-item__icon" aria-hidden="true">
                          <i className="bi bi-file-earmark-music" />
                        </span>
                        <span className="recent-item__body">
                          <span className="recent-item__title num">{file.name}</span>
                          <span className="recent-item__meta">
                            <span>{file.format}</span>
                            <span className="recent-item__sep" aria-hidden="true">
                              &bull;
                            </span>
                            <span className="num">{formatDuration(file.durationSeconds)}</span>
                            <span className="recent-item__sep" aria-hidden="true">
                              &bull;
                            </span>
                            <span className="num">{formatBytes(file.sizeBytes)}</span>
                          </span>
                        </span>
                        <StatusBadge status={file.status} />
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
