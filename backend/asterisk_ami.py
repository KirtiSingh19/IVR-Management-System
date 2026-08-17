"""
Read-only access to Asterisk, over the Manager Interface.

    browser  ->  this API  ->  AMI  ->  Asterisk

The browser never speaks to AMI. It cannot: the credentials live in .env, which
is git-ignored and only ever read by this process. Everything below is a read —
nothing here writes to the dialplan, to pjsip.conf, or to the switch.

server.py sees only the three functions at the bottom — status(), extensions()
and dialplan(). The socket work above them is private, so replacing this
transport with a library later is a change to this file alone.

WHAT THE AMI ACCOUNT CAN ACTUALLY DO

With `read = config` / `write = config`, Asterisk permits ShowDialPlan, GetConfig
and Ping, and refuses PJSIPShowEndpoints, DeviceStateList and CoreStatus. So the
live registration state of a phone is not readable at this permission level.
extensions() tries for it anyway and falls back to the configured endpoints in
pjsip.conf, reporting which source it used rather than presenting one as the
other. Grant `system` to the AMI user and the live path starts working with no
change here.
"""

import socket

import dialplan as dialplan_builder
from config import ASTERISK, ASTERISK_MANAGED_FILE, ASTERISK_PARENT_CONTEXT

# Only these keys from a pjsip.conf endpoint section are ever returned.
#
# A whitelist, not a blacklist, because GetConfig hands back the file verbatim —
# including the [xxxx-auth] sections and their cleartext `password=` lines. A
# blacklist would leak the moment somebody added a new secret-bearing field.
ENDPOINT_SAFE_KEYS = ("context", "transport", "allow", "disallow", "aors")


class AsteriskError(Exception):
    """Base for anything that stops a read from completing."""

    #: What the API reports. Never contains a credential.
    message = "Asterisk could not be reached."

    def __init__(self, message=None):
        super().__init__(message or self.message)
        self.message = message or self.message


class AsteriskUnavailable(AsteriskError):
    """The host refused the connection, timed out, or vanished mid-conversation."""


class AsteriskAuthError(AsteriskError):
    """The manager account was rejected."""


class AsteriskPermissionError(AsteriskError):
    """Connected and authenticated, but this account may not run that action."""


class AsteriskNotConfigured(AsteriskError):
    """No AMI settings in the environment at all."""


# ---------------------------------------------------------------------------
# The wire protocol
# ---------------------------------------------------------------------------


