"""
The audio files on disk.

Everything that touches the filesystem lives here, so models.py stays about SQL
and server.py stays about HTTP. Two concerns drive the design:

  * A name that arrived over HTTP is never used as a path. Uploads are stored
    under a generated name, and the name the user sees is kept in the database
    instead. That is what makes "../../etc/passwd.wav" a harmless display string
    rather than a way out of the upload directory.

  * Reading a file always re-checks that the resolved path is still inside the
    upload directory, so a stored_name that somehow went bad cannot be used to
    read arbitrary files off the server.
"""

import re
import secrets
import wave
from pathlib import Path

from config import AUDIO_DIR, SEED_AUDIO_DIR

# The formats the app already declares in data/demo-data.js. Kept in step with it
# rather than invented here.
ALLOWED_FORMATS = ("WAV", "MP3", "OGG", "GSM")

CONTENT_TYPES = {
    "WAV": "audio/wav",
    "MP3": "audio/mpeg",
    "OGG": "audio/ogg",
    "GSM": "audio/x-gsm",
}

_UNSAFE = re.compile(r"[^a-z0-9]+")


def ensure_dir():
    """Create the upload directory if it is not there yet."""
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    return AUDIO_DIR


def format_of(display_name):
    """The uppercase container from a file name, e.g. "welcome.wav" -> "WAV"."""
    suffix = Path(display_name).suffix.lstrip(".")
    return suffix.upper() if suffix else ""


def build_stored_name(display_name):
    """
    A safe, unique on-disk name derived from the display name.

    The readable stem is kept only so that browsing the upload directory is not
    a wall of hashes; it is slugged down to [a-z0-9-] first, and a random token
    guarantees uniqueness without a database round trip. The extension comes from
    the validated format, never straight from the input.
    """
    stem = _UNSAFE.sub("-", Path(display_name).stem.lower()).strip("-")[:40] or "audio"
    extension = format_of(display_name).lower() or "bin"
    return f"{stem}-{secrets.token_hex(6)}.{extension}"


def path_for(stored_name):
    """
    Resolve a stored name to an absolute path inside the upload directory.

    The containment check is deliberately on the *resolved* path. Checking the
    string beforehand would miss symlinks and "..", which is the whole point.
    """
    base = AUDIO_DIR.resolve()
    candidate = (base / stored_name).resolve()
    if candidate != base and base not in candidate.parents:
        raise ValueError(f"{stored_name!r} resolves outside the audio directory")
    return candidate


def write_file(stored_name, data):
    """Write the bytes for a new file and return how many were written."""
    ensure_dir()
    target = path_for(stored_name)
    target.write_bytes(data)
    return len(data)


def delete_file(stored_name):
    """
    Remove a file, tolerating one that is already gone.

    Returns True when something was deleted. A missing file is not an error: the
    database row is what the user sees, and it has already gone by this point.
    """
    try:
        path_for(stored_name).unlink()
        return True
    except (FileNotFoundError, ValueError):
        return False


def exists(stored_name):
    try:
        return path_for(stored_name).is_file()
    except ValueError:
        return False


def size_of(stored_name):
    try:
        return path_for(stored_name).stat().st_size
    except (OSError, ValueError):
        return 0


def content_type_for(fmt):
    return CONTENT_TYPES.get((fmt or "").upper(), "application/octet-stream")


def wav_duration(path):
    """
    Duration in whole seconds, read from the WAV header.

    Only WAV, because that is all the standard library can open — and all three
    seeded prompts are WAV. Uploads do not need this: the browser has already
    decoded the file to show its length, and sends that figure along.
    """
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            return round(handle.getnframes() / rate) if rate else 0
    except (wave.Error, OSError):
        return 0


def seed_files():
    """
    The prompts shipped in assets/audio, as (display_name, path, duration) tuples.

    Sorted so the import order — and therefore the ids they get — is the same on
    every machine.
    """
    if not SEED_AUDIO_DIR.is_dir():
        return []

    found = []
    for path in sorted(SEED_AUDIO_DIR.iterdir()):
        if path.is_file() and format_of(path.name) in ALLOWED_FORMATS:
            found.append((path.name, path, wav_duration(path)))
    return found
