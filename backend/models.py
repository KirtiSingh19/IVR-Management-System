"""
Data access for IVRs and their menus.

All SQL lives here. server.py deals with HTTP and nothing else, which is what
keeps the routing readable and lets these functions be exercised directly from a
Python shell.

Two rules hold throughout:

  * Every write that touches both tables runs in one transaction, so a failure
    halfway through leaves the database exactly as it was.
  * Nothing is interpolated into SQL. Values are always bound parameters.
"""

import mysql.connector

import audio_store
from database import get_connection
from validators import NotFoundError, ValidationError

DUPLICATE_ENTRY = 1062

MENU_COLUMNS = ("digit", "option_name", "destination_type", "destination", "audio_file")


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def _iso(value):
    """
    A datetime as an ISO 8601 string with no offset.

    Deliberately without a trailing "Z": MySQL hands back TIMESTAMP values in the
    server's own timezone, and JavaScript reads an offset-less ISO string as
    local time. Since the database and the browser are the same machine here,
    leaving the offset off is what makes "3 min ago" correct. Adding a false "Z"
    would shift every timestamp by the local UTC offset.
    """
    return value.isoformat(sep="T", timespec="seconds") if value else None


def _serialise_ivr(row, menu):
    return {
        "id": row["id"],
        "name": row["name"],
        "extension": row["extension"],
        "description": row.get("description") or "",
        "status": row["status"],
        "welcome_audio": row.get("welcome_audio") or "",
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "menu": menu,
    }


def _serialise_option(row):
    return {
        "id": row["id"],
        "digit": row["digit"],
        "option_name": row["option_name"],
        "destination_type": row["destination_type"],
        "destination": row["destination"],
        "audio_file": row.get("audio_file") or "",
    }


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_ivrs():
    """
    Every IVR with its menu nested.

    Two queries rather than one JOIN and a regroup, and rather than one query per
    IVR. A JOIN would repeat every IVR column once per menu row and still need
    grouping in Python; N+1 queries would be slower for no gain. Menus are small
    and the whole set is wanted, so fetching both tables whole and stitching them
    by ivr_id in a dict is both the simplest and the fastest option here.
    """
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            """
            SELECT id, name, extension, description, status, welcome_audio,
                   created_at, updated_at
            FROM ivrs
            ORDER BY id DESC
            """
        )
        rows = cursor.fetchall()

        # Ordered by digit so the menu reads in the order a caller hears it.
        cursor.execute(
            """
            SELECT id, ivr_id, digit, option_name, destination_type, destination, audio_file
            FROM ivr_menus
            ORDER BY ivr_id, digit
            """
        )
        menus = {}
        for option in cursor.fetchall():
            menus.setdefault(option["ivr_id"], []).append(_serialise_option(option))

        cursor.close()
        return [_serialise_ivr(row, menus.get(row["id"], [])) for row in rows]
    finally:
        connection.close()


def get_ivr(ivr_id):
    """One IVR with its menu. Raises NotFoundError when the id does not exist."""
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)

        cursor.execute(
            """
            SELECT id, name, extension, description, status, welcome_audio,
                   created_at, updated_at
            FROM ivrs
            WHERE id = %s
            """,
            (ivr_id,),
        )
        row = cursor.fetchone()
        if row is None:
            cursor.close()
            raise NotFoundError("That IVR no longer exists.")

        cursor.execute(
            """
            SELECT id, digit, option_name, destination_type, destination, audio_file
            FROM ivr_menus
            WHERE ivr_id = %s
            ORDER BY digit
            """,
            (ivr_id,),
        )
        menu = [_serialise_option(option) for option in cursor.fetchall()]

        cursor.close()
        return _serialise_ivr(row, menu)
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# Write helpers
# ---------------------------------------------------------------------------


