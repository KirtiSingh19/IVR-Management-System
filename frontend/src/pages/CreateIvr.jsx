/**
 * Create IVR. Ported from pages/create-ivr.html + initCreate() in js/ivr.js.
 *
 * Menu options are collected in memory and sent nested inside the create
 * request, so the IVR and its whole menu are written in one transaction on the
 * server. Either both land or neither does; a rejected menu never leaves a
 * half-made IVR behind.
 *
 * A failed save leaves the draft menu untouched, so a rejected extension can be
 * corrected and resubmitted without the options being typed again.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { IvrRepo, ValidationError } from '../services/repo.js';
import { uid } from '../services/utils.js';
import { toast } from '../services/notify.js';
import IvrForm, { validateIvr } from '../components/IvrForm.jsx';
import FlowBuilder from '../components/FlowBuilder.jsx';

const BLANK = { name: '', extension: '', description: '', welcomeAudio: '', status: 'active' };

export default function CreateIvr() {
  const navigate = useNavigate();
  const [values, setValues] = useState(BLANK);
  const [errors, setErrors] = useState({});
  const [menu, setMenu] = useState([]);
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();

    const found = validateIvr(values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    try {
      const ivr = await IvrRepo.create({
        ...values,
        menu: menu.map(({ digit, label, destination, audioFile }) => ({
          digit, label, destination, audioFile, destinationType: 'extension',
        })),
      });
      toast({
        title: 'IVR created',
        text: menu.length
          ? `${ivr.name} is on extension ${ivr.extension} with ${menu.length} menu option${menu.length === 1 ? '' : 's'}.`
          : `${ivr.name} is on extension ${ivr.extension}. Add its menu options next.`,
        tone: 'ok',
      });
      navigate(`/edit-ivr?id=${encodeURIComponent(ivr.id)}&created=1`);
    } catch (error) {
      setSaving(false);
      if (error instanceof ValidationError && error.field) {
        setErrors({ [error.field]: { message: error.message, fromServer: true } });
        return;
      }
      toast({ title: 'That could not be saved', text: error.message, tone: 'danger' });
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">Create IVR</h1>
          <p className="page-header__subtitle">
            Give the IVR a name and an extension, and add its menu options here if you already know
            them.
          </p>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-8">
          <form className="card" onSubmit={submit} noValidate>
            <div className="card-body">
              <IvrForm values={values} errors={errors} onChange={setValues} />

              <fieldset className="form-section">
                <div className="tw-flex tw-flex-wrap tw-items-start tw-justify-between tw-gap-2">
                  <div>
                    <legend className="form-section__title">Menu options</legend>
                    <p className="form-section__hint">
                      One entry per key the caller can press. Optional &mdash; you can add these
                      later on the edit screen.
                    </p>
                  </div>
                </div>

                {/* The draft builder: nothing is saved until the form is submitted,
                    so removing an option needs no confirmation. */}
                <FlowBuilder
                  options={menu}
                  confirmRemoval={false}
                  onAdd={(option) => setMenu((current) => [...current, { ...option, id: uid('draft') }])}
                  onUpdate={(target, option) =>
                    setMenu((current) => current.map((entry) => (entry.id === target.id ? { ...entry, ...option } : entry)))
                  }
                  onRemove={(target) => setMenu((current) => current.filter((entry) => entry.id !== target.id))}
                />
              </fieldset>
            </div>

            <div className="card-footer tw-flex tw-flex-wrap tw-justify-end tw-gap-2 tw-bg-transparent">
              <Link className="btn btn-outline-secondary" to="/ivr-list">
                Cancel
              </Link>
              <button className="btn btn-primary" type="submit" disabled={saving}>
                <i className="bi bi-check-lg" aria-hidden="true" />{' '}
                {menu.length ? `Create IVR with ${menu.length} option${menu.length === 1 ? '' : 's'}` : 'Create IVR'}
              </button>
            </div>
          </form>
        </div>

        <div className="col-12 col-xl-4">
          <aside className="card h-100" aria-labelledby="nextStepsHeading">
            <div className="card-header">
              <h2 id="nextStepsHeading">What happens next</h2>
            </div>
            <div className="card-body">
              <ol className="tw-m-0 tw-pl-5 tw-text-sm tw-flex tw-flex-col tw-gap-3 tw-text-muted">
                <li>
                  <span className="tw-block tw-font-medium tw-text-body">Create the IVR</span>
                  The IVR and any menu options you added are saved together, then it appears in the
                  list and the dashboard figures update.
                </li>
                <li>
                  <span className="tw-block tw-font-medium tw-text-body">Refine the menu</span>
                  You land on the edit screen, where options can be changed, added or removed.
                </li>
                <li>
                  <span className="tw-block tw-font-medium tw-text-body">Walk a call through it</span>
                  The Test IVR page dials your menu exactly as a caller would.
                </li>
              </ol>

              <hr className="tw-my-4" />

              <p className="tw-mb-0 tw-text-xs tw-text-muted">
                Nothing is sent to a switch. Records are saved to the MySQL database through the
                Python API, so they survive a reload and are shared by everyone using this server.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
