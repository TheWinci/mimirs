def sanitize_label(label):
    """Remove control characters before writing terminal progress messages."""
    return "".join(character if character.isprintable() else "?"
                   for character in label)


def percentage(completed, total):
    return 100 if total == 0 else round(100 * completed / total)


def render_bar(completed, total, width=20):
    count = width if total == 0 else width * completed // total
    return "#" * count + "." * (width - count)


def elapsed_label(seconds):
    minutes, seconds = divmod(int(seconds), 60)
    return f"{minutes:02}:{seconds:02}"
