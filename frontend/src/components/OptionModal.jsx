/**
 * Add or edit one menu option. Ported from the #optionModal markup and the
 * dialog halves of js/flow-builder.js and js/menu-draft.js.
 *
 * Digits already spoken for are disabled in the select, so the usual collision
 * never arises — but the rule is checked again on submit, because a keyboard
 * user can submit a form that went stale while it was open, and because on the
 * edit page another tab could have taken a digit in the meantime.
 */

import { useEffect, useState } from 'react';
import Modal from 'react-bootstrap/Modal';

import { validateDigit, validateLabel, validateExtension } from '../services/utils.js';
import AudioSelect from './AudioSelect.jsx';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

const EMPTY = { digit: '', label: '', destination: '', audioFile: '' };

export default function OptionModal({ option, takenDigits, onHide, onSave }) {
  const open = Boolean(option);
  const editing = Boolean(option?.id);

  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  // Reset every time the dialog opens, so a cancelled edit never leaks into the
  // next one.
  useEffect(() => {
    if (!open) return;
    const firstFree = DIGITS.find((digit) => !takenDigits.includes(digit)) ?? '';
    setValues({
      digit: option.digit ?? firstFree,
      label: option.label ?? '',
      destination: option.destination ?? '',
      audioFile: option.audioFile ?? '',
    });
    setErrors({});
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, option?.id]);

  async function submit(event) {
    event.preventDefault();

    const found = {
      digit: validateDigit(values.digit),
      label: validateLabel(values.label),
      // A destination is an extension, so it obeys the same rule as an IVR's own.
      destination: validateExtension(values.destination),
    };
    if (!found.digit && takenDigits.includes(String(values.digit).trim())) {
      found.digit = `Digit ${values.digit} is already assigned to another option.`;
    }

    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    setSaving(true);
    try {
      await onSave({
        digit: String(values.digit).trim(),
        label: values.label.trim(),
        destination: values.destination.trim(),
        audioFile: values.audioFile,
      });
    } catch (error) {
      // A repository rejection lands on the field that caused it, which for a
      // menu is almost always the digit.
      setErrors({ digit: error.message });
      setSaving(false);
    }
  }

  return (
    <Modal show={open} onHide={onHide} centered>
      <form onSubmit={submit}>
        <Modal.Header closeButton>
          <Modal.Title>{editing ? 'Edit menu option' : 'Add menu option'}</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          <p className="tw-mb-4 tw-text-sm tw-text-muted">
            Choose the key the caller presses and where the call goes when they press it.
          </p>

          <div className="mb-3">
            <label className="form-label" htmlFor="optionDigit">
              Digit
            </label>
            <select
              className={`form-select${errors.digit ? ' is-invalid' : ''}`}
              id="optionDigit"
              value={values.digit}
              onChange={(event) => setValues({ ...values, digit: event.target.value })}
            >
              {DIGITS.map((digit) => {
                const taken = takenDigits.includes(digit);
                return (
                  <option key={digit} value={digit} disabled={taken}>
                    {taken ? `${digit} — already used` : digit}
                  </option>
                );
              })}
            </select>
            <div className="invalid-feedback">{errors.digit}</div>
          </div>

          <div className="mb-3">
            <label className="form-label" htmlFor="optionLabel">
              Label
            </label>
            <input
              className={`form-control${errors.label ? ' is-invalid' : ''}`}
              type="text"
              id="optionLabel"
              placeholder="Sales"
              maxLength={40}
              value={values.label}
              onChange={(event) => setValues({ ...values, label: event.target.value })}
            />
            <div className="form-text">What this option is called when the menu is read out.</div>
            <div className="invalid-feedback">{errors.label}</div>
          </div>

          <div className="mb-3">
            <label className="form-label" htmlFor="optionDestination">
              Destination
            </label>
            <input
              className={`form-control num${errors.destination ? ' is-invalid' : ''}`}
              type="text"
              id="optionDestination"
              placeholder="5001"
              inputMode="numeric"
              maxLength={6}
              value={values.destination}
              onChange={(event) => setValues({ ...values, destination: event.target.value })}
            />
            <div className="form-text">The extension this option transfers the call to.</div>
            <div className="invalid-feedback">{errors.destination}</div>
          </div>

          <div className="mb-0">
            <label className="form-label" htmlFor="optionAudio">
              Audio <span className="tw-text-muted tw-font-normal">(optional)</span>
            </label>
            <AudioSelect
              id="optionAudio"
              value={values.audioFile}
              onChange={(value) => setValues({ ...values, audioFile: value })}
              emptyLabel="No audio — transfer silently"
            />
            <div className="form-text">
              Played after the caller presses this key, while the call is transferred. Leave unset to
              transfer in silence.
            </div>
          </div>
        </Modal.Body>

        <Modal.Footer>
          <button type="button" className="btn btn-outline-secondary" onClick={onHide}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {editing ? 'Save option' : 'Add option'}
          </button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
