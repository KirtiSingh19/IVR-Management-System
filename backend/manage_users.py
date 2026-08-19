"""
Account management from the command line.

    python manage_users.py add <username> [--admin]
    python manage_users.py list
    python manage_users.py delete <username>
    python manage_users.py passwd <username>
    python manage_users.py role <username> admin|user

Only admins can reach Call History and the recordings behind it. New accounts are
ordinary users unless --admin is given.

There is deliberately no default account and no way to seed one. An application
that ships with known credentials is only as secure as everybody's diligence in
changing them, and the first person to skip that leaves a door open. So the first
account is created here, by hand, with a password nobody else has seen.

The password is read with getpass, so it is never echoed to the terminal and
never lands in shell history — which is also why it cannot be passed as an
argument.
"""

import getpass
import sys

import auth
from database import init_schema


def _read_new_password():
    password = getpass.getpass("Password: ")
    if len(password) < 8:
        raise SystemExit("Passwords need at least 8 characters.")
    if password != getpass.getpass("Repeat password: "):
        raise SystemExit("Those passwords do not match.")
    return password


def add(username, role="user"):
    try:
        auth.create_user(username, _read_new_password(), role)
    except ValueError as error:
        raise SystemExit(str(error))
    print(f"Created {username} as {role}.")


def passwd(username):
    """Change a password by replacing the account's digest."""
    from database import get_connection

    password = _read_new_password()
    connection = get_connection()
    try:
        cursor = connection.cursor()
        cursor.execute(
            "UPDATE users SET password_hash = %s WHERE username = %s",
            (auth.hash_password(password), username),
        )
        if cursor.rowcount == 0:
            raise SystemExit(f"There is no user called {username}.")

        # Sign the account out everywhere. A password change that leaves old
        # sessions working does not actually lock anybody out.
        cursor.execute(
            "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = %s)",
            (username,),
        )
        connection.commit()
        cursor.close()
    finally:
        connection.close()
    print(f"Password changed for {username}. Existing sessions were signed out.")


def main(argv):
    if not argv:
        print(__doc__.strip())
        return 1

    # The tables may not exist yet on a first run, and asking someone to start
    # the server before they can create the account to log into it is a silly
    # order of operations.
    init_schema()

    command, *rest = argv

    if command == "add" and rest:
        add(rest[0], "admin" if "--admin" in rest else "user")
    elif command == "role" and len(rest) == 2:
        try:
            ok = auth.set_role(rest[0], rest[1])
        except ValueError as error:
            raise SystemExit(str(error))
        print(f"{rest[0]} is now {rest[1]}." if ok else f"There is no user called {rest[0]}.")
    elif command == "passwd" and rest:
        passwd(rest[0])
    elif command == "delete" and rest:
        removed = auth.delete_user(rest[0])
        print(f"Deleted {rest[0]}." if removed else f"There is no user called {rest[0]}.")
    elif command == "list":
        users = auth.list_users()
        if not users:
            print("No users yet. Create one with: python manage_users.py add <username>")
        for username, role, created in users:
            print(f"  {username:<16}{role:<8}{created}")
    else:
        print(__doc__.strip())
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))