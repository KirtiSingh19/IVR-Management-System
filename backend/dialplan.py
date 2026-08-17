"""
Turning an IVR row into Asterisk dialplan.

Pure functions: they take the MySQL records and the list of extensions Asterisk
actually has, and return either dialplan lines or a reason why not. Nothing here
opens a socket, which is what makes the risky part — the text that ends up
controlling live calls — testable without a PBX.

WHAT IT GENERATES

One context for the entry extension and one per IVR for its menu, so an IVR's
options can never collide with another's:

    [ivrmanager-ivrs]
    exten = 5000,1,NoOp(IVR Manager: Main IVR)
    exten = 5000,n,Answer()
    exten = 5000,n,Playback(welcomeA)
    exten = 5000,n,Read(IVRDIGIT,,1,,3,5)
    exten = 5000,n,Goto(ivrmanager-ivr-25,${IVRDIGIT},1)
    exten = 5000,n,Hangup()

    [ivrmanager-ivr-25]
    exten = 1,1,NoOp(Sales)
    exten = 1,n,Dial(PJSIP/1002,20)
    exten = 1,n,Hangup()
    exten = i,1,Playback(invalid)
    exten = i,n,Goto(ivrmanager-ivrs,5000,1)
    exten = t,1,Playback(goodbye)
    exten = t,n,Hangup()

The shape follows the dialplan already on the server — Answer, Playback, Read,
Goto — rather than inventing a different idiom, so what the website writes reads
like what is already there.

WHAT IT REFUSES

Every destination is checked against the endpoints configured in pjsip.conf. A
menu pointing at an extension that does not exist would produce a dialplan that
dials nothing, and finding that out from a silent call is far worse than being
told at sync time.
"""

import re

# The one context the website owns. Nothing outside it is ever written, and
# [internal] reaches it through a single `include =>` line added by hand once.
ENTRY_CONTEXT = "ivrmanager-ivrs"

# Per-IVR menu context. Keyed on the database id, which is stable for the life of
# the record — unlike the extension, which a user can edit.
MENU_CONTEXT = "ivrmanager-ivr-{id}"

EXTENSION_PATTERN = re.compile(r"^\d{3,6}$")
DIGIT_PATTERN = re.compile(r"^[0-9*#]$")

# How long to ring a destination before giving up.
DIAL_TIMEOUT = 20

# Read(variable,filename,maxdigits,options,attempts,timeout) — one digit, three
# attempts, five seconds. Matches the Read() already in the server's dialplan.
READ_ARGS = "IVRDIGIT,,1,,3,5"


class DialplanError(Exception):
    """The IVR cannot be turned into a dialplan. Carries a user-facing reason."""

    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field


