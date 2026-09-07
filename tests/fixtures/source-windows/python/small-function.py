def format_account(name: str, active: bool) -> str:
    """Format one account label for a search result."""
    status = "active" if active else "disabled"
    return f"{name.strip()} ({status})"