class _Connection:
    """
    One AMI conversation, opened and closed per request.

    No pooling and no long-lived session. The server is threaded, so a shared
    connection would need locking around a protocol that interleaves responses
    with unsolicited events — a lot of machinery to save a few milliseconds on a
    LAN. Login, ask, log off.

    AMI is a line protocol: "Key: Value" lines, a blank line ending each packet.
    Values may contain colons, so lines split on the first one only, and packets
    are reassembled from a buffer because one recv() can straddle any number.
    """

    def __init__(self, settings):
        self.settings = settings
        self.sock = None
        self.buffer = b""
        self.greeting = ""

    def __enter__(self):
        host, port = self.settings["host"], self.settings["port"]
        try:
            self.sock = socket.create_connection((host, port), self.settings["timeout"])
            self.sock.settimeout(self.settings["timeout"])
        except socket.timeout as error:
            raise AsteriskUnavailable(
                f"No response from {host}:{port} within {self.settings['timeout']:g}s."
            ) from error
        except OSError as error:
            raise AsteriskUnavailable(f"Could not reach {host}:{port} — {error.strerror or error}.") from error

        self.greeting = self._read_line().strip()
        if "asterisk" not in self.greeting.lower():
            raise AsteriskUnavailable(
                f"{host}:{port} answered, but not as Asterisk. Is something else on that port?"
            )
        self._login()
        return self

    def __exit__(self, *_exc):
        try:
            if self.sock:
                self._send({"Action": "Logoff"})
        except OSError:
            pass  # Already gone; nothing useful to say.
        finally:
            if self.sock:
                self.sock.close()
                self.sock = None

    # -- io -----------------------------------------------------------------

    def _fill(self):
        try:
            chunk = self.sock.recv(8192)
        except socket.timeout as error:
            raise AsteriskUnavailable(
                f"Asterisk stopped responding after {self.settings['timeout']:g}s."
            ) from error
        except OSError as error:
            raise AsteriskUnavailable(f"Connection to Asterisk failed — {error}.") from error
        if not chunk:
            raise AsteriskUnavailable("Asterisk closed the connection.")
        self.buffer += chunk

    def _read_line(self):
        while b"\r\n" not in self.buffer:
            self._fill()
        line, _, self.buffer = self.buffer.partition(b"\r\n")
        return line.decode("utf-8", errors="replace")

    def _read_packet(self):
        while b"\r\n\r\n" not in self.buffer:
            self._fill()
        raw, _, self.buffer = self.buffer.partition(b"\r\n\r\n")

        packet = {}
        for line in raw.decode("utf-8", errors="replace").splitlines():
            key, separator, value = line.partition(":")
            if separator:
                packet[key.strip()] = value.strip()
        return packet

    def _send(self, fields):
        payload = "".join(f"{key}: {value}\r\n" for key, value in fields.items()) + "\r\n"
        try:
            self.sock.sendall(payload.encode("utf-8"))
        except OSError as error:
            raise AsteriskUnavailable(f"Could not send to Asterisk — {error}.") from error

    # -- conversation -------------------------------------------------------

    def _login(self):
        # `Events: off` stops Asterisk pushing live call traffic down this socket.
        # Without it a busy PBX interleaves channel events with our replies, which
        # every read below would then have to filter out.
        self._send(
            {
                "Action": "Login",
                "Username": self.settings["username"],
                "Secret": self.settings["secret"],
                "Events": "off",
            }
        )
        response = self._read_packet()
        if response.get("Response", "").lower() != "success":
            # The server's message is safe to relay; it never echoes the secret.
            raise AsteriskAuthError(
                "Asterisk rejected the manager login: "
                + (response.get("Message") or "no reason given")
            )

    def action(self, name, action_id=None, **fields):
        """Send one action and return its first response packet."""
        action_id = action_id or name
        self._send({"Action": name, "ActionID": action_id, **fields})
        response = self._read_packet()

        if response.get("Response", "").lower() == "error":
            message = response.get("Message") or "no reason given"
            if "permission" in message.lower():
                raise AsteriskPermissionError(
                    f"The AMI account may not run {name} ({message})."
                )
            raise AsteriskError(f"{name} failed: {message}")
        return response, action_id

    def collect_list(self, name, complete_event, **fields):
        """
        Run a list-style action and gather its events.

        Events are matched on ActionID: even with `Events: off`, picking up a
        packet belonging to something else would silently corrupt the result.
        """
        _response, action_id = self.action(name, **fields)

        items = []
        while True:
            packet = self._read_packet()
            if packet.get("ActionID") not in (action_id, None):
                continue
            event = packet.get("Event", "")
            if event == complete_event or packet.get("EventList", "").lower() == "complete":
                return items
            if event:
                items.append(packet)


