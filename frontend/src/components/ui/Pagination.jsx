/**
 * Pagination, ported from ui.js renderPagination().
 *
 * Long ranges collapse around the current page so the control never wraps onto
 * a second line: first, last, current and its immediate neighbours are shown and
 * the rest becomes an ellipsis.
 */
import { Fragment } from 'react';

export default function Pagination({ page, pageCount, onChange }) {
  if (pageCount <= 1) return null;

  const wanted = new Set([1, pageCount, page, page - 1, page + 1]);
  const visible = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);

  const Item = ({ label, target, disabled, active, ariaLabel }) => (
    <li className={`page-item${disabled ? ' disabled' : ''}${active ? ' active' : ''}`}>
      <button
        className="page-link"
        type="button"
        disabled={disabled}
        aria-current={active ? 'page' : undefined}
        aria-label={ariaLabel}
        onClick={() => onChange(target)}
      >
        {label}
      </button>
    </li>
  );

  return (
    <ul className="pagination">
      <Item
        label={<i className="bi bi-chevron-left" />}
        target={page - 1}
        disabled={page === 1}
        ariaLabel="Previous page"
      />
      {visible.map((n, index) => (
        <Fragment key={n}>
          {index > 0 && n - visible[index - 1] > 1 ? (
            <li className="page-item disabled">
              <span className="page-link">&hellip;</span>
            </li>
          ) : null}
          <Item label={String(n)} target={n} active={n === page} ariaLabel={`Page ${n}`} />
        </Fragment>
      ))}
      <Item
        label={<i className="bi bi-chevron-right" />}
        target={page + 1}
        disabled={page === pageCount}
        ariaLabel="Next page"
      />
    </ul>
  );
}
