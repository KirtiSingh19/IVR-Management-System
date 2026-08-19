/**
 * IVR list. Ported from pages/ivr-list.html + the list half of js/ivr.js.
 *
 * The filter/sort/page settings were a mutable `listState` object that the old
 * controller wrote into before calling renderIvrTable(). Here they are ordinary
 * React state, and one effect re-reads whenever any of them changes — the same
 * behaviour, without the manual re-render calls.
 *
 * The search term still comes from the URL, so the global search box in the top
 * bar can deep-link into this page and the result stays shareable.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { IvrRepo, FlowRepo } from '../services/repo.js';
import { formatDate, formatRelative, initials } from '../services/utils.js';
import { toast, confirmDialog } from '../services/notify.js';
import StatusBadge from '../components/ui/StatusBadge.jsx';
import Pagination from '../components/ui/Pagination.jsx';
import SortHeader, { nextSort } from '../components/ui/SortHeader.jsx';
import { EmptyRow, SkeletonRows } from '../components/ui/TableStates.jsx';
import IvrDetailModal from '../components/IvrDetailModal.jsx';

const TABLE_COLUMNS = 7;

export default function IvrList() {
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState(() => ({
    search: params.get('search') ?? '',
    status: '',
    extensionPrefix: '',
    sort: 'createdAt',
    direction: 'desc',
    page: 1,
    pageSize: 10,
  }));

  const [result, setResult] = useState(null);
  const [menuCounts, setMenuCounts] = useState({});
  const [totalAll, setTotalAll] = useState(0);
  const [prefixes, setPrefixes] = useState([]);
  const [detailId, setDetailId] = useState(null);

  const filtered = Boolean(query.search || query.status || query.extensionPrefix);

  const load = useCallback(async () => {
    const [page, counts, all, availablePrefixes] = await Promise.all([
      IvrRepo.list(query),
      FlowRepo.countsByIvr(),
      IvrRepo.all(),
      IvrRepo.extensionPrefixes(),
    ]);
    setResult(page);
    setMenuCounts(counts);
    setTotalAll(all.length);
    setPrefixes(availablePrefixes);
  }, [query]);

  useEffect(() => {
    load();
    return IvrRepo.onChange(load);
  }, [load]);

  // Keep the URL in step with the search box, so the result stays shareable and
  // the back button behaves.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (query.search) next.set('search', query.search);
    else next.delete('search');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.search]);

  const update = (changes) => setQuery((current) => ({ ...current, page: 1, ...changes }));

  function clearFilters() {
    update({ search: '', status: '', extensionPrefix: '' });
  }

  async function deleteIvr(ivr) {
    const optionCount = (await FlowRepo.list(ivr.id)).length;
    const confirmed = await confirmDialog({
      title: `Delete ${ivr.name}?`,
      body:
        optionCount > 0
          ? `Its ${optionCount} menu option${optionCount === 1 ? '' : 's'} will be deleted too. ` +
            'Callers dialling this extension will no longer reach anything.'
          : 'Callers dialling this extension will no longer reach anything.',
      confirmLabel: 'Delete IVR',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await IvrRepo.remove(ivr.id);
      toast({ title: 'IVR deleted', text: `${ivr.name} has been removed.`, tone: 'ok' });
    } catch (error) {
      toast({ title: 'That could not be deleted', text: error.message, tone: 'danger' });
    }
  }

  const items = result?.items ?? [];
  const first = result ? (result.page - 1) * result.pageSize + 1 : 0;
  const last = result ? Math.min(result.page * result.pageSize, result.total) : 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-header__title">IVR List</h1>
          <p className="page-header__subtitle">Every IVR configured on this system.</p>
        </div>
        <div className="page-header__actions">
          <Link className="btn btn-primary" to="/create-ivr">
            <i className="bi bi-plus-lg" aria-hidden="true" /> Create IVR
          </Link>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <div className="toolbar">
            <div className="toolbar__search">
              <label className="visually-hidden" htmlFor="ivrSearch">
                Search IVRs
              </label>
              <i className="bi bi-search" aria-hidden="true" />
              <input
                className="form-control"
                type="search"
                id="ivrSearch"
                placeholder="Search by name, extension or description"
                autoComplete="off"
                value={query.search}
                onChange={(event) => update({ search: event.target.value })}
              />
            </div>

            <div className="toolbar__select">
              <label className="visually-hidden" htmlFor="ivrStatusFilter">
                Filter by status
              </label>
              <select
                className="form-select"
                id="ivrStatusFilter"
                value={query.status}
                onChange={(event) => update({ status: event.target.value })}
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            <div className="toolbar__select">
              <label className="visually-hidden" htmlFor="ivrExtensionFilter">
                Filter by extension range
              </label>
              <select
                className="form-select"
                id="ivrExtensionFilter"
                value={query.extensionPrefix}
                onChange={(event) => update({ extensionPrefix: event.target.value })}
              >
                <option value="">All extensions</option>
                {prefixes.map((prefix) => (
                  <option key={prefix} value={prefix}>
                    {prefix}xx range
                  </option>
                ))}
              </select>
            </div>

            {filtered && (
              <button className="btn btn-outline-secondary" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            )}

            <span className="toolbar__count">
              {filtered
                ? `${result?.total ?? 0} of ${totalAll} IVRs`
                : `${result?.total ?? 0} IVR${(result?.total ?? 0) === 1 ? '' : 's'}`}
            </span>
          </div>
        </div>

        <div className="table-responsive">
          <table className="table table-hover align-middle" id="ivrTable">
            <thead>
              <tr>
                <SortHeader
                  column="name"
                  label="IVR Name"
                  sort={query.sort}
                  direction={query.direction}
                  onSort={(column) => setQuery((c) => ({ ...c, ...nextSort(c, column), page: 1 }))}
                />
                <SortHeader
                  column="extension"
                  label="Extension"
                  sort={query.sort}
                  direction={query.direction}
                  onSort={(column) => setQuery((c) => ({ ...c, ...nextSort(c, column), page: 1 }))}
                />
                <th scope="col">Description</th>
                <th scope="col">Menu</th>
                <SortHeader
                  column="status"
                  label="Status"
                  sort={query.sort}
                  direction={query.direction}
                  onSort={(column) => setQuery((c) => ({ ...c, ...nextSort(c, column), page: 1 }))}
                />
                <SortHeader
                  column="createdAt"
                  label="Created"
                  sort={query.sort}
                  direction={query.direction}
                  onSort={(column) => setQuery((c) => ({ ...c, ...nextSort(c, column), page: 1 }))}
                />
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody id="ivrTableBody">
              {!result ? (
                <SkeletonRows columnCount={TABLE_COLUMNS} />
              ) : items.length === 0 ? (
                filtered ? (
                  <EmptyRow
                    columnCount={TABLE_COLUMNS}
                    icon="bi-search"
                    title="No IVRs match those filters"
                    body="Try a different search term, or clear the filters to see everything."
                  >
                    <button className="btn btn-outline-secondary btn-sm" type="button" onClick={clearFilters}>
                      Clear filters
                    </button>
                  </EmptyRow>
                ) : (
                  <EmptyRow
                    columnCount={TABLE_COLUMNS}
                    icon="bi-diagram-3"
                    title="No IVRs yet"
                    body="Create your first IVR and it will show up here."
                  >
                    <Link className="btn btn-primary btn-sm" to="/create-ivr">
                      <i className="bi bi-plus-lg" aria-hidden="true" /> Create IVR
                    </Link>
                  </EmptyRow>
                )
              ) : (
                items.map((ivr) => {
                  const description = ivr.description || '—';
                  return (
                    <tr key={ivr.id}>
                      <td>
                        <span className="ivr-cell">
                          <span className="ivr-cell__mark" aria-hidden="true">
                            {initials(ivr.name)}
                          </span>
                          <span className="ivr-cell__body">
                            <Link className="ivr-cell__name" to={`/edit-ivr?id=${encodeURIComponent(ivr.id)}`}>
                              {ivr.name}
                            </Link>
                            <span className="ivr-cell__id">Updated {formatRelative(ivr.updatedAt)}</span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="num-ext">{ivr.extension}</span>
                      </td>
                      <td className="cell-muted">
                        <span className="cell-clamp" title={description}>
                          {description}
                        </span>
                      </td>
                      <td className="cell-muted num">{menuCounts[ivr.id] ?? 0}</td>
                      <td>
                        <StatusBadge status={ivr.status} />
                      </td>
                      <td className="cell-muted num">{formatDate(ivr.createdAt)}</td>
                      <td>
                        <span className="row-actions">
                          <button
                            className="btn-icon"
                            type="button"
                            title={`View ${ivr.name}`}
                            aria-label={`View ${ivr.name}`}
                            onClick={() => setDetailId(ivr.id)}
                          >
                            <i className="bi bi-eye" aria-hidden="true" />
                          </button>
                          <Link
                            className="btn-icon"
                            to={`/edit-ivr?id=${encodeURIComponent(ivr.id)}`}
                            title={`Edit ${ivr.name}`}
                            aria-label={`Edit ${ivr.name}`}
                          >
                            <i className="bi bi-pencil" aria-hidden="true" />
                          </Link>
                          <Link
                            className="btn-icon"
                            to={`/test-ivr?id=${encodeURIComponent(ivr.id)}`}
                            title={`Test ${ivr.name}`}
                            aria-label={`Test ${ivr.name}`}
                          >
                            <i className="bi bi-telephone-outbound" aria-hidden="true" />
                          </Link>
                          <button
                            className="btn-icon btn-icon--danger"
                            type="button"
                            title={`Delete ${ivr.name}`}
                            aria-label={`Delete ${ivr.name}`}
                            onClick={() => deleteIvr(ivr)}
                          >
                            <i className="bi bi-trash3" aria-hidden="true" />
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="card-footer">
          <span className="tw-text-xs tw-text-muted">
            {result?.total ? `Showing ${first}–${last} of ${result.total}` : 'Nothing to show'}
          </span>
          <nav aria-label="IVR list pages">
            <Pagination
              page={result?.page ?? 1}
              pageCount={result?.pageCount ?? 1}
              onChange={(page) => setQuery((current) => ({ ...current, page }))}
            />
          </nav>
        </div>
      </section>

      <IvrDetailModal id={detailId} onHide={() => setDetailId(null)} />
    </>
  );
}