def _settings():
    settings = ASTERISK
    missing = [
        name
        for name, key in (
            ("ASTERISK_HOST", "host"),
            ("ASTERISK_AMI_USERNAME", "username"),
            ("ASTERISK_AMI_SECRET", "secret"),
        )
        if not settings.get(key)
    ]
    if missing:
        raise AsteriskNotConfigured(
            "Asterisk is not configured. Add " + ", ".join(missing) + " to backend/.env."
        )
    return settings


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_getconfig(response):
    """
    Turn a GetConfig reply into [(section, [(key, value), ...]), ...], in file order.

    Pairs all the way down, never dicts. Config files repeat things at both
    levels, and a dict silently keeps only the last of each:

      * section names — pjsip.conf writes [1001] twice, once as the endpoint and
        once as the AOR. This is why GetConfigJSON is unusable here: its JSON
        object collapses the pair and loses every `type=endpoint` in the file.
      * keys within a section — a dialplan context is a run of `exten` lines, so
        a dict of one section reduces a whole menu to its final line.

    The second of those was a real bug: reading the managed file back showed one
    `exten` per context and made a correct write look like a broken one.
    """
    sections = {}
    for key, value in response.items():
        if key.startswith("Category-"):
            index = key.split("-", 1)[1]
            sections.setdefault(index, {"name": "", "lines": []})["name"] = value
        elif key.startswith("Line-"):
            parts = key.split("-")
            if len(parts) < 3:
                continue
            entry = sections.setdefault(parts[1], {"name": "", "lines": []})
            field, separator, field_value = value.partition("=")
            if separator:
                entry["lines"].append((field.strip(), field_value.strip()))

    return [
        (entry["name"], entry["lines"])
        for _index, entry in sorted(sections.items(), key=lambda item: item[0])
        if entry["name"]
    ]


def _endpoints_from_config(connection):
    """Configured PJSIP endpoints, read from pjsip.conf."""
    response, _ = connection.action("GetConfig", Filename="pjsip.conf")

    endpoints = []
    for name, lines in _parse_getconfig(response):
        # An endpoint section has one of each key, so a dict is safe *here* —
        # unlike a dialplan context, which is nothing but repeated `exten` lines.
        values = dict(lines)
        if values.get("type", "").lower() != "endpoint":
            continue
        safe = {key: values[key] for key in ENDPOINT_SAFE_KEYS if key in values}
        endpoints.append(
            {
                "extension": name,
                # Not "Available": nothing here says whether a phone is registered.
                # Saying so would be inventing the one fact this cannot know.
                "status": "configured",
                "context": safe.get("context", ""),
                "transport": safe.get("transport", ""),
                "codecs": safe.get("allow", ""),
            }
        )
    return endpoints


def _endpoints_live(connection):
    """Endpoints with their real device state. Needs the `system` class."""
    events = connection.collect_list(
        "PJSIPShowEndpoints", complete_event="EndpointListComplete"
    )
    endpoints = []
    for event in events:
        if event.get("Event") != "EndpointList":
            continue
        endpoints.append(
            {
                "extension": event.get("ObjectName", ""),
                "status": event.get("DeviceState", "Unknown"),
                "context": "",
                "transport": event.get("Transport", ""),
                "codecs": "",
                "active_channels": event.get("ActiveChannels", ""),
            }
        )
    return endpoints


# ---------------------------------------------------------------------------
# What server.py calls
# ---------------------------------------------------------------------------


def status():
    """
    Is Asterisk reachable and are the credentials good?

    Always returns a dict — a PBX being down is a normal condition for this
    endpoint to report, not an exception for the caller to handle. Ping is used
    because it needs no privilege at all, so a permission problem elsewhere cannot
    make a healthy connection look broken.
    """
    settings = ASTERISK
    report = {
        "success": False,
        "connected": False,
        "host": settings.get("host", ""),
        "port": settings.get("port", 0),
        "message": "",
        "ami_version": "",
    }

    try:
        settings = _settings()
        with _Connection(settings) as connection:
            connection.action("Ping")
            report.update(
                success=True,
                connected=True,
                message="Asterisk AMI connected",
                ami_version=connection.greeting,
            )
    except AsteriskError as error:
        report["message"] = error.message
    return report


def extensions():
    """
    The PJSIP extensions Asterisk knows about.

    Tries for live device state first and falls back to what is configured in
    pjsip.conf. `status_source` says which happened, so "configured" is never
    mistaken for "registered and ready".
    """
    result = {"success": False, "status_source": "", "message": "", "extensions": []}

    try:
        settings = _settings()
        with _Connection(settings) as connection:
            try:
                found = _endpoints_live(connection)
                source = "PJSIPShowEndpoints (live device state)"
            except (AsteriskPermissionError, AsteriskError):
                # Denied, or the action is unavailable on this build. The configured
                # endpoints are still real data and still useful.
                found = _endpoints_from_config(connection)
                source = "pjsip.conf (configured, not live)"

            found.sort(key=lambda item: item["extension"])
            result.update(success=True, status_source=source, extensions=found)
    except AsteriskError as error:
        result["message"] = error.message
    return result