def _assert_extension_free(cursor, extension, except_id=None):
    """
    Check the extension before writing so the user gets the name of the IVR that
    already holds it, instead of a driver-level duplicate-key error.

    This is not the guarantee — the unique index is. Two simultaneous requests
    could both pass this check, which is why the callers also translate errno
    1062 into the same ValidationError.
    """
    if except_id is None:
        cursor.execute("SELECT name FROM ivrs WHERE extension = %s", (extension,))
    else:
        cursor.execute(
            "SELECT name FROM ivrs WHERE extension = %s AND id <> %s", (extension, except_id)
        )
    clash = cursor.fetchone()
    if clash:
        name = clash["name"] if isinstance(clash, dict) else clash[0]
        raise ValidationError(
            "extension", f"Extension {extension} is already used by {name}."
        )


def _insert_menu(cursor, ivr_id, menu):
    """Insert a validated menu for an IVR that has none yet."""
    if not menu:
        return
    cursor.executemany(
        """
        INSERT INTO ivr_menus
            (ivr_id, digit, option_name, destination_type, destination, audio_file)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        [(ivr_id, *(option[column] for column in MENU_COLUMNS)) for option in menu],
    )


def _replace_menu(cursor, ivr_id, menu):
    """
    Bring the stored menu in line with `menu`, matching rows up by digit.

    Not DELETE-then-INSERT, which was the first version of this. That is simpler
    to write but it hands every surviving option a brand new primary key and a
    brand new created_at on every single save. Two things go wrong as a result:
    an id read in one request is worthless in the next, and created_at stops
    meaning "when this option was added" and starts meaning "when the menu was
    last touched at all".

    Upserting against the (ivr_id, digit) unique key instead leaves a row that
    nobody edited completely alone — same id, same created_at, and ON UPDATE
    CURRENT_TIMESTAMP does not fire because no value changed. Only options whose
    digit actually moved get a new row, which is correct: the digit is the thing
    that identifies an option to a caller.

    One statement per option rather than executemany, because the connector's
    multi-row rewrite does not apply to ON DUPLICATE KEY UPDATE anyway. A menu
    has at most twelve rows and this all runs inside one transaction.
    """
    for option in menu:
        cursor.execute(
            """
            INSERT INTO ivr_menus
                (ivr_id, digit, option_name, destination_type, destination, audio_file)
            VALUES (%s, %s, %s, %s, %s, %s) AS new
            ON DUPLICATE KEY UPDATE
                option_name      = new.option_name,
                destination_type = new.destination_type,
                destination      = new.destination,
                audio_file       = new.audio_file
            """,
            (ivr_id, *(option[column] for column in MENU_COLUMNS)),
        )

    # Whatever digit is no longer offered is no longer an option.
    if menu:
        placeholders = ", ".join(["%s"] * len(menu))
        cursor.execute(
            f"DELETE FROM ivr_menus WHERE ivr_id = %s AND digit NOT IN ({placeholders})",
            (ivr_id, *(option["digit"] for option in menu)),
        )
    else:
        cursor.execute("DELETE FROM ivr_menus WHERE ivr_id = %s", (ivr_id,))


def _as_extension_conflict(error, extension):
    """
    Translate a unique-key violation into the field-level error the form expects.

    Both tables have a unique key, so the message is chosen by which one was hit
    rather than assuming every 1062 is an extension clash.
    """
    message = str(error)
    if "uq_ivr_menus_ivr_digit" in message:
        return ValidationError("digit", "That digit is already used in this menu.")
    return ValidationError("extension", f"Extension {extension} is already in use.")


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def create_ivr(data):
    """
    Insert the IVR, take its new id, insert its menu rows against that id, and
    commit the two together.
    """
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        try:
            _assert_extension_free(cursor, data["extension"])

            cursor.execute(
                """
                INSERT INTO ivrs (name, extension, description, status, welcome_audio)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    data["name"],
                    data["extension"],
                    data["description"] or None,
                    data["status"],
                    data["welcome_audio"],
                ),
            )
            ivr_id = cursor.lastrowid

            _insert_menu(cursor, ivr_id, data["menu"])
            connection.commit()
        except mysql.connector.IntegrityError as error:
            connection.rollback()
            if error.errno == DUPLICATE_ENTRY:
                raise _as_extension_conflict(error, data["extension"]) from error
            raise
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()

    # Read back rather than echo the input, so the response carries the real
    # server-assigned id and the timestamps the database generated.
    return get_ivr(ivr_id)