def sound_name(file_name):
    """
    An audio file name as Asterisk wants it: no directory, no extension.

    Playback(welcomeA) finds welcomeA.wav, welcomeA.gsm or whatever format is
    installed, so the extension is not just unnecessary — including it would make
    Asterisk look for "welcomeA.wav.wav".
    """
    stem = str(file_name or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
    if not stem:
        return ""
    # Only the final suffix, so "luvvoice.com-2026.mp3" keeps its dotted stem.
    if "." in stem:
        stem = stem.rsplit(".", 1)[0]
    return stem


def _escape(text):
    """
    Make a value safe to sit inside NoOp(...) in a dialplan line.

    Commas separate application arguments and ${...} is a variable reference, so a
    label like "Sales, EMEA" or "${EXTEN}" would otherwise change the meaning of
    the line it is written into. This is a generated-code boundary: the text comes
    from a database field a user typed.
    """
    cleaned = str(text or "").replace("\n", " ").replace("\r", " ")
    cleaned = cleaned.replace("$", "").replace(",", ";").replace("(", "[").replace(")", "]")
    return cleaned.strip()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate(ivr, allowed_destinations):
    """
    Check an IVR is fit to become dialplan.

    @param ivr  the serialised IVR, menu nested, as models.get_ivr returns it
    @param allowed_destinations  extensions Asterisk actually has configured
    @returns a list of non-fatal warnings
    @raises DialplanError on anything that would produce a broken dialplan
    """
    name = str(ivr.get("name") or "").strip()
    if not name:
        raise DialplanError("This IVR has no name.", "name")

    extension = str(ivr.get("extension") or "").strip()
    if not EXTENSION_PATTERN.match(extension):
        raise DialplanError(
            f"Extension {extension!r} is not 3 to 6 digits, so Asterisk could not route to it.",
            "extension",
        )

    if str(ivr.get("status", "")).lower() != "active":
        raise DialplanError(
            f"{name} is Inactive. Set it to Active before syncing, or it would answer "
            "calls the moment it reached Asterisk.",
            "status",
        )

    warnings = []
    if not ivr.get("welcome_audio"):
        warnings.append(f"{name} has no welcome prompt, so callers hear the menu immediately.")

    menu = ivr.get("menu") or []
    if not menu:
        warnings.append(f"{name} has no menu options, so callers can only hear the greeting.")

    seen = set()
    for option in menu:
        digit = str(option.get("digit") or "").strip()
        label = str(option.get("option_name") or "").strip() or f"option {digit}"

        if not DIGIT_PATTERN.match(digit):
            raise DialplanError(f"{label}: {digit!r} is not a single key a caller can press.", "digit")
        if digit in seen:
            raise DialplanError(f"Digit {digit} is used more than once in this menu.", "digit")
        seen.add(digit)

        kind = str(option.get("destination_type") or "extension").lower()
        if kind != "extension":
            raise DialplanError(
                f"{label}: destination type {kind!r} is not supported yet. "
                "This stage routes to extensions only.",
                "destination_type",
            )

        destination = str(option.get("destination") or "").strip()
        if not destination:
            raise DialplanError(f"{label}: no destination set.", "destination")
        if destination not in allowed_destinations:
            raise DialplanError(
                f"{label} (digit {digit}) points at {destination}, which is not a configured "
                "extension on Asterisk. Configured: "
                + (", ".join(sorted(allowed_destinations)) or "none")
                + ".",
                "destination",
            )

    return warnings


def unverified_sounds(ivr):
    """
    Sound names this dialplan will reference.

    Returned so the caller can say which prompts it could not confirm. The audio
    library lives on the web server; Asterisk plays from its own sounds directory,
    and AMI has no way to copy a file between them or to list what is installed at
    this permission level. A missing sound is not fatal — Asterisk logs it and
    carries on — but it is silent, so it is worth naming up front.
    """
    names = []
    welcome = sound_name(ivr.get("welcome_audio"))
    if welcome:
        names.append(welcome)
    for option in ivr.get("menu") or []:
        prompt = sound_name(option.get("audio_file"))
        if prompt:
            names.append(prompt)
    return sorted(set(names))


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def build(ivrs):
    """
    Dialplan for every IVR, as {context: [(key, value), ...]}.

    Ordered pairs rather than a dict per context, because `exten` repeats and a
    dict would keep only the last line.
    """
    entry_lines = []
    contexts = {}

    for ivr in sorted(ivrs, key=lambda item: str(item.get("extension", ""))):
        extension = str(ivr["extension"]).strip()
        menu_context = MENU_CONTEXT.format(id=ivr["id"])
        label = _escape(ivr.get("name"))

        entry_lines.append(("exten", f"{extension},1,NoOp(IVR Manager: {label})"))
        entry_lines.append(("exten", f"{extension},n,Answer()"))

        welcome = sound_name(ivr.get("welcome_audio"))
        if welcome:
            entry_lines.append(("exten", f"{extension},n,Playback({welcome})"))

        menu = ivr.get("menu") or []
        if menu:
            entry_lines.append(("exten", f"{extension},n,Read({READ_ARGS})"))
            entry_lines.append(
                ("exten", f"{extension},n,Goto({menu_context},${{IVRDIGIT}},1)")
            )
        entry_lines.append(("exten", f"{extension},n,Hangup()"))

        contexts[menu_context] = _menu_lines(ivr, extension, menu)

    contexts[ENTRY_CONTEXT] = entry_lines
    return contexts


def _menu_lines(ivr, extension, menu):
    lines = []
    for option in sorted(menu, key=lambda item: str(item.get("digit", ""))):
        digit = str(option["digit"]).strip()
        label = _escape(option.get("option_name"))
        destination = str(option["destination"]).strip()

        lines.append(("exten", f"{digit},1,NoOp({label})"))
        prompt = sound_name(option.get("audio_file"))
        if prompt:
            # Played before the transfer, matching what the website's simulator
            # does when a caller presses this key.
            lines.append(("exten", f"{digit},n,Playback({prompt})"))
        lines.append(("exten", f"{digit},n,Dial(PJSIP/{destination},{DIAL_TIMEOUT})"))
        lines.append(("exten", f"{digit},n,Hangup()"))

    # A caller who presses something unmapped is sent back to the greeting rather
    # than dropped, which is what the server's existing IVR does.
    lines.append(("exten", "i,1,NoOp(Invalid entry)"))
    lines.append(("exten", f"i,n,Goto({ENTRY_CONTEXT},{extension},1)"))
    lines.append(("exten", "t,1,NoOp(No entry)"))
    lines.append(("exten", "t,n,Hangup()"))
    return lines


def render(contexts):
    """
    The generated dialplan as text.

    Not what gets written — UpdateConfig sends structured pairs — but what the API
    returns so the result can be read and diffed without shelling into the PBX.
    """
    out = [
        "; Managed by IVR Manager. Generated from MySQL — do not edit by hand.",
        "; Every change here is overwritten on the next sync.",
        "",
    ]
    for name in sorted(contexts, key=lambda item: (item != ENTRY_CONTEXT, item)):
        out.append(f"[{name}]")
        out.extend(f"{key} = {value}" for key, value in contexts[name])
        out.append("")
    return "\n".join(out)
