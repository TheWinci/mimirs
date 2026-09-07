from dataclasses import dataclass, field


@dataclass
class JobQueue:
    """Keep pending jobs in insertion order."""

    jobs: list[str] = field(default_factory=list)

    def enqueue(self, job: str) -> None:
        self.jobs.append(job)

    def peek(self) -> str | None:
        return self.jobs[0] if self.jobs else None

    def drain(self, limit: int | None = None) -> list[str]:
        count = len(self.jobs) if limit is None else limit
        selected = self.jobs[:count]
        self.jobs = self.jobs[count:]
        return selected

    @property
    def size(self) -> int:
        return len(self.jobs)

    @classmethod
    def empty(cls) -> "JobQueue":
        return cls()
