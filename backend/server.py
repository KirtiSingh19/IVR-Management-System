"""
The HTTP layer.

Routing, request bodies, status codes and CORS headers — and nothing else. All
SQL is in models.py and all business rules are in validators.py, so this file
stays short enough to read in one go.

    GET    /                       health check
    GET    /api/ivrs               every IVR, each with its menu nested
    POST   /api/ivrs               create an IVR and its menu
    PUT    /api/ivrs/<id>          update an IVR, and replace its menu if one is sent
    DELETE /api/ivrs/<id>          delete an IVR and its menu rows
    GET    /api/audio              the prompt library
    POST   /api/audio              upload a prompt (raw body, name in a header)
    GET    /api/audio/<id>/file    the audio itself, with Range support
    DELETE /api/audio/<id>         delete a prompt and its file
    GET    /api/asterisk/status       is the PBX reachable
    GET    /api/asterisk/extensions   PJSIP extensions Asterisk knows about
    GET    /api/asterisk/dialplan     the running dialplan (?context= to narrow)
    POST   /api/asterisk/ivrs/<id>/sync   write MySQL's IVRs into the dialplan

Run it with:  python server.py
"""

import json
import re
import traceback
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

import mysql.connector

import asterisk_ami
import audio_store
import auth
import models
import recordings
from config import (
    API_HOST,
    API_PORT,
    CORS_ORIGIN,
    ENV_FILE_FOUND,
    MAX_AUDIO_BYTES,
    MYSQL,
    SESSION_COOKIE_SECURE,
)
from database import init_schema
from validators import (
    NotFoundError,
    ValidationError,
    clean_audio_upload,
    clean_create,
    clean_update,
)

class PermissionDenied(Exception):
    """Signed in, but not allowed. Distinct from 401, which means "sign in"."""


# One IVR, addressed by its numeric primary key. Anchored at both ends so
# /api/ivrs/1/extra is a 404 rather than a silent match on "1".
IVR_DETAIL = re.compile(r"^/api/ivrs/(\d+)$")

IVR_SYNC = re.compile(r"^/api/asterisk/ivrs/(\d+)/sync$")

AUDIO_DETAIL = re.compile(r"^/api/audio/(\d+)$")
AUDIO_BYTES = re.compile(r"^/api/audio/(\d+)/file$")

RECORDING_DETAIL = re.compile(r"^/api/recordings/(\d+)$")
RECORDING_BYTES = re.compile(r"^/api/recordings/(\d+)/file$")

# "bytes=0-1023", "bytes=1024-" and "bytes=-512" are the forms a media element
# actually sends while seeking.
RANGE_HEADER = re.compile(r"^bytes=(\d*)-(\d*)$")

# An IVR with a full 12-key menu serialises to a couple of kilobytes, so this is
# orders of magnitude more headroom than any real request needs. The point is the
# ceiling itself: without one, a bogus Content-Length would have the server read
# an arbitrary amount into memory before rejecting it.
MAX_BODY_BYTES = 256 * 1024


