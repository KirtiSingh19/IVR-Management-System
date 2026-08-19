/**
 * The confirmation dialog, driven by notify.js.
 *
 * react-bootstrap's <Modal> here rather than hand-rolled markup, because what
 * this needs from Bootstrap is behaviour, not appearance: focus trapping, Escape
 * handling, the backdrop, and returning focus to whatever was focused before.
 * The classes inside are the project's own, so it looks identical.
 *
 * Every dismissal path settles the promise — Escape, backdrop and Cancel all
 * resolve false — so a caller can never be left awaiting.
 */
import { useEffect, useState } from 'react';
import Modal from 'react-bootstrap/Modal';
import { subscribeConfirm } from '../../services/notify.js';

export default function ConfirmHost() {
  const [request, setRequest] = useState(null);
  useEffect(() => subscribeConfirm(setRequest), []);

  const danger = request?.tone !== 'warn';

  return (
    <Modal show={Boolean(request)} onHide={() => request?.settle(false)} centered>
      <div className="modal-body">
        <div className="tw-flex tw-gap-4">
          <span className={`modal-icon modal-icon--${danger ? 'danger' : 'warn'}`} aria-hidden="true">
            <i className={`bi ${danger ? 'bi-trash3' : 'bi-exclamation-triangle'}`} />
          </span>
          <div>
            <h2 className="modal-title tw-mb-1">{request?.title}</h2>
            <p className="tw-mb-0 tw-text-sm tw-text-muted">{request?.body}</p>
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-outline-secondary" onClick={() => request?.settle(false)}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => request?.settle(true)}
        >
          {request?.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
