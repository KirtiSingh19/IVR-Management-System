/**
 * Application shell and single entry point.
 *
 * Every page loads this one module. It injects the shared chrome, marks the
 * current section, wires the global actions, then hands control to the
 * controller for that page.
 *
 * A page declares which controller it wants with `data-page` on <body>:
 *     <body data-page="ivr-list">
 * and needs no script tag of its own.
 *
 * Shared UI services (toasts, confirmation dialog, table helpers) live in
 * js/ui.js, so controllers can use them without importing this module.
 */

import { qs, qsa, formatBytes } from './utils.js';
import { seedIfEmpty, clearLocalBackup, isPersistent, usageBytes } from './storage.js';
import { runMigration } from './migrate.js';
import { resume as resumePhone } from './phone-service.js';
import { toast, confirmDialog } from './ui.js';

/**
 * Component and asset paths resolve against this module's own URL rather than
 * against the document, so pages work from any directory depth.
 */
const ROOT = new URL('../', import.meta.url);

/** Which sidebar entry to light up for each page. */
const NAV_FOR_PAGE = {
  dashboard: 'dashboard',
  'ivr-list': 'ivr-list',
  'create-ivr': 'create-ivr',
  'edit-ivr': 'ivr-list', // editing is part of managing the list
  'audio-files': 'audio-files',
  'test-ivr': 'test-ivr',
  phone: 'phone',
};

/**
 * Controllers are imported on demand, so each page downloads and parses only
 * the module it uses. Every controller exports an async init().
 */
const CONTROLLERS = {
  dashboard: () => import('./dashboard.js'),
  'ivr-list': () => import('./ivr.js'),
  'create-ivr': () => import('./ivr.js'),
  'edit-ivr': () => import('./ivr.js'),
  'audio-files': () => import('./audio.js'),
  'test-ivr': () => import('./test-ivr.js'),
  phone: () => import('./phone.js'),
};

/* ==========================================================================
   Shell assembly
   ========================================================================== */

/**
 * Replace every [data-include="name"] placeholder with components/name.html.
 *
 * Fetched in parallel: the partials are independent, so requesting them one
 * after another would add latency for no reason.
 */
async function injectComponents() {
  await Promise.all(
    qsa('[data-include]').map(async (placeholder) => {
      const name = placeholder.dataset.include;
      try {
        const response = await fetch(new URL(`components/${name}.html`, ROOT));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        placeholder.outerHTML = await response.text();
      } catch (error) {
        // Remove the placeholder rather than leaving an empty box in the layout.
        console.error(`[app] could not load the ${name} component`, error);
        placeholder.remove();
      }
    }),
  );
}

/** Light up the sidebar entry for the current page. */
function markActiveNav(page) {
  const target = NAV_FOR_PAGE[page];
  qsa('.sidebar-link').forEach((link) => {
    const isActive = link.dataset.nav === target;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/** Prefill the global search box when the page was reached from a search. */
function restoreGlobalSearch() {
  const term = new URLSearchParams(window.location.search).get('search');
  const input = qs('#globalSearch');
  if (input && term) input.value = term;
}

/**
 * Report where data lives, and how much of it there is.
 *
 * Everything the user creates is in MySQL now, so the meter reports the size of
 * the pre-migration backup rather than of live data — which is the only thing
 * browser storage still holds. Once that backup is cleared it says so instead of
 * displaying a meaningless "0 KB".
 */
function reportStorageState() {
  const note = qs('[data-storage-note]');
  if (note && !isPersistent) {
    note.textContent = 'Browser storage is blocked, so no local backup is being kept.';
  }
  const usage = qs('[data-storage-usage]');
  if (usage) {
    const bytes = usageBytes();
    usage.textContent = bytes
      ? `MySQL · ${formatBytes(bytes)} backup still in this browser`
      : 'MySQL · no local copy';
  }
}

/** Actions that live in the shared chrome rather than on any one page. */
function wireGlobalActions() {
  qs('[data-action="reset-demo"]')?.addEventListener('click', async () => {
    // Every record this used to reset now lives on the server, so "reset the demo
    // data" would clear nothing the user can see. What browser storage still
    // holds is the pre-migration backup, and removing that is a real, useful
    // action — it is the step the migration deliberately left until last.
    const confirmed = await confirmDialog({
      title: 'Clear the browser backup?',
      body:
        'Your IVRs, menus and audio prompts were copied to MySQL and are served from there. ' +
        'This removes the original copies still held in this browser. Nothing on the server is ' +
        'touched, and the app will look exactly the same afterwards.',
      confirmLabel: 'Clear backup',
      tone: 'danger',
    });
    if (!confirmed) return;

    clearLocalBackup();
    toast({
      title: 'Browser backup cleared',
      text: 'Everything now comes from MySQL.',
      tone: 'ok',
    });
    setTimeout(() => window.location.reload(), 600);
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function boot() {
  const page = document.body.dataset.page;

  // Seeds the local audio library, and on a first run also lays down the demo
  // IVRs that the migration below then hands to MySQL.
  seedIfEmpty();

  // Started now and awaited just before the controller runs, so it overlaps with
  // fetching the shared chrome instead of adding its round trip to the page load.
  // It must finish first, though: a controller that read the list mid-migration
  // would render a table that is missing rows.
  const migration = runMigration().catch((error) => {
    // runMigration handles its own expected failures. Anything reaching here is
    // a bug in it, and it must not stop the rest of the page from starting.
    console.error('[app] the migration check failed unexpectedly', error);
  });

  await injectComponents();
  markActiveNav(page);
  restoreGlobalSearch();
  reportStorageState();
  wireGlobalActions();

  // The phone lives outside any one page. Started on every page so a registered
  // extension stays registered while the rest of the app is used — see
  // js/phone-service.js for why that cannot be done from phone.html alone.
  resumePhone();

  await migration;

  // Chrome is in place, so reveal the page. Done before the controller runs so
  // a slow controller cannot hold the whole page blank.
  document.body.classList.add('is-ready');

  const load = CONTROLLERS[page];
  if (!load) return;

  try {
    const controller = await load();
    await controller.init?.();
  } catch (error) {
    console.error(`[app] the "${page}" page failed to start`, error);
    toast({
      title: 'This page could not load',
      text: 'Reload to try again. The details are in the browser console.',
      tone: 'danger',
      delay: 8000,
    });
  }
}

// Module scripts are deferred, so the document is normally parsed by now. The
// guard covers the case where this module is imported some other way.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}