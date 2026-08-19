/** Placeholder rows, ported from ui.js tableSkeletonRows/tableEmptyRow. */

export function SkeletonRows({ columnCount, rowCount = 5 }) {
  return Array.from({ length: rowCount }, (_, row) => (
    <tr key={row}>
      {Array.from({ length: columnCount }, (_, cell) => (
        <td key={cell}>
          <span className="skeleton skeleton--wide" />
        </td>
      ))}
    </tr>
  ));
}

/**
 * The row a table shows when it has nothing to list.
 *
 * An empty screen is an invitation to act, so it always offers one, and the
 * message distinguishes "nothing here yet" from "nothing matched your filters".
 */
export function EmptyRow({ columnCount, icon, title, body, children }) {
  return (
    <tr>
      <td colSpan={columnCount}>
        <div className="empty-state">
          <span className="empty-state__icon" aria-hidden="true">
            <i className={`bi ${icon}`} />
          </span>
          <p className="empty-state__title">{title}</p>
          <p className="empty-state__body">{body}</p>
          {children}
        </div>
      </td>
    </tr>
  );
}
