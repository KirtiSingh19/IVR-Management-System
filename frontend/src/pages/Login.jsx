/**
 * Sign in.
 *
 * Built from the same classes as the rest of the app — card, form-control,
 * invalid-feedback, btn-primary — so it looks like it belongs rather than like a
 * bolted-on gate. It renders outside the shell: there is no sidebar to navigate
 * with until you are signed in.
 *
 * The error message never distinguishes an unknown username from a wrong
 * password, because the server does not either. Telling someone which half they
 * got right is how account lists get harvested.
 */

import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useAuth, auth } from '../hooks/useAuth.js';

export default function Login() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Already signed in — go where they were headed, or the dashboard.
  if (status === 'in') {
    return <Navigate to={location.state?.from ?? '/dashboard'} replace />;
  }

  async function submit(event) {
    event.preventDefault();
    setError('');

    if (!username.trim() || !password) {
      setError('Enter a username and password.');
      return;
    }

    setBusy(true);
    const result = await auth.login(username.trim(), password);
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      // Keep the username so only the wrong half has to be retyped.
      setPassword('');
      return;
    }

    // Router navigation, never window.location: a document reload here would
    // destroy the SIP module along with any registration made before signing out.
    navigate(location.state?.from ?? '/dashboard', { replace: true });
  }

  return (
    <div className="login-shell">
      <main className="login-card">
        <div className="login-brand">
          <span className="sidebar-brand__mark" aria-hidden="true">
            <i className="bi bi-diagram-3-fill" />
          </span>
          <span className="sidebar-brand__name">IVR Manager</span>
        </div>

        <section className="card">
          <div className="card-body">
            <h1 className="page-header__title tw-mb-1">Sign in</h1>
            <p className="page-header__subtitle tw-mb-4">
              Your IVRs, prompts and browser phone are behind this.
            </p>

            <form onSubmit={submit} noValidate>
              {error ? (
                <div className="alert alert-danger" role="alert">
                  {error}
                </div>
              ) : null}

              <div className="mb-3">
                <label className="form-label" htmlFor="loginUsername">
                  Username
                </label>
                <input
                  className="form-control"
                  type="text"
                  id="loginUsername"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>

              <div className="mb-4">
                <label className="form-label" htmlFor="loginPassword">
                  Password
                </label>
                <input
                  className="form-control"
                  type="password"
                  id="loginPassword"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              <button className="btn btn-primary tw-w-full" type="submit" disabled={busy}>
                <i className="bi bi-box-arrow-in-right" aria-hidden="true" />{' '}
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
        </section>

        <p className="login-hint">
          No account yet? Create one on the server with{' '}
          <span className="num">python manage_users.py add &lt;username&gt;</span>
        </p>
      </main>
    </div>
  );
}