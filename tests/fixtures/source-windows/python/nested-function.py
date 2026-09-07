def build_report(rows: list[dict[str, object]]) -> str:
    """Normalize, filter, and render report rows."""

    def normalize(row: dict[str, object]) -> dict[str, object]:
        title = str(row.get("title", "untitled")).strip()
        return {**row, "title": title}

    normalized = [normalize(row) for row in rows]
    visible = [row for row in normalized if not row.get("archived", False)]

    def render(row: dict[str, object]) -> str:
        owner = str(row.get("owner", "unassigned"))
        return f"{row['title']} — {owner}"

    return "\n".join(render(row) for row in visible)
