"""Manage session records and persist them between restarts."""
import json


class SessionStore:
    """A mapping from session identifiers to their expiration timestamps."""

    def __init__(self):
        self.sessions = {}

    def expire(self, now):
        expired = [key for key, record in self.sessions.items()
                   if record["expires_at"] <= now]
        for key in expired:
            del self.sessions[key]
        return len(expired)

    def restore(self, path):
        """Restore session state from a JSON snapshot saved on disk."""
        with open(path, encoding="utf-8") as stream:
            self.sessions = json.load(stream)

    def save(self, path):
        """Write the current session mapping to a JSON snapshot."""
        with open(path, "w", encoding="utf-8") as stream:
            json.dump(self.sessions, stream)

    def contains(self, session_id):
        return session_id in self.sessions
