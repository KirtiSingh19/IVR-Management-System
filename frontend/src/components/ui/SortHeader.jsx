/**
 * A sortable column header, ported from ui.js markSortState/nextSort.
 * aria-sort is what assistive tech reads; the chevron is its visual echo.
 */
export function nextSort(current, clickedColumn) {
  if (current.sort !== clickedColumn) return { sort: clickedColumn, direction: 'asc' };
  return { sort: clickedColumn, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

export default function SortHeader({ column, label, sort, direction, onSort, className = '' }) {
  const sorted = sort === column;
  return (
    <th scope="col" className={className} aria-sort={sorted ? `${direction}ending` : 'none'}>
      <button type="button" className="th-sort" onClick={() => onSort(column)}>
        {label}{' '}
        <i aria-hidden="true" className={sorted ? `bi bi-chevron-${direction === 'asc' ? 'up' : 'down'}` : 'bi bi-chevron-expand'} />
      </button>
    </th>
  );
}
