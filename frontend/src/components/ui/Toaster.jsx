/**
 * Renders whatever notify.js is holding.
 *
 * Deliberately not react-bootstrap's <Toast>: the project's css/style.css
 * already styles `.toast--ok`, `.toast__body`, `.toast__icon` and so on. Using
 * the library's own structure would mean either restyling it or accepting a
 * different-looking toast, and neither is "keep the design exactly the same".
 * The only thing Bootstrap's JS did here was auto-hide, which is a timer.
 */
import { useEffect, useState } from 'react';
import { subscribeToasts, dismissToast } from '../../services/notify.js';

const TONES = {
  ok: { className: 'toast--ok', icon: 'bi-check-circle-fill' },
  danger: { className: 'toast--danger', icon: 'bi-exclamation-octagon-fill' },
  warn: { className: 'toast--warn', icon: 'bi-exclamation-triangle-fill' },
  neutral: { className: 'toast--neutral', icon: 'bi-info-circle-fill' },
};

function Entry({ entry }) {
  useEffect(() => {
    const id = setTimeout(() => dismissToast(entry.id), entry.delay);
    return () => clearTimeout(id);
  }, [entry.id, entry.delay]);

  const { className, icon } = TONES[entry.tone] ?? TONES.neutral;

  return (
    // `show` is Bootstrap's own class for a visible toast; without it the CSS
    // keeps it at zero opacity.
    <div className={`toast show ${className}`} role={entry.tone === 'danger' ? 'alert' : 'status'}>
      <div className="toast__body">
        <i className={`bi ${icon} toast__icon`} aria-hidden="true" />
        <div className="tw-min-w-0 tw-flex-1">
          <p className="toast__title">{entry.title}</p>
          {entry.text ? <p className="toast__text">{entry.text}</p> : null}
        </div>
        <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => dismissToast(entry.id)} />
      </div>
    </div>
  );
}

export default function Toaster() {
  const [entries, setEntries] = useState([]);
  useEffect(() => subscribeToasts(setEntries), []);

  return (
    <div className="toast-host" id="toastHost" aria-live="polite" aria-atomic="true">
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
