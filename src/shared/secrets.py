"""Shared Parameter Store credential loader for Python (ECS Fargate) code.

Replaces the legacy hardcoded credentials. Reads SecureString parameters from
SSM under /sb/<env>/<group>/<key>, with a small in-process TTL cache so
long-running services don't re-fetch on every job.

Usage:
    from shared.secrets import get_secret, get_group
    api_key = get_secret("orderdesk", "api-key")
    ftp = get_group("ftp")  # {"host": ..., "user": ..., "password": ...}
"""

from __future__ import annotations

import os
import time
from typing import Dict, Optional

import boto3

_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
_ENV = os.environ.get("SB_ENV", "dev")
_TTL_S = float(os.environ.get("SECRET_CACHE_TTL_S", 5 * 60))  # 5 min

_client = boto3.client("ssm", region_name=_REGION)
_cache: Dict[str, tuple[float, object]] = {}  # name -> (expires, value)


def _prefix() -> str:
    return f"/sb/{_ENV}"


def _cached(name: str):
    hit = _cache.get(name)
    if hit and hit[0] > time.time():
        return hit[1]
    return None


def _store(name: str, value):
    _cache[name] = (time.time() + _TTL_S, value)
    return value


def get_secret(group: str, key: str) -> Optional[str]:
    """Fetch a single decrypted secret value by group + key."""
    name = f"{_prefix()}/{group}/{key}"
    hit = _cached(name)
    if hit is not None:
        return hit  # type: ignore[return-value]

    resp = _client.get_parameter(Name=name, WithDecryption=True)
    return _store(name, resp["Parameter"]["Value"])


def get_group(group: str) -> Dict[str, str]:
    """Fetch all keys within a group as a dict, via one paginated call."""
    path = f"{_prefix()}/{group}"
    hit = _cached(path)
    if hit is not None:
        return hit  # type: ignore[return-value]

    out: Dict[str, str] = {}
    paginator = _client.get_paginator("get_parameters_by_path")
    for page in paginator.paginate(Path=path, Recursive=True, WithDecryption=True):
        for p in page.get("Parameters", []):
            leaf = p["Name"].rsplit("/", 1)[-1]
            out[leaf] = p["Value"]

    return _store(path, out)


def clear_secret_cache() -> None:
    """Clear the in-process cache (useful in tests)."""
    _cache.clear()