def write_managed_file(connection, filename, contexts):
    """
    Replace the managed dialplan file with `contexts`, in one UpdateConfig.

    Every existing category is deleted and the new ones appended in the same
    request, so the file is never briefly empty and a failure leaves the previous
    dialplan exactly as it was. Partial writes are the thing to avoid here: half a
    menu is worse than none.

    Only this file is touched. extensions.conf, pjsip.conf and every context the
    website does not own are never named in these actions.
    """
    # What is in there now. A file that does not exist yet is not an error — it is
    # simply the first sync.
    existing = []
    try:
        response, _ = connection.action("GetConfig", Filename=filename, action_id="read-managed")
        existing = [name for name, _lines in _parse_getconfig(response)]
    except AsteriskError:
        connection.action("CreateConfig", Filename=filename, action_id="create-managed")

    fields = {"Reload": "no"}  # Reloaded explicitly afterwards, so failures are separable.
    index = 0

    def add(**pairs):
        nonlocal index
        suffix = f"{index:06d}"
        for key, value in pairs.items():
            fields[f"{key}-{suffix}"] = value
        index += 1

    for name in dict.fromkeys(existing):
        add(Action="delcat", Cat=name)

    for name, lines in contexts.items():
        add(Action="newcat", Cat=name)
        for key, value in lines:
            add(Action="append", Cat=name, Var=key, Value=value)

    connection.action("UpdateConfig", action_id="write-managed", SrcFilename=filename,
                      DstFilename=filename, **fields)
    return index


def reload_dialplan(connection):
    """Ask Asterisk to re-read the dialplan. Nothing else is reloaded."""
    connection.action("Reload", action_id="reload-dialplan", Module="pbx_config")


def _registered_extensions(connection, context):
    """
    Extensions defined *directly* in a context, ignoring what it includes.

    That distinction is the whole point: once [internal] includes the managed
    context, a synced 5000 shows up under the managed context. A 5000 still
    appearing directly in [internal] is therefore a hand-written one, and it would
    win — explicitly defined extensions beat included ones — leaving the synced
    IVR as dead code that never answers a call.
    """
    try:
        events = connection.collect_list(
            "ShowDialPlan", complete_event="ShowDialPlanComplete", Context=context
        )
    except AsteriskError as error:
        # Asterisk answers "Did not find context X" for a context that is not
        # loaded. For the managed context that is the normal state before
        # extensions.conf includes the file, and for the parent context it means
        # there is nothing to shadow us — neither is a failure, both are "empty".
        if "did not find context" in str(error).lower():
            return set()
        raise

    return {
        event["Extension"]
        for event in events
        if event.get("Context") == context and event.get("Extension")
    }


