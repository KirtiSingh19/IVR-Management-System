/**
 * React's view of the SIP service.
 *
 * The single most important line in this file is the cleanup: it removes a
 * *listener* and nothing else. It must never call disconnect(), unregister() or
 * anything that touches the UserAgent.
 *
 * That is what makes the registration survive React. The service is a module
 * singleton living outside the component tree, so the WebSocket and the
 * RTCPeerConnection belong to the module, not to any component. Unmounting the
 * Phone page — by navigating to Edit IVR, or by React remounting under
 * StrictMode — detaches a subscriber and leaves the call up.
 *
 * The usual instinct is to treat a connection opened "for" a component as that
 * component's to close. Here that instinct is the bug: the connection is not
 * the component's, and the only things that may end it are the Unregister
 * button and the transport genuinely dropping.
 */

import { useEffect, useState } from 'react';
import * as phone from '../services/phone-service.js';

/**
 * Subscribe to the phone's state.
 *
 * @returns {object} the current registration and call state, re-rendering on change
 */
export function usePhone() {
  const [state, setState] = useState(() => phone.current());

  useEffect(() => {
    // subscribe() fires immediately with the current state, so a component
    // mounting mid-call paints the live call rather than an empty dialer.
    const unsubscribe = phone.subscribe(setState);
    return unsubscribe; // Detaches this listener. Nothing else.
  }, []);

  return state;
}

/** The service's actions, so components never import it directly. */
export { phone };
