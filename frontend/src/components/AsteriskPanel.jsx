/**
 * The read-only view of the PBX. Ported from the Asterisk card in
 * pages/dashboard.html + renderAsterisk() in js/dashboard.js.
 *
 * Loaded separately from the rest of the dashboard, and deliberately not awaited
 * alongside it: these two calls cross the network to another machine and can take
 * seconds when it is down, while everything else reads MySQL and returns in
 * milliseconds. Holding the page on an unresponsive PBX would make a healthy site
 * look broken.
 *
 * Neither call throws — services/api.js turns every failure into a report — so a
 * switch that is off simply shows as Disconnected.
 */

import { useCallback, useEffect, useState } from 'react';
import { fetchAsteriskStatus, fetchAsteriskExtensions } from '../services/api.js';

export default function AsteriskPanel() {
  const [status, setStatus] = useState(null);
  const [endpoints, setEndpoints] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const [nextStatus, nextEndpoints] = await Promise.all([
      fetchAsteriskStatus(),
      fetchAsteriskExtensions(),
    ]);
    setStatus(nextStatus);
    setEndpoints(nextEndpoints);
    setBusy(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connected = status?.connected;
  const rows = endpoints?.extensions ?? [];

  return (
    <section className="card tw-mt-3" aria-labelledby="asteriskHeading">
      <div className="card-header">
        <div>
          <h2 id="asteriskHeading">Asterisk server</h2>
          <p className="card-header__hint">Read-only link to the PBX</p>
        </div>
        <button className="btn btn-outline-secondary btn-sm" type="button" onClick={load} disabled={busy}>
          <i className="bi bi-arrow-clockwise" aria-hidden="true" /> Refresh status
        </button>
      </div>
      <div className="card-body">
        <dl className="asterisk-facts">
          <div>
            <dt>Asterisk status</dt>
            <dd>
              {!status ? (
                <span className="skeleton" />
              ) : (
                <span className={`status status--${connected ? 'ok' : 'danger'}`}>
                  <span className="status__dot" aria-hidden="true" />
                  {connected ? 'Connected' : 'Disconnected'}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Server</dt>
            <dd className="num">{status?.host || '—'}</dd>
          </div>
          <div>
            <dt>AMI port</dt>
            <dd className="num">{status?.port || '—'}</dd>
          </div>
          <div>
            <dt>Extensions</dt>
            <dd>{endpoints?.success ? String(rows.length) : '—'}</dd>
          </div>
        </dl>

        <p className="tw-mt-3 tw-mb-0 tw-text-xs tw-text-muted">
          {connected
            ? endpoints?.status_source
              ? `Extensions read from ${endpoints.status_source}.`
              : ''
            : status?.message ?? ''}
        </p>

        {rows.length > 0 && (
          <div className="tw-mt-3">
            <ul className="asterisk-extensions">
              {rows.map((row) => (
                <li key={row.extension}>
                  <span className="num">{row.extension}</span>
                  <span className="asterisk-extensions__meta">
                    {row.status}
                    {row.context ? ` · ${row.context}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
