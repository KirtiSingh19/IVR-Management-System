/**
 * The read-only detail dialog behind the eye icon on the IVR list.
 * Ported from openDetail() in js/ivr.js and the #ivrDetailModal markup.
 *
 * Loads on open rather than on mount: the list renders ten of these buttons and
 * fetching every IVR's menu up front to fill a dialog nobody may open would be
 * ten round trips for nothing.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Modal from 'react-bootstrap/Modal';

import { IvrRepo, FlowRepo } from '../services/repo.js';
import { formatDateTime } from '../services/utils.js';
import { toast } from '../services/notify.js';
import StatusBadge from './ui/StatusBadge.jsx';

export default function IvrDetailModal({ id, onHide }) {
  const [record, setRecord] = useState(null);

  useEffect(() => {
    if (!id) {
      setRecord(null);
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const [ivr, options] = await Promise.all([IvrRepo.get(id), FlowRepo.list(id)]);
        // The dialog may have been closed while this was in flight; writing
        // state then would reopen it with stale content.
        if (!cancelled) setRecord({ ivr, options });
      } catch (error) {
        if (cancelled) return;
        toast({ title: 'IVR not found', text: error.message, tone: 'danger' });
        onHide();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, onHide]);

  const ivr = record?.ivr;
  const options = record?.options ?? [];
  const encoded = ivr ? encodeURIComponent(ivr.id) : '';

  return (
    <Modal show={Boolean(id)} onHide={onHide} centered size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title>{ivr?.name ?? 'IVR'}</Modal.Title>
      </Modal.Header>

      <Modal.Body>
        {!ivr ? (
          <span className="skeleton skeleton--wide" />
        ) : (
          <>
            <dl className="detail-list">
              <dt>Extension</dt>
              <dd>
                <span className="num-ext">{ivr.extension}</span>
              </dd>

              <dt>Status</dt>
              <dd>
                <StatusBadge status={ivr.status} />
              </dd>

              <dt>Description</dt>
              <dd>{ivr.description || '—'}</dd>

              <dt>Welcome audio</dt>
              <dd className="num">{ivr.welcomeAudio || 'None'}</dd>

              <dt>Created</dt>
              <dd>{formatDateTime(ivr.createdAt)}</dd>

              <dt>Last updated</dt>
              <dd>{formatDateTime(ivr.updatedAt)}</dd>
            </dl>

            <h3 className="tw-mt-6 tw-mb-3 tw-text-sm tw-font-semibold">
              Menu options <span className="tw-font-normal tw-text-muted">({options.length})</span>
            </h3>

            {options.length ? (
              <ul className="flow-list">
                {options.map((option) => (
                  <li className="flow-row" key={option.id}>
                    <span className="flow-row__digit" aria-hidden="true">
                      {option.digit}
                    </span>
                    <span className="flow-row__body">
                      <span className="flow-row__label">{option.label}</span>
                      <span className="flow-row__dest">
                        <i className="bi bi-arrow-return-right" aria-hidden="true" />
                        Extension <span className="num">{option.destination}</span>
                        {option.audioFile ? (
                          <span className="flow-row__audio">
                            <i className="bi bi-music-note-beamed" aria-hidden="true" />
                            {option.audioFile}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tw-mb-0 tw-text-sm tw-text-muted">
                No menu options yet. Add them on the edit screen so callers have something to choose.
              </p>
            )}
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Link className="btn btn-outline-secondary" to={`/test-ivr?id=${encoded}`}>
          <i className="bi bi-telephone-outbound" aria-hidden="true" /> Test this IVR
        </Link>
        <Link className="btn btn-primary" to={`/edit-ivr?id=${encoded}`}>
          <i className="bi bi-pencil" aria-hidden="true" /> Edit
        </Link>
      </Modal.Footer>
    </Modal>
  );
}
