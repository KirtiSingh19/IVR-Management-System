/**
 * Sidebar. Ported from components/sidebar.html.
 *
 * Same markup and same classes, so the existing CSS styles it unchanged. Two
 * things did have to change:
 *
 *   - `<a href>` becomes `<NavLink>`, because a real link would reload the
 *     document and take the SIP registration with it. That is the whole point of
 *     the migration.
 *   - The offcanvas, which Bootstrap's JS drove through data-bs-* attributes, is
 *     now react-bootstrap's <Offcanvas>, controlled by the parent. The rendered
 *     classes are identical.
 *
 * `is-active` is applied by NavLink rather than by the old markActiveNav().
 */

import { NavLink } from 'react-router-dom';
import Offcanvas from 'react-bootstrap/Offcanvas';

import { useAuth } from '../hooks/useAuth.js';

const SECTIONS = [
  {
    label: 'Manage',
    links: [
      { to: '/dashboard', icon: 'bi-grid-1x2', text: 'Dashboard' },
      { to: '/ivr-list', icon: 'bi-list-ul', text: 'IVR List' },
      { to: '/create-ivr', icon: 'bi-plus-square', text: 'Create IVR' },
      { to: '/audio-files', icon: 'bi-file-earmark-music', text: 'Audio Files' },
    ],
  },
  { label: 'Simulate', links: [{ to: '/test-ivr', icon: 'bi-telephone-outbound', text: 'Test IVR' }] },
  {
    label: 'Calls',
    links: [
      { to: '/phone', icon: 'bi-headset', text: 'Phone' },
      // Recordings are restricted, so the link is too. The server enforces it
      // regardless — this only keeps the nav honest about what is reachable.
      { to: '/call-history', icon: 'bi-record-circle', text: 'Call History', adminOnly: true },
    ],
  },
];

function Nav() {
  const { role } = useAuth();
  return (
    <nav className="sidebar-nav" aria-label="Sections">
      {SECTIONS.map((section) => (
        <div key={section.label}>
          <p className="sidebar-nav__label">{section.label}</p>
          {section.links.filter((link) => !link.adminOnly || role === 'admin').map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}
              aria-current={undefined}
            >
              <i className={`bi ${link.icon}`} aria-hidden="true" />
              <span>{link.text}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <NavLink className="sidebar-brand" to="/dashboard">
      <span className="sidebar-brand__mark" aria-hidden="true">
        <i className="bi bi-diagram-3-fill" />
      </span>
      <span>
        <span className="sidebar-brand__name">IVR Manager</span>
      </span>
    </NavLink>
  );
}

function Footer() {
  const { username } = useAuth();

  return (
    <div className="sidebar-footer">
      <div className="tw-flex tw-items-center tw-justify-between tw-gap-2">
        <span>Connected to MySQL</span>
        <span className="num">v0.2.0</span>
      </div>
      <p className="tw-mt-1 tw-mb-2">Served by the Python API.</p>

      {/* Who is signed in. The sign-out control itself lives in the top bar, so
          there is only ever one of them. */}
      <span className="sidebar-user" title={username ?? ''}>
        <i className="bi bi-person-circle" aria-hidden="true" /> {username}
      </span>
    </div>
  );
}

export default function Sidebar({ show, onHide }) {
  // One element, exactly as the original markup had it: `offcanvas-lg` is a
  // Bootstrap responsive offcanvas — a static sidebar from the lg breakpoint up,
  // a slide-in panel below it. react-bootstrap's `responsive` prop emits that
  // same class.
  //
  // Splitting this into a desktop <aside> plus a mobile <Offcanvas> was the first
  // attempt and it was wrong: it needed `lg:tw-flex`, which the project's
  // prebuilt tailwind.css does not contain, so the desktop sidebar would simply
  // never have appeared.
  return (
    <Offcanvas
      show={show}
      onHide={onHide}
      responsive="lg"
      placement="start"
      className="app-sidebar"
      aria-label="Main navigation"
    >
      <Offcanvas.Header closeButton closeVariant="white">
        <span className="sidebar-brand__name">IVR Manager</span>
      </Offcanvas.Header>
      <Brand />
      <Nav />
      <Footer />
    </Offcanvas>
  );
}
