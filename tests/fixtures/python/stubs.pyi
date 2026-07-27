from collections.abc import Callable, Iterator
from typing import Protocol, TypeAlias, TypeVar, overload

T = TypeVar("T")
PathLike: TypeAlias = str | bytes
Callback: TypeAlias = Callable[[T], T]

class Reader(Protocol[T]):
    name: str

    @overload
    def read(self, source: str) -> str: ...

    @overload
    def read(self, source: bytes) -> bytes: ...

    @property
    def closed(self) -> bool: ...

def iter_readers(paths: list[PathLike]) -> Iterator[Reader[str]]: ...
