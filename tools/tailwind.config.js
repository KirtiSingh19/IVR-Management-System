/**
 * Tailwind build config — AUTHORING TIME ONLY.
 *
 * This file is never shipped and never runs in the browser or in Docker.
 * It is used once, on a developer machine, to compile ./tools/tailwind-input.css
 * into ./assets/vendor/tailwind.css, which is the file the site actually loads.
 *
 * Regenerate with (from the project root):
 *   npx -y tailwindcss@3.4.17 -c tools/tailwind.config.js -i tools/tailwind-input.css -o assets/vendor/tailwind.css --minify
 *
 * Two settings below are load-bearing and must not be removed:
 *
 *  1. prefix: 'tw-'      Every utility is emitted as .tw-flex, .tw-gap-4, etc.
 *                        Without this, Tailwind classes such as .border, .flex and
 *                        .hidden collide with Bootstrap's own utilities of the
 *                        same name and the winner depends on stylesheet order.
 *
 *  2. preflight: false   Preflight is Tailwind's global CSS reset. Bootstrap ships
 *                        its own reset (Reboot). Loading both means the second one
 *                        silently undoes the first — buttons, headings and form
 *                        controls all lose their Bootstrap base styling.
 */
module.exports = {
  prefix: 'tw-',
  corePlugins: {
    preflight: false,
  },
  // Tailwind only emits utilities it can actually find in these files.
  // Paths are resolved from the project root, which is where the CLI is run.
  content: [
    './index.html',
    './pages/**/*.html',
    './components/**/*.html',
    './js/**/*.js',
    './data/**/*.js',
  ],
  theme: {
    extend: {
      // Brand colours are defined once as CSS custom properties in css/style.css.
      // Mapping them here lets a utility such as tw-text-muted stay in sync with
      // the token system instead of hard-coding a second copy of every hex value.
      colors: {
        ink: 'var(--ivr-ink)',
        'ink-line': 'var(--ivr-ink-line)',
        paper: 'var(--ivr-paper)',
        surface: 'var(--ivr-surface)',
        line: 'var(--ivr-line)',
        body: 'var(--ivr-text)',
        muted: 'var(--ivr-text-muted)',
        // Readable on the dark sidebar and simulator panel, where --ivr-text-muted
        // does not carry enough contrast.
        faint: 'var(--ivr-text-faint)',
        signal: 'var(--ivr-signal)',
        live: 'var(--ivr-live)',
      },
      fontFamily: {
        sans: 'var(--ivr-font-sans)',
        mono: 'var(--ivr-font-mono)',
      },
      boxShadow: {
        card: 'var(--ivr-shadow-card)',
        lift: 'var(--ivr-shadow-lift)',
      },
    },
  },
  plugins: [],
};
