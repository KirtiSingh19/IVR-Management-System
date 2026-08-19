/**
 * Signing out, in one place.
 *
 * There are now two controls that can do it, and the *order* here matters
 * enough that duplicating it would be a bug waiting to happen: the SIP
 * registration is dropped before the session is ended.
 *
 * Leaving 9001 registered after sign-out would keep this browser taking calls
 * for an extension nobody is signed in to, and the next person to sign in would
 * inherit it. Sign-out is an explicit user action, so this is consistent with
 * "only unregister when the user asks", not an exception to it.
 *
 * navigate(), never window.location: a document reload would tear down the SIP
 * module that the rest of the app depends on.
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { auth } from './useAuth.js';
import { phone } from './usePhone.js';

export function useSignOut() {
  const navigate = useNavigate();

  return useCallback(async () => {
    await phone.unregister();
    await auth.logout();
    navigate('/login', { replace: true });
  }, [navigate]);
}