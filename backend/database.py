"""
MySQL connection and schema.

get_connection() keeps the name the rest of the backend already imported, so
nothing else had to change when the credentials moved into .env.

init_schema() is idempotent: it creates what is missing and leaves what is not,
so starting the server is enough to bring the database up to date. There is no
separate migration command to remember or forget.
"""

import mysql.connector

import audio_store
from config import MYSQL


def get_connection():
    """
    A connection for the life of one request.

    autocommit stays off because POST, PUT and DELETE each write to two tables
    and must not be able to land half-applied. Handlers commit explicitly.
    """
    return mysql.connector.connect(autocommit=False, **MYSQL)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

CREATE_IVRS = """
CREATE TABLE IF NOT EXISTS ivrs (
  id            INT           NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100)  NOT NULL,
  extension     VARCHAR(20)   NOT NULL,
  description   VARCHAR(255)      NULL,
  status        ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  welcome_audio VARCHAR(255)      NULL,
  created_at    TIMESTAMP         NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP         NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ivrs_extension (extension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""

# The unique key on (ivr_id, digit) is the "one digit means one thing" rule
# expressed where it cannot be bypassed. The API checks it too, so the user gets
# a readable message rather than a driver error, but the database is the backstop
# against two concurrent writers.
#
# ON DELETE CASCADE is a safety net, not the mechanism: delete_ivr() removes the
# menu rows itself, as specified, so the intent is visible in the code.
CREATE_IVR_MENUS = """
CREATE TABLE IF NOT EXISTS ivr_menus (
  id               INT          NOT NULL AUTO_INCREMENT,
  ivr_id           INT          NOT NULL,
  digit            VARCHAR(1)   NOT NULL,
  option_name      VARCHAR(100) NOT NULL,
  destination_type VARCHAR(20)  NOT NULL DEFAULT 'extension',
  destination      VARCHAR(50)  NOT NULL,
  -- What the caller hears after pressing this key, while the transfer happens.
  -- A file name, matching audio_files.name, for the same reason ivrs.welcome_audio
  -- is: the picker, the simulator and the API all join prompts by name.
  audio_file       VARCHAR(255)     NULL,
  created_at       TIMESTAMP        NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP        NULL DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ivr_menus_ivr_digit (ivr_id, digit),
  CONSTRAINT fk_ivr_menus_ivr
    FOREIGN KEY (ivr_id) REFERENCES ivrs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""


# `name` is the display name and it is unique, because it is also the join key:
# ivrs.welcome_audio stores a file name, and both the audio picker on the edit
# form and the call simulator look prompts up by it.
#
# `stored_name` is the generated name on disk. Keeping the two apart is what lets
# the user see "welcome message.wav" while the filesystem only ever sees
# "welcome-message-a1b2c3d4e5f6.wav".
CREATE_AUDIO_FILES = """
CREATE TABLE IF NOT EXISTS audio_files (
  id               INT          NOT NULL AUTO_INCREMENT,
  name             VARCHAR(255) NOT NULL,
  stored_name      VARCHAR(255) NOT NULL,
  format           VARCHAR(10)  NOT NULL,
  duration_seconds INT          NOT NULL DEFAULT 0,
  size_bytes       BIGINT       NOT NULL DEFAULT 0,
  status           ENUM('ready','processing','error') NOT NULL DEFAULT 'ready',
  seeded           TINYINT(1)   NOT NULL DEFAULT 0,
  created_at       TIMESTAMP        NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP        NULL DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audio_files_name (name),
  UNIQUE KEY uq_audio_files_stored_name (stored_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""


# No password is stored here, only a scrypt digest — see auth.py.
CREATE_USERS = """
CREATE TABLE IF NOT EXISTS users (
  id            INT          NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP        NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""

# Recordings of browser calls. The audio is captured in the page and uploaded, so
# the file lives on this machine beside the audio prompts rather than on the PBX —
# see services/recorder.js for why.
CREATE_RECORDINGS = """
CREATE TABLE IF NOT EXISTS recordings (
  id               INT          NOT NULL AUTO_INCREMENT,
  user_id          INT              NULL,
  stored_name      VARCHAR(255) NOT NULL,
  from_extension   VARCHAR(32)  NOT NULL,
  to_extension     VARCHAR(32)  NOT NULL,
  direction        ENUM('outbound','inbound') NOT NULL DEFAULT 'outbound',
  started_at       DATETIME     NOT NULL,
  duration_seconds INT          NOT NULL DEFAULT 0,
  size_bytes       BIGINT       NOT NULL DEFAULT 0,
  mime_type        VARCHAR(80)  NOT NULL,
  created_at       TIMESTAMP        NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recordings_stored_name (stored_name),
  KEY ix_recordings_started (started_at),
  -- ON DELETE SET NULL, not CASCADE: removing an account must not silently
  -- destroy the call history that account produced.
  CONSTRAINT fk_recordings_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""

# token_hash, not the token: a leak of this table must not yield usable cookies.
# ON DELETE CASCADE means removing an account signs it out everywhere at once,
# rather than leaving live sessions pointing at a user that no longer exists.
CREATE_SESSIONS = """
CREATE TABLE IF NOT EXISTS sessions (
  id         INT         NOT NULL AUTO_INCREMENT,
  user_id    INT         NOT NULL,
  token_hash CHAR(64)    NOT NULL,
  created_at TIMESTAMP       NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY ix_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""


def _column_exists(cursor, table, column):
    cursor.execute(
        """
        SELECT COUNT(*)
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s AND column_name = %s
        """,
        (MYSQL["database"], table, column),
    )
    return cursor.fetchone()[0] > 0


def init_schema():
    """
    Create or bring forward both tables. Safe to call on every start.

    Returns a list of the changes actually made, so the startup log says what
    happened rather than claiming success unconditionally.
    """
    changes = []
    connection = get_connection()
    try:
        cursor = connection.cursor()

        cursor.execute("SHOW TABLES LIKE 'ivrs'")
        ivrs_existed = cursor.fetchone() is not None
        cursor.execute(CREATE_IVRS)
        if not ivrs_existed:
            changes.append("created ivrs")

        # `ivrs` may predate the description column. ADD COLUMN IF NOT EXISTS is
        # MariaDB-only, so check information_schema rather than swallowing the
        # duplicate-column error and hiding real failures with it.
        if not _column_exists(cursor, "ivrs", "description"):
            cursor.execute(
                "ALTER TABLE ivrs ADD COLUMN description VARCHAR(255) NULL AFTER extension"
            )
            changes.append("added ivrs.description")

        cursor.execute("SHOW TABLES LIKE 'ivr_menus'")
        menus_existed = cursor.fetchone() is not None
        cursor.execute(CREATE_IVR_MENUS)
        if not menus_existed:
            changes.append("created ivr_menus")

        # Menus created before per-option prompts existed have no audio column.
        if not _column_exists(cursor, "ivr_menus", "audio_file"):
            cursor.execute(
                "ALTER TABLE ivr_menus ADD COLUMN audio_file VARCHAR(255) NULL AFTER destination"
            )
            changes.append("added ivr_menus.audio_file")

        cursor.execute("SHOW TABLES LIKE 'audio_files'")
        audio_existed = cursor.fetchone() is not None
        cursor.execute(CREATE_AUDIO_FILES)
        if not audio_existed:
            changes.append("created audio_files")

        # users before sessions: the foreign key needs its target to exist.
        cursor.execute("SHOW TABLES LIKE 'users'")
        users_existed = cursor.fetchone() is not None
        cursor.execute(CREATE_USERS)
        if not users_existed:
            changes.append("created users")

        # Roles arrived after users did, so the column may be missing.
        if not _column_exists(cursor, "users", "role"):
            cursor.execute(
                "ALTER TABLE users ADD COLUMN role ENUM('admin','user') NOT NULL DEFAULT 'user'"
            )
            # Anyone who already had an account predates roles and would otherwise
            # be locked out of a page that did not exist when they signed up — and
            # with no admin, nobody could promote anybody.
            cursor.execute("UPDATE users SET role = 'admin'")
            changes.append("added users.role (existing accounts promoted to admin)")

        cursor.execute("SHOW TABLES LIKE 'sessions'")
        sessions_existed = cursor.fetchone() is not None
        cursor.execute(CREATE_SESSIONS)
        if not sessions_existed:
            changes.append("created sessions")

        cursor.execute("SHOW TABLES LIKE 'recordings'")
        recordings_existed = cursor.fetchone() is not None
        cursor.execute(CREATE_RECORDINGS)
        if not recordings_existed:
            changes.append("created recordings")

        connection.commit()
        cursor.close()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    try:
        imported = import_seed_audio()
        if imported:
            changes.append(f"imported {imported} shipped prompt(s)")
    except Exception as error:
        # The demo prompts are a convenience, not a requirement. A library that
        # cannot be seeded must never stop the API from serving the IVRs and audio
        # that are already there — this used to raise and take the server down.
        print(f"[database] could not import the shipped prompts: {error}")
        changes.append("shipped prompts skipped (see log)")

    return changes


def import_seed_audio():
    """
    Copy the prompts from assets/audio into the audio library, on a fresh install.

    Only when the library is completely empty. An earlier version checked each
    name individually, which was wrong twice over: a prompt deliberately deleted
    came straight back on the next restart, and the check compared names with
    Python's case-sensitive equality while the unique index on audio_files.name
    uses a case-insensitive collation — so an uploaded "Invalid.wav" did not look
    like a match for "invalid.wav", and the insert then failed on the index.

    "Empty library" is both the honest trigger and the safe one: once anybody has
    uploaded or removed anything, their library is theirs and the server leaves it
    alone.

    Copied rather than referenced in place, so the library has exactly one storage
    location and nothing downstream needs a special case for shipped files.
    """
    seeds = audio_store.seed_files()
    if not seeds:
        return 0

    connection = get_connection()
    imported = 0
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("SELECT COUNT(*) FROM audio_files")
            if cursor.fetchone()[0] > 0:
                return 0

            # Lowercased, to match how the database compares them. Guards the case
            # of two shipped files whose names differ only in case.
            known = set()

            for display_name, source_path, duration in seeds:
                if display_name.lower() in known:
                    continue
                known.add(display_name.lower())

                stored_name = audio_store.build_stored_name(display_name)
                data = source_path.read_bytes()
                audio_store.write_file(stored_name, data)

                try:
                    cursor.execute(
                        """
                        INSERT INTO audio_files
                            (name, stored_name, format, duration_seconds, size_bytes,
                             status, seeded)
                        VALUES (%s, %s, %s, %s, %s, 'ready', 1)
                        """,
                        (
                            display_name,
                            stored_name,
                            audio_store.format_of(display_name),
                            duration,
                            len(data),
                        ),
                    )
                    imported += 1
                except Exception:
                    # Do not leave a file behind that no row points at.
                    audio_store.delete_file(stored_name)
                    raise

            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()

    return imported
