/**
 * The route guard.
 *
 * Renders <Navigate>, never window.location. That distinction is the whole
 * reason the phone survives: a location assignment would reload the document and
 * destroy the SIP module along with the registration and any call in progress.
 * A router navigation only swaps components.
 *
 * While the session check is in flight the guard renders nothing rather than
 * redirecting. Bouncing to the login screen and back is not just ugly — it
 * would unmount the whole shell on every reload.
 *
 * This is convenience, not security. The API rejects an unauthenticated request
 * on its own; removing this component would make the UI messy, not open.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';

export default function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'unknown') return null;
  if (status === 'out') {
    // Remember where they were headed, so signing in resumes it.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}
