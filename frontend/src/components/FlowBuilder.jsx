/**
 * The menu attached to an IVR: one row per key the caller can press.
 *
 * Merges js/flow-builder.js and js/menu-draft.js, which were deliberately kept
 * apart in the vanilla app because their storage models differed — one persisted
 * every edit against a known IVR id, the other could not persist at all because
 * the IVR did not exist yet. They shared markup by importing renderOptionRow
 * across files.
 *
 * In React that split stops paying for itself: the difference is entirely "what
 * happens on save", which is one prop. The create page passes an onChange that
 * collects options in memory; the edit page passes one that writes through
 * FlowRepo. Everything visible is shared by construction rather than by
 * discipline.
 *
 * The single business rule is unchanged: a caller can only press one key, so a
 * digit can only mean one thing. Taken digits are disabled in the dialog, and
 * the rule is checked again on submit because a keyboard user can submit a stale
 * form.
 */

import { useState } from 'react';
import { confirmDialog } from '../services/notify.js';
import OptionModal from './OptionModal.jsx';

/** Ordered by digit, so the list reads in the order a caller hears it. */
function byDigit(a, b) {
  return String(a.digit).localeCompare(String(b.digit), undefined, { numeric: true });
}

export default function FlowBuilder({ options, onAdd, onUpdate, onRemove, confirmRemoval = true }) {
  const [editing, setEditing] = useState(null); // null = closed, {} = adding
  const sorted = [...options].sort(byDigit);

  async function remove(option) {
    if (confirmRemoval) {
      const ok = await confirmDialog({
        title: `Delete option ${option.digit}?`,
        body: `Callers pressing ${option.digit} will hear the invalid-option prompt instead of reaching ${option.label}.`,
        confirmLabel: 'Delete option',
        tone: 'danger',
      });
      if (!ok) return;
    }
    await onRemove(option);
  }

  return (
    <>
      <div className="card-header">
        <div>
          <h2 id="flowHeading">Menu options</h2>
          <p className="card-header__hint">One entry per key the caller can press</p>
        </div>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setEditing({})}>
          <i className="bi bi-plus-lg" aria-hidden="true" /> Add option
        </button>
      </div>

      <div className="card-body">
        {sorted.length === 0 ? (
          <div className="empty-state tw-py-8">
            <span className="empty-state__icon" aria-hidden="true">
              <i className="bi bi-list-ol" />
            </span>
            <p className="empty-state__title">This menu is empty</p>
            <p className="empty-state__body">
              Callers will hear the welcome prompt and nothing else. Add an option to give them
              somewhere to go.
            </p>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => setEditing({})}>
              <i className="bi bi-plus-lg" aria-hidden="true" /> Add option
            </button>
          </div>
        ) : (
          <ul className="flow-list">
            {sorted.map((option) => (
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
                <span className="flow-row__actions">
                  <button
                    className="btn-icon"
                    type="button"
                    title={`Edit option ${option.digit}`}
                    aria-label={`Edit option ${option.digit}, ${option.label}`}
                    onClick={() => setEditing(option)}
                  >
                    <i className="bi bi-pencil" aria-hidden="true" />
                  </button>
                  <button
                    className="btn-icon btn-icon--danger"
                    type="button"
                    title={`Delete option ${option.digit}`}
                    aria-label={`Delete option ${option.digit}, ${option.label}`}
                    onClick={() => remove(option)}
                  >
                    <i className="bi bi-trash3" aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <OptionModal
        option={editing}
        takenDigits={sorted
          .filter((option) => option.id !== editing?.id)
          .map((option) => String(option.digit))}
        onHide={() => setEditing(null)}
        onSave={async (values) => {
          if (editing?.id) await onUpdate(editing, values);
          else await onAdd(values);
          setEditing(null);
        }}
      />
    </>
  );
}
