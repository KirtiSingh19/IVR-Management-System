/**
 * Top bar. Ported from components/navbar.html.
 *
 * The search form used to be a GET to ivr-list.html so the result was a
 * shareable URL. That still holds — it navigates to /ivr-list?search=… — but
 * through the router, so the document is not reloaded and the phone keeps its
 * registration.
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../hooks/useAuth.js';
import { useSignOut } from '../hooks/useSignOut.js';

export default function Navbar({ onToggleSidebar }) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const { username } = useAuth();
  const [params] = useSearchParams();
  const [term, setTerm] = useState(params.get('search') ?? '');

  function onSubmit(event) {
    event.preventDefault();
    const query = term.trim();
    navigate(query ? `/ivr-list?search=${encodeURIComponent(query)}` : '/ivr-list');
  }

  return (
    <header className="app-topbar">
      <button
        className="topbar-toggle"
        type="button"
        onClick={onToggleSidebar}
        aria-controls="appSidebar"
        aria-label="Open navigation"
      >
        <i className="bi bi-list" aria-hidden="true" />
      </button>

      <form className="topbar-search" role="search" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="globalSearch">
          Search IVRs
        </label>
        <i className="bi bi-search" aria-hidden="true" />
        <input
          className="form-control"
          type="search"
          id="globalSearch"
          name="search"
          placeholder="Search IVRs by name or extension"
          autoComplete="off"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
      </form>

      {/* Top right. The search box is capped at 340px and does not grow, so the
          button is pushed over by margin-left:auto rather than by a flexible
          sibling. */}
      <button
        className="topbar-signout"
        type="button"
        onClick={signOut}
        title={username ? `Sign out ${username}` : 'Sign out'}
      >
        <i className="bi bi-box-arrow-right" aria-hidden="true" />
        <span className="topbar-signout__label">Sign out</span>
      </button>
    </header>
  );
}
