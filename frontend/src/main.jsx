/**
 * Entry point. Replaces js/app.js.
 *
 * The stylesheets are imported here, in the same order the old pages linked
 * them, because that order is load-bearing: Bootstrap ships a reset, Tailwind's
 * utilities are prefixed `tw-` to avoid colliding with it, and style.css depends
 * on both being in place first. Reordering these changes the rendered result.
 *
 * StrictMode is deliberately on. It double-invokes effects in development, which
 * is exactly the pressure the phone needs to be under: an effect that tore down
 * the SIP connection on cleanup would show up here immediately rather than as a
 * dropped registration in production.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import '../public/assets/vendor/bootstrap/bootstrap.min.css';
import '../public/assets/vendor/bootstrap-icons/bootstrap-icons.min.css';
import '../public/assets/vendor/tailwind.css';
import './styles/style.css';
import './styles/dashboard.css';
import './styles/ivr.css';
import './styles/audio.css';
import './styles/phone.css';
import './styles/responsive.css';

import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
