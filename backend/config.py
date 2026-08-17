"""
Configuration.

Every value the backend needs comes from the environment, and backend/.env is
read into the environment on import. That file is git-ignored, so no credential
is ever committed.

Parsed with the standard library rather than python-dotenv: the whole job is
about fifteen lines, and requirements.txt stays at one dependency.
"""

import os
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"


def load_env_file(path=ENV_PATH):
    """
    Read KEY=VALUE lines from a .env file into os.environ.

    A variable already present in the environment always wins, so a value
    exported by the shell or injected by a host is never silently overridden by
    a stale file on disk.
    """
    if not path.exists():
        return False

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        # Blank lines, comments and anything without a separator are not
        # settings, and a malformed line should not stop the server booting.
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

    return True


ENV_FILE_FOUND = load_env_file()


def _int_env(name, default):
    """An unparseable port is a configuration mistake worth failing loudly on."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a number, got {raw!r}") from error


def _float_env(name, default):
    """As _int_env, for settings measured in seconds."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a number, got {raw!r}") from error


# Keyword arguments for mysql.connector.connect(), assembled once.
MYSQL = {
    "host": os.environ.get("MYSQL_HOST", "localhost"),
    "port": _int_env("MYSQL_PORT", 3306),
    "database": os.environ.get("MYSQL_DATABASE", "ivr_manager"),
    "user": os.environ.get("MYSQL_USER", "root"),
    "password": os.environ.get("MYSQL_PASSWORD", ""),
}

API_HOST = os.environ.get("API_HOST", "127.0.0.1")
API_PORT = _int_env("API_PORT", 5000)

CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")

# ---------------------------------------------------------------------------
# Asterisk AMI
# ---------------------------------------------------------------------------

# Read-only access to the PBX. The browser never sees any of this: the frontend
# calls this API, and this API calls AMI. Handing the manager credentials to
# JavaScript would let any visitor talk to the switch directly.
ASTERISK = {
    "host": os.environ.get("ASTERISK_HOST", "").strip(),
    "port": _int_env("ASTERISK_AMI_PORT", 5038),
    "username": os.environ.get("ASTERISK_AMI_USERNAME", "").strip(),
    "secret": os.environ.get("ASTERISK_AMI_SECRET", ""),
    # Deliberately short. A page load waits on this, so an unreachable PBX should
    # report itself down within a few seconds rather than hang the dashboard.
    "timeout": _float_env("ASTERISK_AMI_TIMEOUT", 5.0),
}

# The only file on the PBX this application writes. Everything the website manages
# lives here and nowhere else, so extensions.conf and pjsip.conf stay hand-owned
# and a bad sync can never damage configuration nobody asked it to touch.
ASTERISK_MANAGED_FILE = os.environ.get("ASTERISK_MANAGED_FILE", "ivr_manager.conf").strip()

# The context PJSIP endpoints arrive in. Checked for hand-written extensions that
# would shadow a synced IVR; never written to.
ASTERISK_PARENT_CONTEXT = os.environ.get("ASTERISK_PARENT_CONTEXT", "internal").strip()

# ---------------------------------------------------------------------------
# Audio storage
# ---------------------------------------------------------------------------

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent

# Where uploaded prompts are kept. Real files on a real path, because Asterisk
# will need exactly that later — it cannot play a row out of a database.
AUDIO_DIR = Path(os.environ.get("AUDIO_DIR") or (BACKEND_DIR / "uploads"))

# The three prompts shipped with the app, imported into the library on first run
# so that every file in the system is handled the same way afterwards.
SEED_AUDIO_DIR = PROJECT_DIR / "assets" / "audio"

# A 20 MB ceiling is generous for a telephony prompt — an uncompressed 16-bit
# 44.1 kHz WAV runs about 5 MB per minute — while still keeping one dropped file
# from filling the disk.
MAX_AUDIO_BYTES = _int_env("MAX_AUDIO_BYTES", 20 * 1024 * 1024)
