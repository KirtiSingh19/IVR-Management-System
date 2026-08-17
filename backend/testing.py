"""
Read the IVR / dialplan configuration out of a running Asterisk server.

A standalone probe. It does not import, touch or depend on anything else in this
project, and it never writes to Asterisk or to MySQL — it opens a socket, logs
in, asks one question, and prints JSON.

    python testing.py                     every IVR context it can find
    python testing.py --context main-ivr  just that one
    python testing.py --raw               every context, unfiltered
    python testing.py --selftest          parse a built-in sample, no server needed

WHAT THIS READS

Asterisk's Manager Interface (AMI) on TCP 5038, using the ShowDialPlan action.
That returns the dialplan Asterisk is *currently running* — which is not the same
thing as the text of extensions.conf. Includes, AEL and realtime are already
resolved, and an edit that has not been reloaded will not appear. That is usually
what you want: it is the configuration actually answering calls.

ShowDialPlan needs only the `config` read class in manager.conf. It cannot change
anything. This deliberately avoids `Action: Command`, which would need the
`command` class — that permission can run any CLI command on the box, which is
far more access than reading a dialplan should require.

CREDENTIALS

From the environment, or from a .env file beside this script:

    ASTERISK_HOST=192.168.1.50
    ASTERISK_PORT=5038
    ASTERISK_USERNAME=ivrmanager
    ASTERISK_SECRET=...
    ASTERISK_TIMEOUT=10
    ASTERISK_IVR_CONTEXTS=main-ivr,support-ivr   # optional, see below

Nothing is hard-coded and no secret is printed.

A NOTE ON OPTION LABELS

Asterisk has no field for "this option is called Sales". A dialplan stores what
to *do*, not what to call it — the human label lives in a comment, and comments
are not part of the running dialplan. So `option_name` below is derived from the
destination (the target context name, the queue name, the prompt file) and is
marked with `option_name_source` so you can see it was inferred rather than read.
The only way to get true labels is to parse the raw extensions.conf text.
"""

import argparse
import json
import os
import re
import socket
import sys
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"

# Extensions Asterisk gives a special meaning to, rather than menu keys.
SPECIAL_EXTENSIONS = {
    "s": "start",
    "i": "invalid entry",
    "t": "timeout",
    "h": "hangup",
    "o": "operator",
    "a": "assistant",
    "e": "error",
    "T": "absolute timeout",
}

# A single key a caller can actually press.
DIGIT_PATTERN = re.compile(r"^[0-9*#]$")

# Applications that play something to the caller.
AUDIO_APPS = {"background", "backgrounddetect", "playback", "streamfile"}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def load_env_file(path=ENV_PATH):
    """
    Read KEY=VALUE lines from a .env file into os.environ.

    A real environment variable always wins, so exporting ASTERISK_SECRET in the
    shell overrides whatever is on disk.
    """
    if not path.exists():
        return False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return True


def read_settings():
    """Collect the connection settings, failing clearly on anything missing."""
    load_env_file()

    missing = [
        name
        for name in ("ASTERISK_HOST", "ASTERISK_USERNAME", "ASTERISK_SECRET")
        if not os.environ.get(name, "").strip()
    ]
    if missing:
        raise SystemExit(
            "Missing Asterisk settings: "
            + ", ".join(missing)
            + f"\nAdd them to {ENV_PATH} or export them, then run this again."
        )

    return {
        "host": os.environ["ASTERISK_HOST"].strip(),
        "port": int(os.environ.get("ASTERISK_PORT", "5038")),
        "username": os.environ["ASTERISK_USERNAME"].strip(),
        "secret": os.environ["ASTERISK_SECRET"],
        "timeout": float(os.environ.get("ASTERISK_TIMEOUT", "10")),
        "ivr_contexts": [
            name.strip()
            for name in os.environ.get("ASTERISK_IVR_CONTEXTS", "").split(",")
            if name.strip()
        ],
    }


# ---------------------------------------------------------------------------
# The AMI wire protocol
# ---------------------------------------------------------------------------


class AmiError(Exception):
    """The server refused a login, or the conversation broke down."""