class IVRHandler(BaseHTTPRequestHandler):
    # HTTP/1.1 so the browser can keep the connection alive across the several
    # calls a page load makes. Safe because ThreadingHTTPServer handles requests
    # concurrently and every response below sets an accurate Content-Length.
    protocol_version = "HTTP/1.1"

    #: Set by _dispatch once a request is authenticated.
    current_user = None
    server_version = "IVRManager/1.0"

    # ---------------------------------------------------------------- responses

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        # The upload sends the file name and duration as custom headers. Any header
        # outside the CORS-safelist makes the browser send a preflight first and
        # refuse the real request unless it is named here, so leaving these out
        # would block every upload with a CORS error rather than a useful one.
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Audio-Filename, X-Audio-Duration",
        )

    def send_json(self, data, status=200):
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400, field=None):
        """
        The frontend reads `field` to put the message on the input that caused
        it, which is how "extension already in use" lands under the extension
        box instead of in a toast.
        """
        payload = {"error": message}
        if field:
            payload["field"] = field
        self.send_json(payload, status)

    def send_bytes(self, data, content_type, status=200, extra_headers=()):
        """A binary response. Used for serving audio."""
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "bytes")
        for name, value in extra_headers:
            self.send_header(name, value)
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------------ request

    def _content_length(self):
        try:
            return int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValidationError(None, "Content-Length is not a number.")

    def read_binary_body(self, limit):
        """
        Read a raw request body, refusing anything over `limit`.

        The size is checked against the declared Content-Length before reading, so
        an oversized upload is rejected without being pulled into memory first.

        Raw body rather than multipart/form-data on purpose: Python 3.13 removed
        the `cgi` module, so there is no longer a standard-library multipart
        parser, and hand-rolling one to move a single file would be a lot of
        fiddly code for no benefit. The name and duration ride along in headers.
        """
        length = self._content_length()
        if length <= 0:
            raise ValidationError("file", "That upload was empty.")
        if length > limit:
            raise ValidationError(
                "file", f"That file is larger than the {limit // (1024 * 1024)} MB limit."
            )

        # A short read means the client went away mid-upload; storing a truncated
        # audio file would be worse than refusing it.
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValidationError("file", "That upload did not complete.")
        return data

    def read_json_body(self):
        """
        Parse the request body as a JSON object.

        A missing or unparseable body is a client error, not a server error, so
        it comes back as 400 with something the caller can act on.
        """
        length = self._content_length()

        if length <= 0:
            raise ValidationError(None, "Send a JSON body.")
        if length > MAX_BODY_BYTES:
            raise ValidationError(None, "That request body is too large.")

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValidationError(None, "The request body is not valid JSON.") from error

        if not isinstance(payload, dict):
            raise ValidationError(None, "Send a JSON object.")
        return payload

    # ------------------------------------------------------------------ routing

    def do_OPTIONS(self):
        """CORS preflight. Sent by the browser before PUT and DELETE."""
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        self._dispatch(self._route_get)

    def do_POST(self):
        self._dispatch(self._route_post)

    def do_PUT(self):
        self._dispatch(self._route_put)

    def do_DELETE(self):
        self._dispatch(self._route_delete)

    # -------------------------------------------------------------------- auth

    def _session_token(self):
        """The session cookie, or None."""
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except CookieError:
            return None
        morsel = jar.get(auth.COOKIE_NAME)
        return morsel.value if morsel else None

    def _require_admin(self):
        """
        Guard the recordings.

        Enforced here rather than by hiding the nav item: a hidden link is a
        courtesy, not a control, and the URL is guessable. Raises so callers
        cannot forget to check the return value.
        """
        if (self.current_user or {}).get("role") != "admin":
            raise PermissionDenied("Only administrators can access call recordings.")

    def _is_public(self, path):
        """
        The only routes reachable without a session.

        Deliberately a tiny allowlist rather than a denylist: a route added later
        is protected by default, which is the failure mode you want. Everything
        else — including the Asterisk sync, which writes to the PBX — needs a
        session.
        """
        return path == "/" or (self.command == "POST" and path == "/api/auth/login")

    def _dispatch(self, route):
        """
        Run a route and turn whatever it raises into the right status code.

        Every handler funnels through here so the mapping from exception to
        status exists once, and so does the authentication check — a guard that
        each route had to remember to call would eventually be forgotten by one
        of them.

        An unexpected exception is logged in full on the server and reported as a
        flat 500 to the client — a stack trace in an HTTP response tells an
        attacker about your schema.
        """
        try:
            path = self._path()
            if not self._is_public(path):
                self.current_user = auth.session_user(self._session_token())
                if not self.current_user:
                    self.send_error_json("Sign in to continue.", 401)
                    return
            route()
        except PermissionDenied as error:
            self.send_error_json(str(error), 403)
        except ValidationError as error:
            self.send_error_json(error.message, 400, error.field)
        except NotFoundError as error:
            self.send_error_json(str(error) or "Not found.", 404)
        except mysql.connector.Error as error:
            print(f"[server] database error: {error}")
            self.send_error_json("The database rejected that request.", 500)
        except BrokenPipeError:
            # The browser navigated away mid-request. Nothing to report.
            pass
        except Exception:
            traceback.print_exc()
            self.send_error_json("Something went wrong on the server.", 500)

    def send_session_cookie(self, token, max_age):
        """
        Issue or clear the session cookie.

        HttpOnly so no script can read the token — that is the whole reason for
        using a cookie rather than a bearer token in localStorage. SameSite=Lax
        blocks it from riding along on cross-site requests.

        `Secure` is added only when configured, because it would stop the cookie
        working over plain http on 127.0.0.1, which is how this runs today. Turn
        SESSION_COOKIE_SECURE on the moment the app is served over HTTPS.
        """
        parts = [
            f"{auth.COOKIE_NAME}={token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            f"Max-Age={max_age}",
        ]
        if SESSION_COOKIE_SECURE:
            parts.append("Secure")
        self.send_header("Set-Cookie", "; ".join(parts))

    def _route_get(self):
        path = self._path()

        if path == "/":
            self.send_json({"message": "IVR Manager API is running"})
            return

        if path == "/api/auth/me":
            # Reached only with a valid session, so saying who it is costs nothing.
            self.send_json({"authenticated": True, **{k: self.current_user[k] for k in ("username", "role")}})
            return

        if path == "/api/ivrs":
            self.send_json(models.list_ivrs())
            return

        if path == "/api/audio":
            self.send_json(models.list_audio())
            return

        # Asterisk, read-only. These deliberately answer 200 even when the PBX is
        # down: "not connected" is the honest result of asking, not a failure of
        # the request, and the dashboard needs to render that state rather than
        # treat it as an error. Both helpers swallow their own faults, so an
        # unreachable switch can never take the website with it.
        if path == "/api/recordings":
            self._require_admin()
            self.send_json({"recordings": recordings.listing()})
            return

        match = RECORDING_BYTES.match(path)
        if match:
            self._require_admin()
            self._serve_recording(int(match.group(1)))
            return

        if path == "/api/asterisk/status":
            self.send_json(asterisk_ami.status())
            return

        if path == "/api/asterisk/extensions":
            self.send_json(asterisk_ami.extensions())
            return

        if path == "/api/asterisk/dialplan":
            query = parse_qs(self.path.partition("?")[2])
            context = (query.get("context") or [None])[0]
            self.send_json(asterisk_ami.dialplan(context))
            return

        match = AUDIO_BYTES.match(path)
        if match:
            self._serve_audio_bytes(int(match.group(1)))
            return

        self._not_found()

    def _route_post(self):
        path = self._path()

        if path == "/api/ivrs":
            data = clean_create(self.read_json_body())
            self.send_json(models.create_ivr(data), 201)
            return

        if path == "/api/audio":
            self._receive_audio_upload()
            return

        if path == "/api/recordings":
            # Uploading is not admin-only: the phone records for whoever is on the
            # call. Only listening back to other people's calls is restricted.
            self._receive_recording()
            return

        if path == "/api/auth/login":
            payload = self.read_json_body()
            try:
                session = auth.login(payload.get("username"), payload.get("password"))
            except auth.AuthError as error:
                # 401 with one generic message: which half was wrong is not
                # something an attacker should be able to learn from the response.
                self.send_error_json(str(error), 401)
                return

            body = json.dumps({"authenticated": True, "username": session["username"], "role": session["role"]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_session_cookie(session["token"], auth.SESSION_HOURS * 3600)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/auth/logout":
            # The server forgets the session; the empty cookie makes the browser
            # forget it too, so a stale value cannot be replayed.
            auth.logout(self._session_token())
            body = json.dumps({"authenticated": False}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_session_cookie("", 0)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(body)
            return

        match = IVR_SYNC.match(path)
        if match:
            self._sync_ivr(int(match.group(1)))
            return

        self._not_found()

    def _sync_ivr(self, ivr_id):
        """
        POST /api/asterisk/ivrs/<id>/sync — push MySQL's IVRs into the dialplan.

        The target is fetched first so an unknown id is a 404 before Asterisk is
        contacted at all. Every other IVR comes along because the managed file is
        rewritten whole; syncing only the target would silently delete the rest
        from the dialplan.

        Answers 200 with success:false for anything Asterisk-side — an unreachable
        PBX or a menu pointing at a missing extension is a result to show the user,
        not a broken request.
        """
        target = models.get_ivr(ivr_id)  # NotFoundError -> 404, before any AMI work

        # Only Active IVRs belong in a live dialplan; validate() refuses the rest,
        # so filtering here keeps one inactive record from blocking every sync.
        everything = [
            ivr
            for ivr in models.list_ivrs()
            if str(ivr.get("status", "")).lower() == "active" or ivr["id"] == ivr_id
        ]
        self.send_json(asterisk_ami.sync_ivrs(everything, target))

    def _route_put(self):
        match = IVR_DETAIL.match(self._path())
        if match:
            fields, menu = clean_update(self.read_json_body())
            self.send_json(models.update_ivr(int(match.group(1)), fields, menu))
            return

        self._not_found()

    def _route_delete(self):
        path = self._path()

        match = IVR_DETAIL.match(path)
        if match:
            self.send_json(models.delete_ivr(int(match.group(1))))
            return

        match = AUDIO_DETAIL.match(path)
        if match:
            self.send_json(models.delete_audio(int(match.group(1))))
            return

        match = RECORDING_DETAIL.match(path)
        if match:
            self._require_admin()
            self.send_json(recordings.remove(int(match.group(1))))
            return

        self._not_found()

    # -------------------------------------------------------------------- audio

    def _receive_audio_upload(self):
        """
        POST /api/audio — the file's bytes as the body, its name in a header.

        The name is percent-encoded by the client so that a prompt called
        "grüße.wav" survives the trip: HTTP headers are latin-1 by definition and
        a raw UTF-8 name would arrive mangled.
        """
        raw_name = unquote(self.headers.get("X-Audio-Filename") or "")
        raw_duration = self.headers.get("X-Audio-Duration") or "0"

        # Validate the metadata before reading the body, so a rejected upload does
        # not have to be transferred in full first.
        meta = clean_audio_upload(raw_name, self._content_length(), raw_duration)

        data = self.read_binary_body(MAX_AUDIO_BYTES)
        meta["size_bytes"] = len(data)

        self.send_json(models.create_audio(meta, data), 201)

    def _receive_recording(self):
        """
        POST /api/recordings — the recording's bytes as the body, metadata in
        headers, matching how audio prompts are uploaded.
        """
        meta = recordings.clean_upload(
            {
                "mime_type": self.headers.get("X-Recording-Mime") or "",
                "from_extension": unquote(self.headers.get("X-Recording-From") or ""),
                "to_extension": unquote(self.headers.get("X-Recording-To") or ""),
                "direction": self.headers.get("X-Recording-Direction") or "outbound",
                "duration_seconds": self.headers.get("X-Recording-Duration") or 0,
                "started_at": self.headers.get("X-Recording-Started") or "",
            }
        )
        data = self.read_binary_body(recordings.MAX_RECORDING_BYTES)
        self.send_json(recordings.create(meta, data, (self.current_user or {}).get("id")), 201)

    def _serve_recording(self, recording_id):
        """Stream a recording, with Range support so the player can seek."""
        row = recordings.raw(recording_id)
        try:
            path = recordings.path_for(row["stored_name"])
        except ValueError:
            raise NotFoundError("That recording is not available.")
        if not path.is_file():
            raise NotFoundError("That recording is missing from the server.")
        self._serve_file(path, row["mime_type"])

    def _serve_audio_bytes(self, audio_id):
        """
        GET /api/audio/<id>/file — the audio itself.

        Range requests are honoured because an <audio> element uses them to seek:
        without a 206 the browser has to download the whole prompt before it can
        jump, and the seek bar on a long file feels broken.
        """
        row = models.get_audio_row(audio_id)
        try:
            path = audio_store.path_for(row["stored_name"])
        except ValueError:
            raise NotFoundError("That audio file is not available.")

        if not path.is_file():
            # The row survived but the file did not. A 404 is honest; handing back
            # zero bytes would look like a corrupt file instead of a missing one.
            raise NotFoundError("That audio file is missing from the server.")

        self._serve_file(path, audio_store.content_type_for(row["format"]))

    def _serve_file(self, path, content_type):
        """
        Send a file, honouring Range.

        Shared by audio prompts and call recordings because both are played by an
        <audio> element, and both need 206 responses for the seek bar to work —
        without them the browser must download the whole file before it can jump,
        which on a long recording feels broken.
        """
        total = path.stat().st_size
        requested = self.headers.get("Range")

        if not requested:
            self.send_bytes(path.read_bytes(), content_type)
            return

        match = RANGE_HEADER.match(requested.strip())
        if not match:
            # An unparseable Range is better answered with the whole file than with
            # an error the media element cannot recover from.
            self.send_bytes(path.read_bytes(), content_type)
            return

        start_text, end_text = match.groups()
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else total - 1
        elif end_text:
            # "bytes=-500" means the last 500 bytes, not "up to byte 500".
            start = max(0, total - int(end_text))
            end = total - 1
        else:
            self.send_bytes(path.read_bytes(), content_type)
            return

        end = min(end, total - 1)
        if start > end or start >= total:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{total}")
            self.send_header("Content-Length", "0")
            self._cors_headers()
            self.end_headers()
            return

        with path.open("rb") as handle:
            handle.seek(start)
            chunk = handle.read(end - start + 1)

        self.send_bytes(
            chunk,
            content_type,
            status=206,
            extra_headers=(("Content-Range", f"bytes {start}-{end}/{total}"),),
        )

    # ------------------------------------------------------------------ helpers

    def _path(self):
        """
        The path without any query string, and without a meaningless trailing
        slash, so /api/ivrs/ and /api/ivrs are the same endpoint.
        """
        path = self.path.split("?", 1)[0]
        return path.rstrip("/") or "/"

    def _not_found(self):
        self.send_error_json(f"No endpoint for {self.command} {self._path()}", 404)

    def handle_one_request(self):
        """
        A client dropping an idle keep-alive connection is normal, not an error.

        HTTP/1.1 holds the socket open between requests and browsers close those
        sockets whenever they like. The base class lets the resulting reset
        escape, which prints a full traceback every time a tab goes away and
        buries the failures that actually matter.
        """
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    def log_message(self, fmt, *args):
        """Quieter than the default, which prints the client address every line."""
        print(f"[server] {fmt % args}")


def main():
    if not ENV_FILE_FOUND:
        print("[server] no backend/.env found; falling back to environment defaults")

    print(f"[server] connecting to mysql://{MYSQL['user']}@{MYSQL['host']}:{MYSQL['port']}"
          f"/{MYSQL['database']}")
    try:
        changes = init_schema()
    except mysql.connector.Error as error:
        # Failing here rather than on the first request means a bad password or a
        # stopped MySQL service is obvious at start-up instead of surfacing as a
        # broken page later.
        print(f"[server] could not prepare the database: {error}")
        raise SystemExit(1)

    print(f"[server] schema ready{': ' + ', '.join(changes) if changes else ' (no changes)'}")
    print(f"[server] audio stored in {audio_store.ensure_dir()}")

    httpd = ThreadingHTTPServer((API_HOST, API_PORT), IVRHandler)
    print(f"[server] IVR API running on http://{API_HOST}:{API_PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] stopping")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
