def traced(callable):
    def wrapper(*args, **kwargs):
        return callable(*args, **kwargs)

    return wrapper


@traced
class Repository:
    """Stores items in memory."""

    def __init__(self, items=()):
        self.items = list(items)

    @property
    def size(self):
        return len(self.items)

    @classmethod
    async def create(cls, loader):
        items = await loader()
        return cls(items)