class AmiClient:
    """
    A minimal AMI client, standard library only.

    AMI is a line protocol: a packet is a run of "Key: Value" lines ended by a
    blank line. Values may themselves contain a colon, so lines are split on the
    first one only. Packets are reassembled from a buffer rather than read
    line-by-line, because one recv() can straddle any number of them.
    """

    def __init__(self, host, port, timeout=10):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.sock = None
        self.buffer = b""
        self.greeting = ""

    # -- connection ---------------------------------------------------------

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock.settimeout(self.timeout)
        # Asterisk announces itself with one bare line before any packet.
        self.greeting = self._read_line().strip()
        if "asterisk" not in self.greeting.lower():
            raise AmiError(
                f"{self.host}:{self.port} answered, but not with an Asterisk AMI greeting: "
                f"{self.greeting!r}. Is something else listening on that port?"
            )
        return self.greeting

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_exc):
        # Best effort: if the link is already broken there is nothing to say.
        try:
            self.send({"Action": "Logoff"})
        except OSError:
            pass
        self.close()

    # -- reading ------------------------------------------------------------

    def _fill(self):
        try:
            chunk = self.sock.recv(8192)
        except socket.timeout as error:
            raise AmiError(
                f"Asterisk stopped responding after {self.timeout}s."
            ) from error
        if not chunk:
            raise AmiError("Asterisk closed the connection.")
        self.buffer += chunk

    def _read_line(self):
        while b"\r\n" not in self.buffer:
            self._fill()
        line, _, self.buffer = self.buffer.partition(b"\r\n")
        return line.decode("utf-8", errors="replace")

    def read_packet(self):
        """One packet, as an ordered dict of its fields."""
        while b"\r\n\r\n" not in self.buffer:
            self._fill()
        raw, _, self.buffer = self.buffer.partition(b"\r\n\r\n")

        packet = {}
        for line in raw.decode("utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            key, separator, value = line.partition(":")
            if not separator:
                continue
            packet[key.strip()] = value.strip()
        return packet

    # -- writing ------------------------------------------------------------

    def send(self, fields):
        payload = "".join(f"{key}: {value}\r\n" for key, value in fields.items()) + "\r\n"
        self.sock.sendall(payload.encode("utf-8"))

    # -- conversation -------------------------------------------------------

    def login(self, username, secret):
        """
        Authenticate.

        `Events: off` asks Asterisk not to push unrelated call traffic down this
        connection. Without it a busy PBX interleaves live channel events with the
        dialplan listing, which is noise this script would have to filter out of
        every read.
        """
        self.send(
            {
                "Action": "Login",
                "Username": username,
                "Secret": secret,
                "Events": "off",
            }
        )
        response = self.read_packet()
        if response.get("Response", "").lower() != "success":
            raise AmiError(
                "Asterisk rejected the login: "
                + (response.get("Message") or "no reason given")
                + "\nCheck ASTERISK_USERNAME / ASTERISK_SECRET, and that this machine's IP "
                "is allowed by the permit= line in manager.conf."
            )
        return response

    def show_dialplan(self, context=None, action_id="dialplan-1"):
        """
        Run ShowDialPlan and collect its ListDialplan events.

        Every event is matched on ActionID. Even with `Events: off` the protocol
        allows other traffic on the socket, and picking the wrong packets here
        would silently corrupt the result.
        """
        request = {"Action": "ShowDialPlan", "ActionID": action_id}
        if context:
            request["Context"] = context
        self.send(request)

        first = self.read_packet()
        if first.get("Response", "").lower() == "error":
            raise AmiError(
                "ShowDialPlan was refused: "
                + (first.get("Message") or "no reason given")
                + "\nShowDialPlan carries the `config` authority, and Asterisk checks an "
                "action's authority against the user's write class. So manager.conf needs "
                "both `read = config` and `write = config` for this user."
            )

        entries = []
        while True:
            packet = self.read_packet()
            if packet.get("ActionID") not in (action_id, None):
                continue

            event = packet.get("Event", "")
            if event == "ShowDialPlanComplete":
                break
            if event == "ListDialplan":
                entries.append(packet)
            # Anything else on this ActionID is not part of the listing.

        if context and not entries:
            raise AmiError(
                f"Asterisk returned no dialplan for context {context!r}. "
                "Check the name with: asterisk -rx 'dialplan show'"
            )
        return entries


# ---------------------------------------------------------------------------
# Making sense of the dialplan
# ---------------------------------------------------------------------------


def split_args(app_data):
    """Application arguments, on commas. Empty string gives an empty list."""
    data = (app_data or "").strip()
    return [part.strip() for part in data.split(",")] if data else []


def prompt_from_step(step):
    """
    The sound file a step plays to the caller, or None.

    Read() is special-cased because its prompt is the *second* argument —
    Read(DIGIT,,1,,3,5) reads a digit with no prompt of its own, while
    Read(DIGIT,menu,1) plays "menu" first. Treating Read like Playback would
    report the variable name as the audio file.
    """
    app = (step.get("application") or "").strip().lower()
    args = split_args(step.get("app_data"))

    if app in AUDIO_APPS:
        return args[0] if args else None
    if app == "read":
        return args[1] if len(args) > 1 and args[1] else None
    return None


def describe_action(application, app_data):
    """
    Turn one dialplan application into a destination type and a destination.

    The mapping is deliberately explicit rather than clever. An unrecognised
    application is reported as-is with type "other", so a dialplan using something
    this does not know about produces an honest unknown rather than a wrong guess.
    """
    app = (application or "").strip()
    lowered = app.lower()
    args = split_args(app_data)
    first = args[0] if args else ""

    if lowered == "goto" or lowered == "gotoif":
        # Goto(context,exten,priority) | Goto(exten,priority) | Goto(priority)
        if len(args) >= 3:
            return "context", args[0]
        if len(args) == 2:
            return "extension", args[0]
        return "priority", first

    if lowered in ("gosub", "gosubif", "macro"):
        return "subroutine", first

    if lowered == "dial":
        # Dial(PJSIP/6001,20,tT) -> the channel is the first argument.
        channel = first
        # "PJSIP/6001" reads better as extension 6001; keep the whole thing too.
        return "extension", channel.split("/", 1)[1] if "/" in channel else channel

    if lowered == "queue":
        return "queue", first

    if lowered == "voicemail" or lowered == "voicemailmain":
        return "voicemail", first

    if lowered == "hangup":
        return "hangup", ""

    if lowered in AUDIO_APPS:
        return "audio", first

    return "other", app_data or ""


def label_from(destination_type, destination, application):
    """
    A best-effort human name for a menu option.

    Asterisk stores no such thing, so this is inferred from whatever carries
    meaning — usually the target context or queue name, since people name those
    after the department. Returned alongside its source so the caller can tell
    this apart from real data.
    """
    if destination_type == "voicemail" and destination:
        return f"Voicemail {destination.split('@', 1)[0]}", "derived from voicemail"

    if destination:
        stem = destination.split("@", 1)[0].split("/", 1)[-1]
        stem = re.sub(r"[-_]+", " ", stem).strip()
        # "sales-ivr" and "sales_queue" both read as "Sales"; a bare number does not.
        words = [w for w in stem.split() if w.lower() not in ("ivr", "queue", "menu", "ctx")]
        if words and not stem.isdigit():
            return " ".join(word.capitalize() for word in words), f"derived from {destination_type}"
        if stem.isdigit():
            return f"Extension {stem}", "derived from destination"
    return application or "Unknown", "derived from application"


def group_by_context(entries):
    """
    Reshape flat ListDialplan events into {context: [step, ...]}.

    Includes and switches are kept, because a context that only forwards into
    another one is still part of how a call flows.
    """
    contexts = {}
    for entry in entries:
        context = entry.get("Context")
        if not context:
            continue
        bucket = contexts.setdefault(context, {"steps": [], "includes": []})

        if entry.get("IncludeContext"):
            bucket["includes"].append(entry["IncludeContext"])
            continue

        extension = entry.get("Extension")
        if extension is None:
            continue

        bucket["steps"].append(
            {
                "extension": extension,
                "priority": entry.get("Priority", ""),
                "application": entry.get("Application", ""),
                "app_data": entry.get("AppData", ""),
                "registrar": entry.get("Registrar", ""),
            }
        )
    return contexts


def looks_like_ivr(bucket):
    """
    Decide whether a context is a caller-facing menu.

    Asterisk does not mark contexts as IVRs, so this reads the shape: a menu is a
    context offering several single keys a caller can press.

    "Waits for input" was originally enough on its own, and that was wrong. A real
    dialplan splits the two halves across contexts —

        [internal]   exten => 5000,1,Answer()
                          same => n,Playback(welcomeA)
                          same => n,Read(DIGIT,,1,,3,5)
                          same => n,Goto(ivr-menu,${DIGIT},1)
        [ivr-menu]   exten => 1,1,Dial(PJSIP/1001,20)
                     exten => 2,1,Dial(PJSIP/1002,20)

    — so the context that waits for a key holds no options at all, and reporting
    it as an IVR produced a record with an empty menu. The options are what make a
    menu, so that is what is counted. The prompt is then found by following the
    entry back, in find_entry_prompt().

    The test is therefore: at least one key a caller can press, and then either
    more than one of them or a prompt inviting the press. One key with a greeting
    is a real menu; one key with no greeting is more likely a fragment of routing
    that happens to be named with a digit.

    Use ASTERISK_IVR_CONTEXTS to override this when your naming does not fit.
    """
    steps = bucket["steps"]
    digit_extensions = {
        step["extension"] for step in steps if DIGIT_PATTERN.match(step["extension"])
    }
    if not digit_extensions:
        return False

    prompts_caller = any(
        step["application"].lower() in ("waitexten", "read") or prompt_from_step(step)
        for step in steps
    )
    return len(digit_extensions) >= 2 or prompts_caller


def find_entry_extensions(contexts, target):
    """
    Which numbers a caller can dial to reach this context.

    Found by scanning every other context for a step that jumps here. This is how
    "extension 5000 reaches the main IVR" is recovered — the IVR context itself has
    no idea what number leads to it.
    """
    reached_by = []
    for name, bucket in contexts.items():
        if name == target:
            continue
        for step in bucket["steps"]:
            kind, destination = describe_action(step["application"], step["app_data"])
            if kind in ("context", "subroutine") and destination == target:
                reached_by.append({"context": name, "extension": step["extension"]})
    return reached_by


def find_entry_prompt(contexts, entry_points):
    """
    The prompt played on the way into a menu, from the context that jumps to it.

    Needed because the greeting and the options frequently live in different
    contexts: the entry extension answers, plays the welcome file and reads a
    digit, then hands off to a context that contains nothing but the options. The
    menu context has no prompt of its own, so it has to be followed backwards.
    """
    for point in entry_points:
        source = contexts.get(point["context"])
        if not source:
            continue
        for step in source["steps"]:
            if step["extension"] != point["extension"]:
                continue
            prompt = prompt_from_step(step)
            if prompt:
                return prompt, f"{point['context']},{point['extension']}"
    return "", ""


def summarise_context(name, bucket, contexts):
    """Everything worth knowing about one IVR context, in a flat shape."""
    steps = bucket["steps"]

    welcome_audio = ""
    welcome_audio_from = ""
    for step in steps:
        if step["extension"] in ("s", "start"):
            prompt = prompt_from_step(step)
            if prompt:
                welcome_audio = prompt
                welcome_audio_from = f"{name},s"
                break

    menu = []
    for step in steps:
        digit = step["extension"]
        if not DIGIT_PATTERN.match(digit):
            continue
        # The first priority is the one the caller actually lands on; later
        # priorities are the rest of that option's script, not separate options.
        if step["priority"] not in ("1", "", None):
            continue

        destination_type, destination = describe_action(step["application"], step["app_data"])
        option_name, source = label_from(destination_type, destination, step["application"])
        menu.append(
            {
                "digit": digit,
                "option_name": option_name,
                "option_name_source": source,
                "action": step["application"],
                "destination_type": destination_type,
                "destination": destination,
                "raw": f"{step['application']}({step['app_data']})",
            }
        )

    menu.sort(key=lambda option: (option["digit"].isdigit() is False, option["digit"]))

    entry_points = find_entry_extensions(contexts, name)

    # The dialable number for this IVR, if it has one. Entry points reached from a
    # single key are menu selections inside a parent menu, not numbers anybody can
    # dial — reporting "sales-ivr is on extension 1" would be plainly wrong.
    dialable = next(
        (point["extension"] for point in entry_points if not DIGIT_PATTERN.match(point["extension"])),
        None,
    )
    special = {
        SPECIAL_EXTENSIONS[step["extension"]]: f"{step['application']}({step['app_data']})"
        for step in steps
        if step["extension"] in SPECIAL_EXTENSIONS and step["priority"] in ("1", "")
    }

    # Nothing in this context greets the caller, so follow the entry back to
    # whichever context does.
    if not welcome_audio:
        welcome_audio, welcome_audio_from = find_entry_prompt(contexts, entry_points)

    return {
        "context": name,
        "extension": dialable,
        "reached_from": entry_points,
        "welcome_audio": welcome_audio,
        "welcome_audio_from": welcome_audio_from,
        "includes": bucket["includes"],
        "special_extensions": special,
        "menu": menu,
    }


def build_report(entries, only_context=None, ivr_contexts=(), include_all=False):
    contexts = group_by_context(entries)

    if only_context:
        wanted = [only_context] if only_context in contexts else []
    elif ivr_contexts:
        wanted = [name for name in ivr_contexts if name in contexts]
    elif include_all:
        wanted = sorted(contexts)
    else:
        wanted = sorted(name for name, bucket in contexts.items() if looks_like_ivr(bucket))

    return {
        "source": "asterisk-ami:ShowDialPlan",
        "contexts_found": len(contexts),
        "contexts_reported": len(wanted),
        "all_context_names": sorted(contexts),
        "ivrs": [summarise_context(name, contexts[name], contexts) for name in wanted],
    }


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------

SAMPLE_EVENTS = """\
Event: ListDialplan\r\nActionID: t\r\nContext: from-internal\r\nExtension: 5000\r\nPriority: 1\r\nApplication: Goto\r\nAppData: main-ivr,s,1\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: s\r\nPriority: 1\r\nApplication: Answer\r\nAppData: \r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: s\r\nPriority: 2\r\nApplication: Background\r\nAppData: welcome\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: s\r\nPriority: 3\r\nApplication: WaitExten\r\nAppData: 5\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: 1\r\nPriority: 1\r\nApplication: Goto\r\nAppData: sales-ivr,s,1\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: 2\r\nPriority: 1\r\nApplication: Queue\r\nAppData: support-queue\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: 3\r\nPriority: 1\r\nApplication: Dial\r\nAppData: PJSIP/6001,20\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: 0\r\nPriority: 1\r\nApplication: VoiceMail\r\nAppData: 7000@default\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: i\r\nPriority: 1\r\nApplication: Playback\r\nAppData: invalid\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: main-ivr\r\nExtension: t\r\nPriority: 1\r\nApplication: Hangup\r\nAppData: \r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: sales-ivr\r\nExtension: s\r\nPriority: 1\r\nApplication: Background\r\nAppData: sales-menu\r\n\r\n\
Event: ListDialplan\r\nActionID: t\r\nContext: sales-ivr\r\nExtension: 1\r\nPriority: 1\r\nApplication: Dial\r\nAppData: PJSIP/6010\r\n\r\n\
Event: ShowDialPlanComplete\r\nActionID: t\r\nEventList: Complete\r\nListItems: 12\r\n\r\n"""


def _event(**fields):
    return "".join(f"{key}: {value}\r\n" for key, value in fields.items()) + "\r\n"


# Transcribed from a real `dialplan show` on Asterisk 22: an IVR whose greeting
# and options live in different contexts, alongside the stock demo contexts that
# ship with Ubuntu's package. Both halves matter — the split shape is what the
# parser has to get right, and the demo noise is what it has to see past.
LIVE_EVENTS = "".join(
    [
        _event(Event="ListDialplan", ActionID="t", Context="internal", Extension="5000",
               Priority="1", Application="Answer", AppData=""),
        _event(Event="ListDialplan", ActionID="t", Context="internal", Extension="5000",
               Priority="2", Application="Playback", AppData="welcomeA"),
        _event(Event="ListDialplan", ActionID="t", Context="internal", Extension="5000",
               Priority="3", Application="Read", AppData="DIGIT,,1,,3,5"),
        _event(Event="ListDialplan", ActionID="t", Context="internal", Extension="5000",
               Priority="4", Application="Goto", AppData="ivr-menu,${DIGIT},1"),
        _event(Event="ListDialplan", ActionID="t", Context="internal", Extension="5000",
               Priority="5", Application="Hangup", AppData=""),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="1",
               Priority="1", Application="Dial", AppData="PJSIP/1001,20"),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="1",
               Priority="2", Application="Hangup", AppData=""),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="2",
               Priority="1", Application="Dial", AppData="PJSIP/1002,20"),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="3",
               Priority="1", Application="Dial", AppData="PJSIP/1003,20"),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="4",
               Priority="1", Application="Dial", AppData="PJSIP/1004,20"),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="7000",
               Priority="2", Application="ConfBridge", AppData="7000"),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="i",
               Priority="1", Application="Playback", AppData="Invalid"),
        _event(Event="ListDialplan", ActionID="t", Context="ivr-menu", Extension="t",
               Priority="1", Application="Playback", AppData="goodbye"),
        _event(Event="ListDialplan", ActionID="t", Context="parkedcalls", Extension="701",
               Priority="1", Application="ParkedCall", AppData="default,701"),
        _event(Event="ListDialplan", ActionID="t", Context="stdexten", Extension="a",
               Priority="1", Application="VoiceMailMain", AppData="${mbx}"),
        _event(Event="ShowDialPlanComplete", ActionID="t", EventList="Complete", ListItems="15"),
    ]
)


