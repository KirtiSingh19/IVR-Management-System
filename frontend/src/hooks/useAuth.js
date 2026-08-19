/**
 * React's view of the session.
 *
 * As with usePhone, the cleanup detaches a listener and nothing else — it never
 * logs anybody out. A component unmounting is not a sign-out.
 */
import { useEffect, useState } from 'react';
import * as auth from '../services/auth.js';

export function useAuth() {
  const [state, setState] = useState(() => auth.current());
  useEffect(() => auth.subscribe(setState), []);
  return state;
}

export { auth };
