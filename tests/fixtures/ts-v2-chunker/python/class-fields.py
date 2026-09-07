class Settings:
    """Runtime settings."""

    mode = "safe"
    retries: int = 3
    cache = build_cache()