class _FakeSocket:
    """Hands out a canned byte stream in small pieces, to exercise the framing."""

    def __init__(self, payload):
        self.payload = payload
        self.position = 0

    def recv(self, size):
        chunk = self.payload[self.position : self.position + min(size, 7)]
        self.position += len(chunk)
        return chunk

    def sendall(self, _data):
        return None

    def settimeout(self, _t):
        return None

    def close(self):
        return None


def _parse_stream(payload):
    """Run a canned byte stream through the real client and parser."""
    client = AmiClient("sample", 0)
    client.sock = _FakeSocket(payload.encode())

    entries = []
    while True:
        packet = client.read_packet()
        if packet.get("Event") == "ShowDialPlanComplete":
            break
        if packet.get("Event") == "ListDialplan":
            entries.append(packet)
    return build_report(entries)


def check_live_shape():
    """
    The split-context IVR taken from a real server.

    This is the case the first version of this script got wrong, so it is worth
    asserting rather than eyeballing.
    """
    report = _parse_stream(LIVE_EVENTS)
    problems = []
    ivrs = {ivr["context"]: ivr for ivr in report["ivrs"]}

    if set(ivrs) != {"ivr-menu"}:
        problems.append(
            f"only ivr-menu holds options, so only it is an IVR; got {sorted(ivrs)}"
        )
        return report, problems

    menu = ivrs["ivr-menu"]
    if menu["extension"] != "5000":
        problems.append(f"should be dialable on 5000, got {menu['extension']!r}")
    if menu["welcome_audio"] != "welcomeA":
        problems.append(f"greeting lives in [internal]; got {menu['welcome_audio']!r}")
    if menu["welcome_audio_from"] != "internal,5000":
        problems.append(f"greeting source wrong: {menu['welcome_audio_from']!r}")

    got = {option["digit"]: option["destination"] for option in menu["menu"]}
    if got != {"1": "1001", "2": "1002", "3": "1003", "4": "1004"}:
        problems.append(f"menu wrong: {got}")
    if any(option["digit"] == "7000" for option in menu["menu"]):
        problems.append("7000 is a conference extension, not a key a caller can press")
    if menu["special_extensions"].get("invalid entry") != "Playback(Invalid)":
        problems.append("the invalid-entry prompt was missed")
    return report, problems


