from __future__ import annotations

from typing import Any
from urllib.parse import urlunparse

from aiohttp import ClientError, ClientSession

from .manager_process import ManagerApiError


def same_server_url(request: Any, path: str) -> str:
    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    host = request.headers.get("Host")
    if not host:
        raise ManagerApiError("Cannot determine the current ComfyUI server host.")
    return urlunparse((scheme, host, path, "", "", ""))


async def request_manager_no_body_post(url: str, provider: str) -> dict[str, Any]:
    try:
        async with ClientSession() as session:
            async with session.post(url) as response:
                text = await response.text()
                if response.status >= 400:
                    raise ManagerApiError(f"ComfyUI Manager request failed with HTTP {response.status}: {text}")
                return {
                    "provider": provider,
                    "status": response.status,
                    "message": text.strip(),
                }
    except ManagerApiError:
        raise
    except ClientError as error:
        raise ManagerApiError(f"ComfyUI Manager route is not available: {error}") from error
