from .scheduler import schedule

RETRY_DELAY = 250


def initialize(task: dict[str, str]) -> object:
    """Schedule the initial task."""
    return schedule(task, RETRY_DELAY)


# This comment explains the eager module-level call.
initialize({"kind": "refresh"})
