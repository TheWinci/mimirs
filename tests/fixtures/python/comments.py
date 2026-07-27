"""Utilities used by the application."""

# Configuration consumed by helpers.
DEFAULT_NAME = "world"


def documented(name=DEFAULT_NAME):
    """Build a friendly greeting."""
    # Keep formatting in one place.
    return format_name(name)


# This note intentionally remains standalone.