def sync_ivrs(ivrs, target):
    """
    Write the website's IVRs into Asterisk and reload.

    `ivrs` is every IVR that should exist in the managed file; `target` is the one
    the user asked to sync, and the one reported on. The whole set is written each
    time because the managed file is generated wholesale — writing only the target
    would drop every other IVR from the dialplan.

    The order matters. Validate before touching anything, so a bad record is
    refused without a write. Check for a shadowing hand-written extension before
    writing, so we never report success for a dialplan that will not answer.
    Reload separately from the write, so "saved but not reloaded" is a distinct,
    reportable outcome rather than a mystery.
    """
    result = {
        "success": False,
        "message": "",
        "extension": str(target.get("extension", "")),
        "warnings": [],
        "unverified_sounds": [],
        "dialplan": "",
    }

    try:
        settings = _settings()

        with _Connection(settings) as connection:
            # What Asterisk really has, read fresh — not what MySQL believes.
            configured = {row["extension"] for row in _endpoints_from_config(connection)}
            if not configured:
                raise AsteriskError(
                    "Asterisk reports no configured PJSIP extensions, so no destination "
                    "could be verified. Check pjsip.conf."
                )

            # The IVR the user asked for must be sound, or there is nothing to
            # report success about — its failure is the answer.
            warnings = list(dialplan_builder.validate(target, configured))

            # Every other IVR is rebuilt into the same file, so each is checked
            # too. A broken one is left out with a warning rather than raised:
            # blocking the sync of a perfectly good IVR because an unrelated
            # record has a bad destination is not a useful failure. Leaving it out
            # is also correct on its own terms — an IVR that cannot be expressed
            # should not be in the dialplan.
            writable = [target]
            for ivr in ivrs:
                if ivr["id"] == target["id"]:
                    continue
                try:
                    warnings.extend(dialplan_builder.validate(ivr, configured))
                    writable.append(ivr)
                except dialplan_builder.DialplanError as error:
                    warnings.append(
                        f"{ivr.get('name')} (extension {ivr.get('extension')}) was left out "
                        f"of the dialplan: {error.message}"
                    )

            # A hand-written copy of this extension in the parent context would
            # take priority over anything included from the managed file.
            shadowing = _registered_extensions(connection, ASTERISK_PARENT_CONTEXT)
            if result["extension"] in shadowing:
                raise AsteriskError(
                    f"Extension {result['extension']} is already defined directly in "
                    f"[{ASTERISK_PARENT_CONTEXT}] on Asterisk. That hand-written entry takes "
                    "priority over anything synced, so the IVR would not answer. Comment it "
                    "out of extensions.conf and reload, then sync again."
                )

            contexts = dialplan_builder.build(writable)
            write_managed_file(connection, ASTERISK_MANAGED_FILE, contexts)
            reload_dialplan(connection)

            # Prove it landed rather than assuming the reload worked.
            live = _registered_extensions(connection, dialplan_builder.ENTRY_CONTEXT)
            if result["extension"] not in live:
                raise AsteriskError(
                    f"The dialplan was written and reloaded, but extension {result['extension']} "
                    f"is not registered in [{dialplan_builder.ENTRY_CONTEXT}]. Check that "
                    f"extensions.conf contains: #include \"{ASTERISK_MANAGED_FILE}\""
                )

            result.update(
                success=True,
                message=f"IVR {result['extension']} synced successfully",
                warnings=warnings,
                unverified_sounds=dialplan_builder.unverified_sounds(target),
                dialplan=dialplan_builder.render(contexts),
            )

    except dialplan_builder.DialplanError as error:
        result["message"] = error.message
    except AsteriskError as error:
        result["message"] = error.message
    return result


def dialplan(context=None):
    """
    The running dialplan, grouped by context.

    Raw entries rather than an interpretation of them: this stage is read-only and
    nothing consumes it yet. Turning contexts into IVR records is the next stage's
    job, and doing it here would bake in an interpretation before it is needed.
    """
    result = {"success": False, "message": "", "contexts": {}}

    try:
        settings = _settings()
        with _Connection(settings) as connection:
            fields = {"Context": context} if context else {}
            events = connection.collect_list(
                "ShowDialPlan", complete_event="ShowDialPlanComplete", **fields
            )

            contexts = {}
            for event in events:
                name = event.get("Context")
                if not name:
                    continue
                bucket = contexts.setdefault(name, [])
                if event.get("IncludeContext"):
                    bucket.append({"include": event["IncludeContext"]})
                    continue
                bucket.append(
                    {
                        "extension": event.get("Extension", ""),
                        "priority": event.get("Priority", ""),
                        "application": event.get("Application", ""),
                        "app_data": event.get("AppData", ""),
                    }
                )
            result.update(success=True, contexts=contexts)
    except AsteriskError as error:
        result["message"] = error.message
    return result
