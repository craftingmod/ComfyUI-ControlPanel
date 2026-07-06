from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .manager_process import ManagerApiError


LOGGER = logging.getLogger("backend.manager_api")
JOB_LOCK = asyncio.Lock()
JOBS: dict[str, "ManagerJob"] = {}
LATEST_JOB_ID: str | None = None
JOB_LIMIT = 10


@dataclass
class ManagerJob:
    id: str
    kind: str
    label: str
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    logs: list[str] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    restart_required: bool = False

    def append_log(self, message: str) -> None:
        line = message.rstrip()
        self.logs.append(line)
        if line:
            LOGGER.info("[ControlPanel] %s", line)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "logs": self.logs,
            "result": self.result,
            "error": self.error,
            "restart_required": self.restart_required,
        }


def prune_jobs() -> None:
    if len(JOBS) <= JOB_LIMIT:
        return
    for job_id in sorted(JOBS, key=lambda key: JOBS[key].created_at)[: len(JOBS) - JOB_LIMIT]:
        del JOBS[job_id]


async def start_job(kind: str, label: str, operation: Callable[[ManagerJob], Awaitable[dict[str, Any]]]) -> ManagerJob:
    global LATEST_JOB_ID
    async with JOB_LOCK:
        if any(job.status in {"queued", "running"} for job in JOBS.values()):
            raise ManagerApiError("Another manager update job is already running.")
        job = ManagerJob(id=uuid.uuid4().hex, kind=kind, label=label)
        JOBS[job.id] = job
        LATEST_JOB_ID = job.id
        prune_jobs()
        asyncio.create_task(run_job(job, operation))
        return job


async def run_job(job: ManagerJob, operation: Callable[[ManagerJob], Awaitable[dict[str, Any]]]) -> None:
    job.status = "running"
    job.started_at = time.time()
    job.append_log(f"{job.label} started.")
    try:
        result = await operation(job)
        job.result = result
        job.restart_required = bool(result.get("restart_required"))
        job.status = "succeeded"
        job.append_log(f"{job.label} completed.")
    except Exception as error:  # noqa: BLE001 - persist job failures for the UI.
        job.error = str(error)
        job.status = "failed"
        job.append_log(f"{job.label} failed: {error}")
    finally:
        job.finished_at = time.time()


def latest_job() -> ManagerJob | None:
    if LATEST_JOB_ID is None:
        return None
    return JOBS.get(LATEST_JOB_ID)