def update_ivr(ivr_id, fields, menu=None):
    """
    Update the IVR and, when a menu was supplied, replace its menu rows.

    `menu is None` means the caller did not mention the menu, so it is left
    alone. `menu == []` means the caller is clearing it. See clean_update().

    The menu is always sent whole, because the flow builder edits one option at a
    time against the four endpoints this API exposes. _replace_menu() reconciles
    it row by row so that doing so does not churn the ids of options nobody
    touched.
    """
    extension = None  # bound below; kept in scope for the IntegrityError message
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        try:
            cursor.execute("SELECT id, extension FROM ivrs WHERE id = %s", (ivr_id,))
            existing = cursor.fetchone()
            if existing is None:
                raise NotFoundError("That IVR no longer exists.")

            extension = fields.get("extension", existing["extension"])
            if "extension" in fields:
                _assert_extension_free(cursor, fields["extension"], except_id=ivr_id)

            if fields:
                # Column names come from the validator's fixed key set, never from
                # raw request keys, so this f-string cannot carry user input.
                assignments = ", ".join(f"{column} = %s" for column in fields)
                # Set updated_at explicitly: ON UPDATE CURRENT_TIMESTAMP does not
                # fire when a save leaves every value unchanged, and the edit
                # screen shows "last saved" from this column.
                cursor.execute(
                    f"UPDATE ivrs SET {assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                    (*fields.values(), ivr_id),
                )

            if menu is not None:
                _replace_menu(cursor, ivr_id, menu)

            connection.commit()
        except mysql.connector.IntegrityError as error:
            connection.rollback()
            if error.errno == DUPLICATE_ENTRY:
                raise _as_extension_conflict(error, extension) from error
            raise
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()

    return get_ivr(ivr_id)


def delete_ivr(ivr_id):
    """
    Delete the menu rows, then the IVR, in one transaction.

    The foreign key would cascade on its own, but doing it explicitly is what the
    contract asks for and it means the code says what happens instead of relying
    on a schema detail a reader has to go and look up.
    """
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        try:
            deleted = get_ivr_within(cursor, ivr_id)

            cursor.execute("DELETE FROM ivr_menus WHERE ivr_id = %s", (ivr_id,))
            cursor.execute("DELETE FROM ivrs WHERE id = %s", (ivr_id,))
            connection.commit()
            return deleted
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# Audio library
# ---------------------------------------------------------------------------


