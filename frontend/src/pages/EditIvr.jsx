/**
 * Edit IVR. Ported from pages/edit-ivr.html + initEdit() in js/ivr.js.
 *
 * Unlike Create, every menu change here writes through immediately — FlowRepo
 * reads the IVR, changes the one option and PUTs the whole menu back, which the
 * server applies in a single transaction. So the builder's callbacks are async
 * and the list is re-read after each one.
 *
 * The Sync to Asterisk button pushes what is *saved*, not what is typed: the
 * server reads from MySQL. Unsaved edits are therefore not pushed, which is the
 * safe way round — the dialplan should only ever reflect a record that survived
 * validation.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { IvrRepo, FlowRepo, ValidationError } from '../services/repo.js';
import { syncIvrToAsterisk } from '../services/api.js';
import { formatRelative } from '../services/utils.js';
import { toast, confirmDialog } from '../services/notify.js';
import IvrForm, { validateIvr } from '../components/IvrForm.jsx';
import FlowBuilder from '../components/FlowBuilder.jsx';

export default function EditIvr() {
  const [params] = useSearchParams();
  const id = params.get('id');
  const navigate = useNavigate();

  const [ivr, setIvr] = useState(null);
  // Seeded from the URL rather than discovered in an effect. With no ?id= there
  // is nothing to fetch and nothing to wait for, so rendering a loading skeleton
  // first would be a flash of the wrong answer.
  const [notFound, setNotFound] = useState(!id);
  const [values, setValues] = useState(null);
  const [errors, setErrors] = useState({});
  const [options, setOptions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [sync, setSync] = useState({ state: 'idle', text: '' });

  const load = useCallback(async () => {
    if (!id) {
      setNotFound(true);
      return;
    }
    try {
      const [record, menu] = await Promise.all([IvrRepo.get(id), FlowRepo.list(id)]);
      setIvr(record);
      setOptions(menu);
      setValues((current) =>
        // Keep whatever the user has typed; only seed the form on first load.
        current ?? {
          name: record.name,
          extension: record.extension,
          description: record.description,
          welcomeAudio: record.welcomeAudio,
          status: record.status,
        },
      );
    } catch {
      setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const reloadMenu = useCallback(async () => {
    setOptions(await FlowRepo.list(id));
  }, [id]);

  async function submit(event) {
    event.preventDefault();
    const found = validateIvr(values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    try {
      const updated = await IvrRepo.update(ivr.id, values);
      setIvr(updated);
      toast({ title: 'Changes saved', text: `${updated.name} has been updated.`, tone: 'ok' });
    } catch (error) {
      if (error instanceof ValidationError && error.field) {
        setErrors({ [error.field]: { message: error.message, fromServer: true } });
      } else {
        toast({ title: 'That could not be saved', text: error.message, tone: 'danger' });
      }
    } finally {
      setSaving(false);
    }
  }

  async function onSync() {
    setSync({ state: 'busy', text: 'Syncing…' });
    const result = await syncIvrToAsterisk(ivr.id);

    if (!result.success) {
      setSync({ state: 'danger', text: '✗ Sync failed' });
      toast({
        title: 'Sync failed',
        text: result.message || 'Asterisk could not be updated.',
        tone: 'danger',
        delay: 9000,
      });
      return;
    }

    setSync({ state: 'ok', text: '✓ Synced successfully' });

    // Sounds live on the web server; Asterisk plays from its own directory and
    // AMI cannot copy between them. Naming them is the difference between a
    // prompt that is silent for a known reason and one that is mysteriously so.
    const notes = [...(result.warnings ?? [])];
    if (result.unverified_sounds?.length) {
      notes.push(`Copy these prompts to Asterisk if they are not there already: ${result.unverified_sounds.join(', ')}.`);
    }
    toast({
      title: result.message,
      text: notes.join(' ') || 'The dialplan was written and reloaded.',
      tone: notes.length ? 'warn' : 'ok',
      delay: notes.length ? 9000 : 5000,
    });
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Delete ${ivr.name}?`,
      body:
        options.length > 0
          ? `Its ${options.length} menu option${options.length === 1 ? '' : 's'} will be deleted too. ` +
            'Callers dialling this extension will no longer reach anything.'
          : 'Callers dialling this extension will no longer reach anything.',
      confirmLabel: 'Delete IVR',
      tone: 'danger',
    });
    if (!ok) return;

    try {
      await IvrRepo.remove(ivr.id);
      toast({ title: 'IVR deleted', text: `${ivr.name} has been removed.`, tone: 'ok' });
      navigate('/ivr-list');
    } catch (error) {
      toast({ title: 'That could not be deleted', text: error.message, tone: 'danger' });
    }
  }

  if (notFound) {
    return (
      <section className="card">
        <div className="card-body">
          <div className="empty-state">
            <span className="empty-state__icon" aria-hidden="true">
              <i className="bi bi-question-lg" />
            </span>
            <p className="empty-state__title">That IVR could not be found</p>
            <p className="empty-state__body">It may have been deleted, or the link may be wrong.</p>
            <Link className="btn btn-primary btn-sm" to="/ivr-list">
              Back to the IVR list
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (!ivr || !values) {
    return <span className="skeleton skeleton--wide" />;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <nav aria-label="Breadcrumb">
            <ol className="breadcrumb">
              <li className="breadcrumb-item">
                <Link to="/dashboard">Dashboard</Link>
              </li>
              <li className="breadcrumb-item">
                <Link to="/ivr-list">IVR List</Link>
              </li>
              <li className="breadcrumb-item active" aria-current="page">
                {ivr.name}
              </li>
            </ol>
          </nav>
          <h1 className="page-header__title">{ivr.name}</h1>
          <p className="page-header__subtitle">
            Extension {ivr.extension}. Change the details, or build the menu callers hear.
          </p>
        </div>
        <div className="page-header__actions">
          {sync.text ? <span className={`sync-state sync-state--${sync.state}`}>{sync.text}</span> : null}
          <button className="btn btn-outline-secondary" type="button" onClick={onSync} disabled={sync.state === 'busy'}>
            <i className="bi bi-arrow-repeat" aria-hidden="true" /> Sync to Asterisk
          </button>
          <Link className="btn btn-outline-secondary" to={`/test-ivr?id=${encodeURIComponent(ivr.id)}`}>
            <i className="bi bi-telephone-outbound" aria-hidden="true" /> Test this IVR
          </Link>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-7">
          <form className="card" onSubmit={submit} noValidate>
            <div className="card-body">
              <IvrForm values={values} errors={errors} onChange={setValues} />
            </div>
            <div className="card-footer tw-flex tw-flex-wrap tw-items-center tw-justify-between tw-gap-2 tw-bg-transparent">
              <span className="tw-text-xs tw-text-muted">Last saved {formatRelative(ivr.updatedAt)}</span>
              <span className="tw-flex tw-gap-2">
                <button className="btn btn-outline-danger" type="button" onClick={remove}>
                  <i className="bi bi-trash3" aria-hidden="true" /> Delete
                </button>
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  <i className="bi bi-check-lg" aria-hidden="true" /> Save changes
                </button>
              </span>
            </div>
          </form>
        </div>

        <div className="col-12 col-xl-5">
          <section className="card h-100" aria-labelledby="flowHeading">
            <FlowBuilder
              options={options}
              onAdd={async (option) => {
                await FlowRepo.create(ivr.id, option);
                await reloadMenu();
                toast({ title: 'Option added', text: `Pressing ${option.digit} goes to ${option.label}.`, tone: 'ok' });
              }}
              onUpdate={async (target, option) => {
                await FlowRepo.update(ivr.id, target.id, option);
                await reloadMenu();
                toast({ title: 'Option saved', text: `Pressing ${option.digit} now goes to ${option.label}.`, tone: 'ok' });
              }}
              onRemove={async (target) => {
                await FlowRepo.remove(ivr.id, target.id);
                await reloadMenu();
                toast({ title: 'Option deleted', text: `Digit ${target.digit} is free again.`, tone: 'ok' });
              }}
            />
            <div className="card-footer tw-bg-transparent">
              <p className="tw-mb-0 tw-text-xs tw-text-muted">
                Changes here are live on the{' '}
                <Link to={`/test-ivr?id=${encodeURIComponent(ivr.id)}`}>Test IVR</Link> page immediately.
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
