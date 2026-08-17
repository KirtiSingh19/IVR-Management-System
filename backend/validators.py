"""
Request validation.

The rules here are deliberately the same rules as js/utils.js. The frontend
validates so the user gets an answer without a round trip; the backend validates
because the frontend is not a security boundary and the API is reachable from
curl, Postman and the browser address bar.

Every failure carries the field it belongs to, so js/api.js can hand it back to
the exact input the user typed into.
"""

import re

import audio_store
from config import MAX_AUDIO_BYTES

NAME_MIN = 3
NAME_MAX = 60
DESCRIPTION_MAX = 160
OPTION_NAME_MAX = 40

EXTENSION_PATTERN = re.compile(r"^\d{3,6}$")

# `*` and `#` are allowed alongside 0-9 because the frontend has always allowed
# them (js/utils.js LIMITS.digitPattern) and callers really can press them.
DIGIT_PATTERN = re.compile(r"^[0-9*#]$")

STATUSES = ("Active", "Inactive")

DESTINATION_TYPES = ("extension", "queue", "voicemail", "hangup")


class ValidationError(Exception):
    """A request broke a business rule. The handler turns this into HTTP 400."""

    def __init__(self, field, message):
        super().__init__(message)
        self.field = field
        self.message = message


class NotFoundError(Exception):
    """An id did not resolve. The handler turns this into HTTP 404."""


def _text(value):
    """Normalise any incoming scalar to a trimmed string."""
    if value is None:
        return ""
    return str(value).strip()


# ---------------------------------------------------------------------------
# IVR fields
# ---------------------------------------------------------------------------


def clean_name(value):
    name = _text(value)
    if not name:
        raise ValidationError("name", "Enter a name for this IVR.")
    if len(name) < NAME_MIN:
        raise ValidationError("name", f"Use at least {NAME_MIN} characters.")
    if len(name) > NAME_MAX:
        raise ValidationError("name", f"Use {NAME_MAX} characters or fewer.")
    return name


def clean_extension(value):
    extension = _text(value)
    if not extension:
        raise ValidationError("extension", "Enter an extension.")
    if not EXTENSION_PATTERN.match(extension):
        raise ValidationError("extension", "Use 3 to 6 digits, numbers only.")
    return extension


def clean_description(value):
    description = _text(value)
    if len(description) > DESCRIPTION_MAX:
        raise ValidationError("description", f"Use {DESCRIPTION_MAX} characters or fewer.")
    return description


def clean_status(value):
    """
    Accepted case-insensitively so that "active" from an older client, or
    "Active" from the documented contract, both work. Stored capitalised to
    match the ENUM.
    """
    status = _text(value).lower()
    if not status:
        return "Active"
    for candidate in STATUSES:
        if candidate.lower() == status:
            return candidate
    raise ValidationError("status", "Status must be Active or Inactive.")


def clean_welcome_audio(value):
    audio = _text(value)
    if len(audio) > 255:
        raise ValidationError("welcome_audio", "That file name is too long.")
    return audio or None


# ---------------------------------------------------------------------------
# Menu options
# ---------------------------------------------------------------------------


def clean_menu(raw_menu):
    """
    Validate a whole menu at once.

    Doing it as a set rather than per row is what makes the duplicate-digit check
    possible before anything is written, so a bad request never leaves a partly
    replaced menu behind.
    """
    if raw_menu is None:
        return []
    if not isinstance(raw_menu, list):
        raise ValidationError("menu", "The menu must be a list of options.")

    cleaned = []
    seen_digits = {}

    for index, raw_option in enumerate(raw_menu):
        if not isinstance(raw_option, dict):
            raise ValidationError("menu", f"Menu option {index + 1} is not an object.")

        digit = _text(raw_option.get("digit"))
        if not digit:
            raise ValidationError("digit", "Choose a digit.")
        if not DIGIT_PATTERN.match(digit):
            raise ValidationError("digit", "Use a single digit 0-9, * or #.")
        if digit in seen_digits:
            raise ValidationError(
                "digit", f"Digit {digit} is already assigned to {seen_digits[digit]}."
            )

        option_name = _text(raw_option.get("option_name"))
        if not option_name:
            raise ValidationError("label", "Enter a label.")
        if len(option_name) > OPTION_NAME_MAX:
            raise ValidationError("label", f"Use {OPTION_NAME_MAX} characters or fewer.")

        destination = _text(raw_option.get("destination"))
        if not destination:
            raise ValidationError("destination", "Enter a destination.")
        if len(destination) > 50:
            raise ValidationError("destination", "That destination is too long.")

        destination_type = _text(raw_option.get("destination_type")) or "extension"
        if destination_type not in DESTINATION_TYPES:
            raise ValidationError(
                "destination_type",
                f"Destination type must be one of: {', '.join(DESTINATION_TYPES)}.",
            )

        # Optional: an option with no prompt simply transfers in silence, which is
        # how every option behaved before this field existed. Not checked against
        # the library here, for the same reason ivrs.welcome_audio is not — a
        # prompt deleted later must not make every menu holding it unsavable.
        audio_file = _text(raw_option.get("audio_file"))
        if len(audio_file) > 255:
            raise ValidationError("audio_file", "That prompt file name is too long.")

        seen_digits[digit] = option_name
        cleaned.append(
            {
                "digit": digit,
                "option_name": option_name,
                "destination_type": destination_type,
                "destination": destination,
                "audio_file": audio_file or None,
            }
        )

    return cleaned


