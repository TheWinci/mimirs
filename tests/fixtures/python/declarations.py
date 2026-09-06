"""Module documentation for the café service."""
from contextlib import contextmanager

LIMIT = 10

@registered(
    name="café",
)
class Service[T](Base[T]):
    """Keep service state and expose operations."""
    label: str = "café"

    @classmethod
    async def create(
        cls,
        source: str,
        *,
        transform=lambda value: value,
    ) -> "Service[T]":
        """Create a service from a named source."""
        async def nested(value):
            return await fetch(value)
        return cls(transform(await nested(source)))

    @property
    def name(self) -> str:
        return self.label

    class Options:
        """Options belong to this nested class."""
        enabled = True

        def reset(self):
            self.enabled = False

    if ENABLED:
        def optional(self):
            return self.label

@contextmanager
def session(value: str):
    """Yield a temporary session."""
    class Local:
        def local_method(self):
            return value
    yield Local()

if ENABLED:
    def conditional():
        return LIMIT

# This trailing comment has no declaration owner.
print(LIMIT)
