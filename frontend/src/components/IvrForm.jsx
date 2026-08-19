/**
 * The IVR detail form, shared by Create and Edit.
 *
 * js/ivr.js had one IVR_VALIDATORS map and one readIvrForm() used by both pages,
 * which is why the two screens never drifted apart. Same idea here: one
 * component, so a rule added for Create automatically applies to Edit.
 *
 * Fields validate on blur rather than on every keystroke — telling someone their
 * name is too short while they are still typing it is noise, not help.
 */

import { useState } from 'react';
import { validateName, validateExtension, validateDescription } from '../services/utils.js';
import AudioSelect from './AudioSelect.jsx';

const VALIDATORS = {
  name: validateName,
  extension: validateExtension,
  description: validateDescription,
};

export function validateIvr(values) {
  const errors = {};
  for (const [field, validate] of Object.entries(VALIDATORS)) {
    const message = validate(values[field]);
    if (message) errors[field] = message;
  }
  return errors;
}

export default function IvrForm({ values, errors, onChange, onBlurField }) {
  const [touched, setTouched] = useState({});

  const field = (name) => ({
    value: values[name],
    onChange: (event) => onChange({ ...values, [name]: event.target.value }),
    onBlur: () => {
      setTouched((current) => ({ ...current, [name]: true }));
      onBlurField?.(name);
    },
  });

  // A server-side error (a duplicate extension, say) shows immediately; a
  // client-side one waits until the field has been left.
  const errorFor = (name) => (touched[name] || errors[name]?.fromServer ? errors[name]?.message ?? errors[name] : null);
  const invalid = (name) => (errorFor(name) ? ' is-invalid' : '');

  return (
    <>
      <fieldset className="form-section">
        <legend className="form-section__title">Identity</legend>
        <p className="form-section__hint">How this IVR is listed, and how callers reach it.</p>

        <div className="row g-3">
          <div className="col-12 col-md-7">
            <label className="form-label" htmlFor="ivrName">
              IVR name
            </label>
            <input
              className={`form-control${invalid('name')}`}
              type="text"
              id="ivrName"
              placeholder="Main IVR"
              maxLength={60}
              autoComplete="off"
              required
              {...field('name')}
            />
            <div className="invalid-feedback">{errorFor('name')}</div>
          </div>

          <div className="col-12 col-md-5">
            <label className="form-label" htmlFor="ivrExtension">
              Extension
            </label>
            <div className="input-group">
              <span className="input-group-text">Dial</span>
              <input
                className={`form-control num${invalid('extension')}`}
                type="text"
                id="ivrExtension"
                placeholder="5000"
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                required
                {...field('extension')}
              />
            </div>
            <div className="form-text">3 to 6 digits, and unique across the system.</div>
            <div className="invalid-feedback tw-block">{errorFor('extension')}</div>
          </div>

          <div className="col-12">
            <label className="form-label" htmlFor="ivrDescription">
              Description
            </label>
            <textarea
              className={`form-control${invalid('description')}`}
              id="ivrDescription"
              rows={2}
              maxLength={160}
              placeholder="Main company IVR"
              {...field('description')}
            />
            <div className="form-text">
              Optional. Shown in the IVR list so colleagues know what this one is for.
            </div>
            <div className="invalid-feedback">{errorFor('description')}</div>
          </div>
        </div>
      </fieldset>

      <fieldset className="form-section">
        <legend className="form-section__title">Behaviour</legend>
        <p className="form-section__hint">What the caller hears, and whether the IVR answers.</p>

        <div className="row g-3">
          <div className="col-12 col-md-7">
            <label className="form-label" htmlFor="ivrWelcomeAudio">
              Welcome audio
            </label>
            <AudioSelect
              id="ivrWelcomeAudio"
              value={values.welcomeAudio}
              onChange={(value) => onChange({ ...values, welcomeAudio: value })}
              emptyLabel="No welcome audio"
            />
            <div className="form-text">
              Played once, before the menu. Manage prompts on the Audio Files page.
            </div>
          </div>

          <div className="col-12 col-md-5">
            <label className="form-label" htmlFor="ivrStatus">
              Status
            </label>
            <select
              className="form-select"
              id="ivrStatus"
              value={values.status}
              onChange={(event) => onChange({ ...values, status: event.target.value })}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <div className="form-text">Inactive IVRs keep their configuration but do not answer.</div>
          </div>
        </div>
      </fieldset>
    </>
  );
}