# ---------------------------------------------------------------------------
# Audio uploads
# ---------------------------------------------------------------------------


def clean_audio_upload(display_name, size_bytes, duration_seconds):
    """
    Check an upload before a single byte is written.

    The name is validated for what it *is*, not for where it might point: the
    stored path is generated separately and never derived from this string, so
    path traversal is not a concern here. What is a concern is an empty name, an
    absurd length, or a format the browser cannot play back.

    Errors carry the field "file", which is what the upload control shows.
    """
    name = _text(display_name)
    if not name:
        raise ValidationError("file", "That upload had no file name.")

    # Strip any directory part a client may have sent. Windows separators too,
    # because a name from a Windows browser can carry backslashes.
    name = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or name in (".", ".."):
        raise ValidationError("file", "That file name is not usable.")
    if len(name) > 255:
        raise ValidationError("file", "That file name is too long.")

    fmt = audio_store.format_of(name)
    if not fmt:
        raise ValidationError("file", "That file has no extension, so its format is unknown.")
    if fmt not in audio_store.ALLOWED_FORMATS:
        raise ValidationError(
            "file",
            f"{fmt} files are not supported. Use {', '.join(audio_store.ALLOWED_FORMATS)}.",
        )

    if size_bytes <= 0:
        raise ValidationError("file", "That file is empty.")
    if size_bytes > MAX_AUDIO_BYTES:
        raise ValidationError(
            "file", f"That file is larger than the {MAX_AUDIO_BYTES // (1024 * 1024)} MB limit."
        )

    try:
        duration = max(0, int(float(duration_seconds or 0)))
    except (TypeError, ValueError):
        duration = 0

    return {"name": name, "format": fmt, "size_bytes": size_bytes, "duration_seconds": duration}


# ---------------------------------------------------------------------------
# Whole payloads
# ---------------------------------------------------------------------------


def clean_create(payload):
    """Everything is required on create, so every field is validated."""
    if not isinstance(payload, dict):
        raise ValidationError(None, "Send a JSON object.")

    return {
        "name": clean_name(payload.get("name")),
        "extension": clean_extension(payload.get("extension")),
        "description": clean_description(payload.get("description")),
        "status": clean_status(payload.get("status")),
        "welcome_audio": clean_welcome_audio(payload.get("welcome_audio")),
        "menu": clean_menu(payload.get("menu")),
    }


def clean_update(payload):
    """
    A partial update: only the keys present are validated and applied.

    This matters for the menu in particular. The edit form saves IVR details
    without touching the menu, and the flow builder saves the menu without
    touching the details. So an absent "menu" key means "leave the menu alone",
    while "menu": [] means "this IVR now has no options". Treating absent as
    empty would wipe a menu every time somebody renamed an IVR.
    """
    if not isinstance(payload, dict):
        raise ValidationError(None, "Send a JSON object.")

    fields = {}
    if "name" in payload:
        fields["name"] = clean_name(payload["name"])
    if "extension" in payload:
        fields["extension"] = clean_extension(payload["extension"])
    if "description" in payload:
        fields["description"] = clean_description(payload["description"])
    if "status" in payload:
        fields["status"] = clean_status(payload["status"])
    if "welcome_audio" in payload:
        fields["welcome_audio"] = clean_welcome_audio(payload["welcome_audio"])

    menu = clean_menu(payload["menu"]) if "menu" in payload else None

    if not fields and menu is None:
        raise ValidationError(None, "Nothing to update.")

    return fields, menu
