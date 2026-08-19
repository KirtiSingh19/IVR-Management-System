"""
Passwords and sessions.

Standard library only — `hashlib.scrypt` and `secrets` cover both jobs, so
requirements.txt stays at one dependency.

TWO THINGS ARE DELIBERATELY NOT STORED

A password is never stored, in any recoverable form. What goes in the users table
is a scrypt digest with a per-user random salt, so two people with the same
password still get different rows and a stolen table cannot be reversed.

A session token is never stored either. The token goes to the browser; the
database keeps only its SHA-256. Someone who reads the sessions table therefore
cannot mint a working cookie from it — the same reasoning as the password, applied
to the thing that stands in for one.

Comparisons use hmac.compare_digest so a wrong guess takes the same time as a
right one, and cannot be narrowed down byte by byte.
"""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from database import get_connection

# scrypt cost. n=2**14 with r=8 takes roughly 50-100 ms here, which is slow enough
# to make offline guessing expensive and fast enough that a login does not feel
# like it hung.
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
DK_LEN = 32
SALT_BYTES = 16

# How long a session lasts. Absolute rather than sliding: a token that renews
# itself on every request never expires for an attacker who has one.
SESSION_HOURS = 12

COOKIE_NAME = "ivrm_session"


class AuthError(Exception):
    """Bad credentials, or no valid session. Handlers turn this into 401."""


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------


def hash_password(password):
    """A self-describing digest: the parameters travel with it."""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=DK_LEN
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    """
    Check a password against a stored digest.

    The cost parameters are read back out of the stored value rather than taken
    from the constants above, so raising them later does not lock out everybody
    who registered before the change.
    """
    try:
        scheme, n, r, p, salt_hex, digest_hex = str(stored).split("$")
        if scheme != "scrypt":
            return False
        candidate = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(bytes.fromhex(digest_hex)),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate.hex(), digest_hex)


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


def create_user(username, password, role="user"):
    """Add an account. Raises ValueError when the name is taken or unusable."""
    if role not in ("admin", "user"):
        raise ValueError("Role must be admin or user.")
    username = str(username or "").strip()
    if len(username) < 3:
        raise ValueError("Usernames need at least 3 characters.")
    if len(password or "") < 8:
        raise ValueError("Passwords need at least 8 characters.")

    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("SELECT id FROM users WHERE username = %s", (username,))
        if cursor.fetchone():
            raise ValueError(f"There is already a user called {username}.")

        cursor.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (%s, %s, %s)",
            (username, hash_password(password), role),
        )
        connection.commit()
        cursor.close()
        return username
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def list_users():
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("SELECT username, role, created_at FROM users ORDER BY username")
        rows = cursor.fetchall()
        cursor.close()
        return rows
    finally:
        connection.close()


def delete_user(username):
    connection = get_connection()
    try:
        cursor = connection.cursor()
        # Sessions cascade with the user, so removing an account also signs it out
        # everywhere rather than leaving live tokens behind.
        cursor.execute("DELETE FROM users WHERE username = %s", (username,))
        removed = cursor.rowcount
        connection.commit()
        cursor.close()
        return removed
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def _token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def login(username, password):
    """
    Exchange credentials for a session token.

    The same message comes back whether the user does not exist or the password
    is wrong, so the response cannot be used to enumerate accounts. The hash is
    still computed for an unknown user, so the two paths take the same time.
    """
    username = str(username or "").strip()
    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute("SELECT id, username, role, password_hash FROM users WHERE username = %s", (username,))
        user = cursor.fetchone()

        if user is None:
            # Burn comparable time so a missing account is not detectably faster.
            hash_password(password or "")
            raise AuthError("That username and password do not match.")

        if not verify_password(password or "", user["password_hash"]):
            raise AuthError("That username and password do not match.")

        token = secrets.token_urlsafe(32)
        expires = datetime.now() + timedelta(hours=SESSION_HOURS)
        cursor.execute(
            "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (%s, %s, %s)",
            (user["id"], _token_hash(token), expires),
        )
        connection.commit()
        cursor.close()
        return {"token": token, "username": user["username"], "role": user["role"], "expires_at": expires}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def set_role(username, role):
    """Promote or demote an account."""
    if role not in ("admin", "user"):
        raise ValueError("Role must be admin or user.")
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("UPDATE users SET role = %s WHERE username = %s", (role, username))
        changed = cursor.rowcount
        connection.commit()
        cursor.close()
        return changed > 0
    finally:
        connection.close()


def session_user(token):
    """
    Who a token belongs to, as {id, username, role} — or None when it is unknown
    or expired.

    The role comes from the users table on every request rather than being baked
    into the token, so a demotion takes effect immediately instead of when the
    session happens to expire.
    """
    if not token:
        return None

    connection = get_connection()
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT u.id, u.username, u.role
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = %s AND s.expires_at > NOW()
            """,
            (_token_hash(token),),
        )
        row = cursor.fetchone()
        cursor.close()
        return row or None
    finally:
        connection.close()


def logout(token):
    """Invalidate one session. Idempotent — an unknown token is not an error."""
    if not token:
        return False
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("DELETE FROM sessions WHERE token_hash = %s", (_token_hash(token),))
        removed = cursor.rowcount
        connection.commit()
        cursor.close()
        return removed > 0
    finally:
        connection.close()


def purge_expired():
    """
    Drop sessions that have timed out.

    Called on start-up. Expired rows are already refused by session_user, so this
    is housekeeping rather than a security measure — it keeps the table from
    growing without bound.
    """
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute("DELETE FROM sessions WHERE expires_at <= NOW()")
        removed = cursor.rowcount
        connection.commit()
        cursor.close()
        return removed
    finally:
        connection.close()
