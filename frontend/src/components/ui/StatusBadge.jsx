/**
 * One status vocabulary for the whole product, ported from ui.js statusBadge().
 * The dot is decorative; the word carries the meaning, so the badge never
 * depends on colour alone.
 */
const TONES = {
  active: { tone: 'ok', label: 'Active' },
  inactive: { tone: 'neutral', label: 'Inactive' },
  ready: { tone: 'ok', label: 'Ready' },
  processing: { tone: 'warn', label: 'Processing' },
  error: { tone: 'danger', label: 'Error' },
};

export default function StatusBadge({ status }) {
  const { tone, label } = TONES[status] ?? { tone: 'neutral', label: status ?? 'Unknown' };
  return (
    <span className={`status status--${tone}`}>
      <span className="status__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
