/**
 * One-time migration of localStorage IVRs into MySQL.
 *
 * Runs on boot, before any controller reads, and does nothing at all once it has
 * succeeded. Three rules shape it:
 *
 *   Nothing is deleted. The localStorage records stay exactly where they are, so
 *   they remain a readable backup until you are satisfied the database has
 *   everything. Clearing them is a separate, deliberate step.
 *
 *   Duplicates are impossible. The extension is the unique key, in the database
 *   and here, so an IVR that MySQL already has on that extension is skipped
 *   rather than inserted a second time. That is what makes running this twice
 *   harmless, and it is why a half-finished migration can simply be re-run.
 *
 *   Failure does not get recorded as success. If any IVR could not be posted, or
 *   the API was unreachable, the completion flag is not written and the whole
 *   thing is attempted again on the next page load.
 */

import { KEYS, MIGRATED_KEY, read, readFlag, writeFlag } from './storage.js';
import * as IvrApi from './api.js';

/** True once every local IVR is known to be in MySQL. */
export function isMigrated() {
  return readFlag(MIGRATED_KEY) === 'true';
}

/**
 * Push local IVRs and their menus to the API.
 *
 * @returns {Promise<{status: string, created: number, skipped: number, failed: number}>}
 */
export async function runMigration() {
  if (isMigrated()) return { status: 'already-done', created: 0, skipped: 0, failed: 0 };

  const localIvrs = read(KEYS.IVRS, []);
  const localFlows = read(KEYS.FLOWS, {});

  if (!Array.isArray(localIvrs) || localIvrs.length === 0) {
    // Nothing to move. Record that, so a browser that never used the localStorage
    // version does not check again on every single load.
    writeFlag(MIGRATED_KEY, 'true');
    return { status: 'nothing-to-migrate', created: 0, skipped: 0, failed: 0 };
  }

  console.info(`Migrating ${localIvrs.length} IVRs to MySQL...`);

  let existing;
  try {
    existing = await IvrApi.fetchIvrs();
  } catch (error) {
    // The API being down is not a migration failure, it is a "not yet". Leave the
    // flag unwritten and say so plainly.
    console.error('[migrate] Migration postponed — the IVR API is not reachable.', error);
    return { status: 'api-unreachable', created: 0, skipped: 0, failed: 0 };
  }

  // Grows as records are created, so two local IVRs sharing an extension cannot
  // both be inserted either.
  const takenExtensions = new Set(existing.map((ivr) => ivr.extension));

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const ivr of localIvrs) {
    const extension = String(ivr.extension ?? '').trim();

    if (!extension) {
      console.warn(`[migrate] Skipped "${ivr.name}" — it has no extension.`);
      failed += 1;
      continue;
    }

    if (takenExtensions.has(extension)) {
      console.info(`[migrate] Skipped "${ivr.name}" (${extension}) — already in MySQL.`);
      skipped += 1;
      continue;
    }

    // Menu options are keyed by the old localStorage id, which the database
    // knows nothing about. They travel nested inside the IVR so that the server
    // inserts both in one transaction and assigns the foreign key itself.
    const menu = Array.isArray(localFlows?.[ivr.id]) ? localFlows[ivr.id] : [];

    try {
      await IvrApi.createIvr({
        name: ivr.name,
        extension,
        description: ivr.description ?? '',
        welcomeAudio: ivr.welcomeAudio ?? '',
        status: ivr.status === 'inactive' ? 'inactive' : 'active',
        menu: menu.map((option) => ({
          digit: option.digit,
          label: option.label,
          destination: option.destination,
          destinationType: option.destinationType || 'extension',
        })),
      });

      takenExtensions.add(extension);
      created += 1;
      console.info(`[migrate] Migrated "${ivr.name}" (${extension}) with ${menu.length} menu options.`);
    } catch (error) {
      failed += 1;
      console.error(`[migrate] Could not migrate "${ivr.name}" (${extension}):`, error.message);
    }
  }

  if (failed === 0) {
    writeFlag(MIGRATED_KEY, 'true');
    console.info(`Migration successful. ${created} created, ${skipped} already present.`);
    return { status: 'success', created, skipped, failed };
  }

  console.warn(
    `[migrate] Migration incomplete: ${created} created, ${skipped} already present, ` +
      `${failed} failed. It will be retried on the next load, and the local copies are untouched.`,
  );
  return { status: 'incomplete', created, skipped, failed };
}
