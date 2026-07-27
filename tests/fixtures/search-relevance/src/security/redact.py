import re


def record_audit_event(event: str, subject_id: str) -> None:
    print("audit", event, subject_id)


def redact_authorization_header(headers: dict[str, str]) -> dict[str, str]:
    """Replace bearer credentials before request headers enter diagnostic logs."""
    sanitized = headers.copy()
    authorization = sanitized.get("Authorization")
    if authorization:
        sanitized["Authorization"] = re.sub(
            r"^Bearer\s+.+$", "Bearer [REDACTED]", authorization
        )
        record_audit_event("authorization-redacted", "request")
    return sanitized
