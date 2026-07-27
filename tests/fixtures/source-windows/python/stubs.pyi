from collections.abc import Iterable
from typing import overload

class Report:
    id: str
    title: str
    archived: bool

class ReportStore:
    def __init__(self, reports: Iterable[Report] = ...) -> None: ...
    def get(self, report_id: str) -> Report | None: ...
    def list(self, *, archived: bool | None = ...) -> list[Report]: ...

@overload
def format_report(report: Report) -> str: ...
@overload
def format_report(report: None) -> None: ...