def _serialise_audio(row):
    """
    One audio file, as the frontend wants it.

    `missing` is computed rather than stored. A row whose file has been removed
    from disk behind the API's back should show as unplayable rather than hand the
    UI a URL that 404s, and checking at read time is the only way to know. It is a
    stat() per row on a library of a few dozen files, which is nothing.
    """
    present = audio_store.exists(row["stored_name"])
    return {
        "id": row["id"],
        "name": row["name"],
        "format": row["format"],
        "duration_seconds": row["duration_seconds"],
        "size_bytes": row["size_bytes"],
        "status": row["status"],
        "seeded": bool(row["seeded"]),
        "missing": not present,
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


AUDIO_SELECT = """
    SELECT id, name, stored_name, format, duration_seconds, size_bytes,
           status, seeded, created_at, updated_at
    FROM audio_files
"""


def list_audio():
    """Every audio file, newest first, matching the table's default sort."""
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(f"{AUDIO_SELECT} ORDER BY id DESC")
        rows = cursor.fetchall()
        cursor.close()
        return [_serialise_audio(row) for row in rows]
    finally:
        connection.close()


def get_audio_row(audio_id):
    """
    The raw row, stored_name included.

    Separate from list_audio() because serving the bytes needs the on-disk name
    and the format, which are not part of the public JSON.
    """
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(f"{AUDIO_SELECT} WHERE id = %s", (audio_id,))
        row = cursor.fetchone()
        cursor.close()
        if row is None:
            raise NotFoundError("That audio file no longer exists.")
        return row
    finally:
        connection.close()


def create_audio(meta, data):
    """
    Register an upload and write its bytes.

    Order matters. The row goes in first and the file is written inside the same
    transaction, so a failure to write means the INSERT is rolled back and the
    file is removed — there is no window in which a row exists without its audio.
    The reverse order would leave an unreferenced file behind on every failed
    insert.
    """
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        stored_name = audio_store.build_stored_name(meta["name"])
        wrote = False
        try:
            cursor.execute("SELECT name FROM audio_files WHERE name = %s", (meta["name"],))
            if cursor.fetchone():
                raise ValidationError("file", f"An audio file named {meta['name']} already exists.")

            cursor.execute(
                """
                INSERT INTO audio_files
                    (name, stored_name, format, duration_seconds, size_bytes, status, seeded)
                VALUES (%s, %s, %s, %s, %s, 'ready', 0)
                """,
                (
                    meta["name"],
                    stored_name,
                    meta["format"],
                    meta["duration_seconds"],
                    meta["size_bytes"],
                ),
            )
            audio_id = cursor.lastrowid

            audio_store.write_file(stored_name, data)
            wrote = True

            connection.commit()
        except mysql.connector.IntegrityError as error:
            connection.rollback()
            if wrote:
                audio_store.delete_file(stored_name)
            if error.errno == DUPLICATE_ENTRY:
                raise ValidationError(
                    "file", f"An audio file named {meta['name']} already exists."
                ) from error
            raise
        except Exception:
            connection.rollback()
            if wrote:
                audio_store.delete_file(stored_name)
            raise
        finally:
            cursor.close()
    finally:
        connection.close()

    return _serialise_audio(get_audio_row(audio_id))


def delete_audio(audio_id):
    """
    Remove an audio file: the row first, then the bytes.

    This order is chosen on purpose. If the unlink fails — a file lock, a
    permission problem — the result is an unreferenced file on disk, which is
    invisible and harmless. Unlinking first and then failing to delete the row
    would leave a library entry that plays nothing, which is exactly the bug this
    whole change set out to fix.
    """
    row = get_audio_row(audio_id)

    connection = get_connection()
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("DELETE FROM audio_files WHERE id = %s", (audio_id,))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()

    if not audio_store.delete_file(row["stored_name"]) and audio_store.exists(row["stored_name"]):
        print(f"[models] could not remove {row['stored_name']} from disk; it is now unreferenced")

    return _serialise_audio(row)


def get_ivr_within(cursor, ivr_id):
    """
    Read an IVR using a cursor the caller already owns.

    delete_ivr() needs the record to return it to the client, and it has to be
    read inside the same transaction that deletes it — a second connection could
    not see the row once the delete had run.
    """
    cursor.execute(
        """
        SELECT id, name, extension, description, status, welcome_audio,
               created_at, updated_at
        FROM ivrs
        WHERE id = %s
        """,
        (ivr_id,),
    )
    row = cursor.fetchone()
    if row is None:
        raise NotFoundError("That IVR no longer exists.")

    cursor.execute(
        """
        SELECT id, digit, option_name, destination_type, destination, audio_file
        FROM ivr_menus
        WHERE ivr_id = %s
        ORDER BY digit
        """,
        (ivr_id,),
    )
    menu = [_serialise_option(option) for option in cursor.fetchall()]
    return _serialise_ivr(row, menu)
