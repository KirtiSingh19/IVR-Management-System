/** Page footer. Ported from components/footer.html, deliberately quiet. */
export default function Footer() {
  return (
    <footer className="tw-px-5 tw-py-4 tw-text-xs tw-text-muted tw-border-t tw-border-line">
      <div className="tw-flex tw-flex-wrap tw-items-center tw-justify-between tw-gap-2">
        <span>IVR Manager</span>
        <span className="tw-flex tw-items-center tw-gap-3">
          <span className="num" />
        </span>
      </div>
    </footer>
  );
}