def run_selftest():
    """
    Parse realistic samples without touching the network.

    Worth having for its own sake: it proves the packet framing and the dialplan
    mapping work before any of it is blamed on the server or the credentials.
    """
    report = _parse_stream(SAMPLE_EVENTS)
    print(json.dumps(report, indent=2))

    problems = []
    ivrs = {ivr["context"]: ivr for ivr in report["ivrs"]}
    if set(ivrs) != {"main-ivr", "sales-ivr"}:
        problems.append(f"expected the two IVR contexts, found {sorted(ivrs)}")
    else:
        main = ivrs["main-ivr"]
        if main["extension"] != "5000":
            problems.append(f"entry extension should be 5000, got {main['extension']}")
        if main["welcome_audio"] != "welcome":
            problems.append(f"welcome audio should be welcome, got {main['welcome_audio']}")
        got = {
            option["digit"]: (option["destination_type"], option["destination"], option["option_name"])
            for option in main["menu"]
        }
        expected = {
            "0": ("voicemail", "7000@default", "Voicemail 7000"),
            "1": ("context", "sales-ivr", "Sales"),
            "2": ("queue", "support-queue", "Support"),
            "3": ("extension", "6001", "Extension 6001"),
        }
        if got != expected:
            problems.append(f"menu mapping wrong:\n  expected {expected}\n  got      {got}")
        if main["special_extensions"].get("timeout") != "Hangup()":
            problems.append("the timeout extension was not picked up")
        # sales-ivr is only ever reached by pressing 1 inside main-ivr, so it has
        # no dialable number of its own and must not claim extension "1".
        if ivrs["sales-ivr"]["extension"] is not None:
            problems.append(
                f"sales-ivr should have no dialable extension, got {ivrs['sales-ivr']['extension']!r}"
            )

    print("\n--- self test ---", file=sys.stderr)
    for problem in problems:
        print(f"FAIL  [synthetic] {problem}", file=sys.stderr)
    if not problems:
        print("PASS  [synthetic]  single-context IVR, all five action types", file=sys.stderr)

    live_report, live_problems = check_live_shape()
    for problem in live_problems:
        print(f"FAIL  [live shape] {problem}", file=sys.stderr)
    if not live_problems:
        print(
            "PASS  [live shape] split-context IVR: greeting in [internal], options in [ivr-menu]",
            file=sys.stderr,
        )

    print("\n--- what your server's IVR will look like ---", file=sys.stderr)
    print(json.dumps(live_report["ivrs"], indent=2), file=sys.stderr)

    return 1 if (problems or live_problems) else 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Fetch IVR / dialplan configuration from Asterisk over AMI.",
    )
    parser.add_argument("--context", help="only this dialplan context")
    parser.add_argument(
        "--raw", action="store_true", help="report every context, not just the IVR-shaped ones"
    )
    parser.add_argument("--out", help="also write the JSON to this file")
    parser.add_argument(
        "--selftest", action="store_true", help="parse a built-in sample; no server needed"
    )
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest()

    settings = read_settings()

    try:
        with AmiClient(settings["host"], settings["port"], settings["timeout"]) as client:
            print(
                f"[testing] connected to {settings['host']}:{settings['port']} — {client.greeting}",
                file=sys.stderr,
            )
            client.login(settings["username"], settings["secret"])
            print("[testing] authenticated", file=sys.stderr)

            entries = client.show_dialplan(context=args.context)
            print(f"[testing] {len(entries)} dialplan entries returned", file=sys.stderr)
    except AmiError as error:
        print(f"[testing] {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(
            f"[testing] could not reach {settings['host']}:{settings['port']} — {error}\n"
            "Check the host, that manager.conf has enabled=yes, and that bindaddr is not "
            "127.0.0.1 if Asterisk is on another machine.",
            file=sys.stderr,
        )
        return 1

    report = build_report(
        entries,
        only_context=args.context,
        ivr_contexts=settings["ivr_contexts"],
        include_all=args.raw,
    )
    rendered = json.dumps(report, indent=2)
    print(rendered)

    if args.out:
        Path(args.out).write_text(rendered, encoding="utf-8")
        print(f"[testing] written to {args.out}", file=sys.stderr)

    if not report["ivrs"]:
        print(
            "[testing] no IVR-shaped contexts matched. Run with --raw to see every context, "
            "then set ASTERISK_IVR_CONTEXTS to the ones you want.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
