"""
Call recordings: the files on disk and the rows that describe them.

WHERE THE AUDIO COMES FROM

Not from Asterisk. The PBX cannot record for us — the AMI account is refused
MixMonitor, Monitor and every other recording action, and even if it were not,
Asterisk writes to /var/spool/asterisk/monitor on the Ubuntu machine while this
application runs on Windows, with no SSH, SMB or NFS between them. A recording
made there would be stranded there.

So the capture happens in the browser, which already holds both legs of a WebRTC
call, and uploads the result here. See frontend/src/services/recorder.js.

Structurally this is the audio library again — a generated name on disk, the
metadata in MySQL — and it is deliberately the same shape, including the rule
that a name arriving over HTTP is never used as a path.
"""

import re
import secrets
from datetime import datetime
from pathlib import Path

import mysql.connector

from config import BACKEND_DIR
from database import get_connection
from validators import NotFoundError, ValidationError

RECORDINGS_DIR = Path(BACKEND_DIR) / "recordings"

# What a browser will actually produce. Chrome gives WebM/Opus, Firefox Ogg;
# both are playable back in the same browsers.
ALLOWED_MIME = {
    "audio/webm": "webm",
    "audio/webm;codecs=opus": "webm",
    "audio/ogg": "ogg",
    "audio/ogg;codecs=opus": "ogg",
    "audio/mp4": "m4a",
}

# A recording is bounded by call length rather than by anything a user types, but
# an unbounded upload is still an unbounded upload.
MAX_RECORDING_BYTES = 100 * 1024 * 1024

_UNSAFE = re.compile(r"[^a-z0-9]+")


def ensure_dir():
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    return RECORDINGS_DIR


def _stored_name(from_ext, to_ext, extension):
    """
    A generated on-disk name. Readable enough to browse, random enough to be
    unguessable, and built from validated pieces rather than from anything the
    client sent as a path.
    """
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    who = _UNSAFE.sub("-", f"{from_ext}-{to_ext}".lower()).strip("-")[:40] or "call"
    return f"{stamp}-{who}-{secrets.token_hex(6)}.{extension}"


def path_for(stored_name):
    """
    Resolve a stored name inside the recordings directory.

    The containment check is on the *resolved* path, so "..", symlinks and
    anything else clever land outside and are refused.
    """
    base = RECORDINGS_DIR.resolve()
    candidate = (base / stored_name).resolve()
    if candidate != base and base not in candidate.parents:
        raise ValueError(f"{stored_name!r} resolves outside the recordings directory")
    return candidate


def clean_upload(meta):
    """Validate the metadata a recording arrives with."""
    mime = str(meta.get("mime_type") or "").strip().lower()
    # Browsers append codec parameters; match on the base type as well.
    base = mime.split(";")[0].strip()
    extension = ALLOWED_MIME.get(mime) or ALLOWED_MIME.get(base)
    if not extension:
        raise ValidationError("file", f"{mime or 'That type'} is not a supported recording format.")

    from_ext = str(meta.get("from_extension") or "").strip()[:32]
    to_ext = str(meta.get("to_extension") or "").strip()[:32]
    if not from_ext or not to_ext:
        raise ValidationError("file", "A recording needs both extensions.")

    direction = str(meta.get("direction") or "outbound").strip().lower()
    if direction not in ("outbound", "inbound"):
        direction = "outbound"

    try:
        duration = max(0, int(float(meta.get("duration_seconds") or 0)))
    except (TypeError, ValueError):
        duration = 0

    started = meta.get("started_at")
    try:
        started_at = datetime.fromisoformat(str(started).replace("Z", "")) if started else datetime.now()
    except ValueError:
        started_at = datetime.now()

    return {
        "mime_type": base,
        "extension": extension,
        "from_extension": from_ext,
        "to_extension": to_ext,
        "direction": direction,
        "duration_seconds": duration,
        "started_at": started_at,
    }


def _serialise(row):
    return {
        "id": row["id"],
        "username": row.get("username"),
        "from_extension": row["from_extension"],
        "to_extension": row["to_extension"],
        "direction": row["direction"],
        "started_at": row["started_at"].isoformat(sep="T", timespec="seconds") if row["started_at"] else None,
        "duration_seconds": row["duration_seconds"],
        "size_bytes": row["size_bytes"],
        "mime_type": row["mime_type"],
        # Computed, not stored: a row whose file has gone should show as
        # unplayable rather than offer a link that 404s.
        "missing": not path_for(row["stored_name"]).is_file(),
    }


SELECT_RECORDINGS = """
    SELECT r.id, r.stored_name, r.from_extension, r.to_extension, r.direction,
           r.started_at, r.duration_seconds, r.size_bytes, r.mime_type, u.username
    FROM recordings r
    LEFT JOIN users u ON u.id = r.user_id
"""


def create(meta, data, user_id):
    """
    Store an uploaded recording.

    The row goes in first and the file is written inside the same transaction, so
    a failed write rolls the row back and removes the file — there is never a
    history entry pointing at audio that does not exist.
    """
    stored_name = _stored_name(meta["from_extension"], meta["to_extension"], meta["extension"])
    connection = get_connection()
    wrote = False
    try:
        cursor = connection.cursor(dictionary=True)
        try:
            cursor.execute(
                """
                INSERT INTO recordings
                    (user_id, stored_name, from_extension, to_extension, direction,
                     started_at, duration_seconds, size_bytes, mime_type)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    user_id,
                    stored_name,
                    meta["from_extension"],
                    meta["to_extension"],
                    meta["direction"],
                    meta["started_at"],
                    meta["duration_seconds"],
                    len(data),
                    meta["mime_type"],
                ),
            )
            recording_id = cursor.lastrowid

            ensure_dir()
            path_for(stored_name).write_bytes(data)
            wrote = True

            connection.commit()
        except Exception:
            connection.rollback()
            if wrote:
                try:
                    path_for(stored_name).unlink()
                except OSError:
                    pass
            raise
        finally:
            cursor.close()
    finally:
        connection.close()

    return get(recording_id)


def listing(limit=200):
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(f"{SELECT_RECORDINGS} ORDER BY r.started_at DESC LIMIT %s", (int(limit),))
        rows = cursor.fetchall()
        cursor.close()
        return [_serialise(row) for row in rows]
    finally:
        connection.close()


def get(recording_id):
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(f"{SELECT_RECORDINGS} WHERE r.id = %s", (recording_id,))
        row = cursor.fetchone()
        cursor.close()
        if row is None:
            raise NotFoundError("That recording no longer exists.")
        return _serialise(row)
    finally:
        connection.close()


def raw(recording_id):
    """The row including stored_name, for serving the bytes."""
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(f"{SELECT_RECORDINGS} WHERE r.id = %s", (recording_id,))
        row = cursor.fetchone()
        cursor.close()
        if row is None:
            raise NotFoundError("That recording no longer exists.")
        return row
    finally:
        connection.close()


def remove(recording_id):
    """
    Delete a recording: the row first, then the bytes.

    That order on purpose. A failed unlink leaves an unreferenced file, which is
    invisible; unlinking first and then failing to delete the row would leave a
    history entry that plays nothing.
    """
    row = raw(recording_id)
    connection = get_connection()
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("DELETE FROM recordings WHERE id = %s", (recording_id,))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()

    try:
        path_for(row["stored_name"]).unlink()
    except (OSError, ValueError):
        print(f"[recordings] could not remove {row['stored_name']}; it is now unreferenced")

    return _serialise(row)