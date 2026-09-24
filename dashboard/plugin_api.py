from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

WORKSPACE_ROOT = Path("/home/hermes/workspace")
SAFE_PATH = "/home/linuxbrew/.linuxbrew/bin:/home/hermes/.local/bin:/usr/local/bin:/usr/bin:/bin"
MAX_STREAM_BYTES = 1024 * 1024
COMMAND_TIMEOUT_SECONDS = 12.0
TERMINATION_GRACE_SECONDS = 0.35
MAX_ISSUES = 100
MAX_SEARCH_QUERY_LENGTH = 200
ISSUE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
VIEW_COMMANDS: Mapping[str, tuple[str, ...]] = {
    "ready": ("ready", "--limit", "100"),
    "open": ("list", "--status", "open", "--limit", "100", "--flat"),
    "in_progress": ("list", "--status", "in_progress", "--limit", "100", "--flat"),
    "blocked": ("blocked",),
}


@dataclass(frozen=True)
class ApiFailure(Exception):
    code: str
    message: str
    retryable: bool = False
    status_code: int = 500
    result: CommandResult | None = None


@dataclass(frozen=True)
class CommandResult:
    stdout: bytes
    stderr: bytes
    returncode: int


class OutputTooLarge(Exception):
    pass


def error_body(code: str, message: str, retryable: bool = False) -> dict[str, Any]:
    return {"code": code, "message": message, "retryable": retryable}


def raise_http(failure: ApiFailure) -> None:
    raise HTTPException(
        status_code=failure.status_code,
        detail=error_body(failure.code, failure.message, failure.retryable),
    )


def canonicalize_root(raw_root: str | None, workspace_root: Path = WORKSPACE_ROOT) -> Path:
    if raw_root is None or not raw_root.strip():
        raise ApiFailure("invalid_root", "A project root is required.", False, 400)
    candidate = Path(raw_root)
    if not candidate.is_absolute():
        raise ApiFailure("invalid_root", "The project root must be absolute.", False, 400)
    try:
        canonical_workspace = workspace_root.resolve(strict=True)
        canonical = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ApiFailure("invalid_root", "The project root does not exist.", False, 400)
    if not canonical.is_dir():
        raise ApiFailure("invalid_root", "The project root must be a directory.", False, 400)
    try:
        canonical.relative_to(canonical_workspace)
    except ValueError:
        raise ApiFailure("root_outside_workspace", "The project root is outside the workspace.", False, 403)
    if canonical == canonical_workspace:
        raise ApiFailure("invalid_root", "Select a project directory below the workspace.", False, 400)
    return canonical


def validate_issue_id(issue_id: str | None) -> str:
    value = (issue_id or "").strip()
    if not ISSUE_ID_RE.fullmatch(value):
        raise ApiFailure("invalid_issue_id", "The issue ID is invalid.", False, 400)
    return value


def validate_view(view: str | None) -> str:
    value = (view or "").strip()
    if value not in VIEW_COMMANDS:
        raise ApiFailure("invalid_view", "The issue view is invalid.", False, 400)
    return value


def validate_search_query(query: str | None) -> str:
    value = (query or "").strip()
    if not value:
        raise ApiFailure("invalid_query", "A search query is required.", False, 400)
    if len(value) > MAX_SEARCH_QUERY_LENGTH:
        raise ApiFailure("invalid_query", "The search query is too long.", False, 400)
    return value


def sanitized_environment() -> dict[str, str]:
    env = {
        "PATH": SAFE_PATH,
        "HOME": "/home/hermes",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    if "TZ" in os.environ:
        env["TZ"] = os.environ["TZ"]
    return env


def resolve_executable(executable: str | Path | None = None, env: Mapping[str, str] | None = None) -> Path:
    environment = dict(env or sanitized_environment())
    raw = str(executable) if executable is not None else shutil.which("bd", path=environment["PATH"])
    if not raw:
        raise ApiFailure("beads_unavailable", "The Beads executable is unavailable.", False, 503)
    try:
        resolved = Path(raw).resolve(strict=True)
        mode = resolved.stat().st_mode
    except OSError:
        raise ApiFailure("beads_unavailable", "The Beads executable is unavailable.", False, 503)
    if not stat.S_ISREG(mode) or not os.access(resolved, os.X_OK):
        raise ApiFailure("beads_unavailable", "The Beads executable is unavailable.", False, 503)
    return resolved


async def _read_limited(stream: asyncio.StreamReader | None, limit: int) -> bytes:
    if stream is None:
        return b""
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > limit:
            raise OutputTooLarge
        chunks.append(chunk)


def _signal_group(pid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def _close_subprocess_transports(process: asyncio.subprocess.Process) -> None:
    for stream in (process.stdout, process.stderr):
        transport = getattr(stream, "_transport", None)
        if transport is not None:
            transport.close()
    transport = getattr(process, "_transport", None)
    if transport is not None:
        transport.close()


async def _terminate_process_group(
    process: asyncio.subprocess.Process,
    readers: Iterable[asyncio.Task[bytes]],
    grace_seconds: float,
) -> None:
    _signal_group(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=grace_seconds)
    except asyncio.TimeoutError:
        pass
    await asyncio.sleep(0)
    _signal_group(process.pid, signal.SIGKILL)
    try:
        await asyncio.wait_for(process.wait(), timeout=grace_seconds)
    except asyncio.TimeoutError:
        pass
    _, pending = await asyncio.wait(readers, timeout=grace_seconds)
    for reader in pending:
        reader.cancel()
    _close_subprocess_transports(process)
    await asyncio.gather(*readers, return_exceptions=True)
    await asyncio.sleep(0)


async def run_bd(
    root: Path,
    command: Sequence[str],
    *,
    executable: str | Path | None = None,
    timeout_seconds: float = COMMAND_TIMEOUT_SECONDS,
    stream_limit: int = MAX_STREAM_BYTES,
    termination_grace_seconds: float = TERMINATION_GRACE_SECONDS,
    env: Mapping[str, str] | None = None,
) -> CommandResult:
    environment = dict(env or sanitized_environment())
    binary = resolve_executable(executable, environment)
    argv = [str(binary), "--readonly", "--json", "-C", str(root), *command]
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(root),
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    stdout_task = asyncio.create_task(_read_limited(process.stdout, stream_limit))
    stderr_task = asyncio.create_task(_read_limited(process.stderr, stream_limit))
    readers = (stdout_task, stderr_task)

    async def complete() -> CommandResult:
        wait_task = asyncio.create_task(process.wait())
        try:
            await asyncio.gather(wait_task, stdout_task, stderr_task)
            return CommandResult(stdout_task.result(), stderr_task.result(), process.returncode or 0)
        finally:
            if not wait_task.done():
                wait_task.cancel()
                await asyncio.gather(wait_task, return_exceptions=True)

    try:
        result = await asyncio.wait_for(complete(), timeout=timeout_seconds)
    except OutputTooLarge:
        await _terminate_process_group(process, readers, termination_grace_seconds)
        raise ApiFailure("output_too_large", "Beads returned too much data.", True, 502)
    except asyncio.TimeoutError:
        await _terminate_process_group(process, readers, termination_grace_seconds)
        raise ApiFailure("command_timeout", "Beads did not respond in time.", True, 504)
    except asyncio.CancelledError:
        await _terminate_process_group(process, readers, termination_grace_seconds)
        raise
    except ApiFailure:
        await _terminate_process_group(process, readers, termination_grace_seconds)
        raise
    except Exception:
        await _terminate_process_group(process, readers, termination_grace_seconds)
        raise ApiFailure("command_failed", "Beads could not be read.", True, 502)

    if result.returncode != 0:
        raise ApiFailure("command_failed", "Beads could not be read.", True, 502, result)
    return result


def parse_json_output(result: CommandResult) -> Any:
    try:
        return json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiFailure("malformed_response", "Beads returned malformed data.", True, 502)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    values: list[str] = []
    for item in value:
        if isinstance(item, dict):
            candidate = item.get("id") or item.get("issue_id") or item.get("depends_on_id")
        else:
            candidate = item
        text = _as_text(candidate)
        if text:
            values.append(text)
    return values


def _first(mapping: Mapping[str, Any], names: Sequence[str]) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    return None


def _parent_id(item: Mapping[str, Any], issue_id: str) -> str | None:
    direct_present = "parent" in item or "parent_id" in item
    direct = _as_text(item.get("parent")) or _as_text(item.get("parent_id"))
    if direct_present:
        return direct if direct != issue_id else None

    candidates: list[str] = []
    dependencies = item.get("dependencies")
    if isinstance(dependencies, list):
        for dependency in dependencies:
            if not isinstance(dependency, dict):
                continue
            relation_type = _as_text(_first(dependency, ("dependency_type", "type")))
            if relation_type != "parent-child":
                continue
            if "depends_on_id" in dependency:
                if _as_text(dependency.get("issue_id")) != issue_id:
                    continue
                candidate = _as_text(dependency.get("depends_on_id"))
            else:
                candidate = _as_text(dependency.get("id"))
            if candidate and candidate != issue_id and candidate not in candidates:
                candidates.append(candidate)
    return candidates[0] if len(candidates) == 1 else None


def normalize_counts(status: Any) -> dict[str, int]:
    data = _as_dict(status)
    container = data.get("summary") if isinstance(data.get("summary"), dict) else data.get("counts")
    if not isinstance(container, dict):
        raise ApiFailure("malformed_response", "Beads returned invalid status counts.", True, 502)
    aliases = {
        "ready": ("ready", "ready_count", "ready_issues"),
        "open": ("open", "open_count", "open_issues"),
        "in_progress": ("in_progress", "inProgress", "in_progress_count", "in_progress_issues"),
        "blocked": ("blocked", "blocked_count", "blocked_issues"),
    }
    counts: dict[str, int] = {}
    for name, names in aliases.items():
        raw = _first(container, names)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ApiFailure("malformed_response", "Beads returned invalid status counts.", True, 502)
        counts[name] = max(0, int(raw))
    return counts


def _command_failure_text(failure: ApiFailure) -> str:
    if failure.result is None:
        return ""
    parts = []
    for stream in (failure.result.stdout, failure.result.stderr):
        parts.append(stream.decode("utf-8", errors="replace"))
    return "\n".join(parts).lower()


def is_missing_beads_context(failure: ApiFailure) -> bool:
    text = _command_failure_text(failure)
    return any(
        marker in text
        for marker in (
            "no beads project found",
            "not a git repository",
            "no beads database",
            "beads is not initialized",
        )
    )


def is_missing_issue(failure: ApiFailure) -> bool:
    text = _command_failure_text(failure)
    return "no issue found matching" in text or "no issues found matching" in text


def validate_context(context: Any, root: Path) -> dict[str, Any]:
    data = _as_dict(context)
    if data.get("is_redirected") is True:
        raise ApiFailure("redirected_context", "The Beads project points at another repository.", False, 409)
    repo_raw = _first(data, ("repo_root", "repoRoot", "root"))
    beads_raw = _first(data, ("beads_dir", "beadsDir", "database_path"))
    if not repo_raw or not beads_raw:
        raise ApiFailure("invalid_context", "Beads returned an invalid project context.", False, 409)
    try:
        repo_root = Path(str(repo_raw)).resolve(strict=True)
        beads_dir = Path(str(beads_raw)).resolve(strict=True)
    except (OSError, RuntimeError):
        raise ApiFailure("invalid_context", "Beads returned an invalid project context.", False, 409)
    if repo_root != root:
        raise ApiFailure("redirected_context", "The Beads project points at another repository.", False, 409)
    try:
        beads_dir.relative_to(root)
    except ValueError:
        raise ApiFailure("context_escape", "The Beads data directory escapes the project.", False, 409)
    return data


def normalize_card(raw: Any, root: Path) -> dict[str, Any]:
    item = _as_dict(raw)
    issue_id = _as_text(_first(item, ("id", "issue_id", "key")))
    title = _as_text(item.get("title"))
    if not issue_id or not title:
        raise ApiFailure("malformed_response", "Beads returned an invalid issue.", True, 502)
    blockers = _as_string_list(_first(item, ("blocker_ids", "blocked_by")))
    return {
        "root": str(root),
        "id": issue_id,
        "title": title,
        "status": _as_text(item.get("status")) or "open",
        "priority": _as_text(item.get("priority")),
        "type": _as_text(_first(item, ("type", "issue_type"))),
        "assignee": _as_text(_first(item, ("assignee", "owner"))),
        "updatedAt": _as_text(_first(item, ("updated_at", "updatedAt", "modified_at"))),
        "blockerIds": blockers,
        "parentId": _parent_id(item, issue_id),
    }


def normalize_cards(payload: Any, root: Path) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = _first(payload, ("issues", "items", "results"))
    else:
        rows = None
    if not isinstance(rows, list):
        raise ApiFailure("malformed_response", "Beads returned an invalid issue list.", True, 502)
    return [normalize_card(row, root) for row in rows[:MAX_ISSUES]]


def normalize_detail(payload: Any, root: Path) -> dict[str, Any]:
    if isinstance(payload, list):
        if not payload:
            raise ApiFailure("issue_not_found", "The issue was not found.", False, 404)
        raw = payload[0]
    elif isinstance(payload, dict) and isinstance(payload.get("issue"), dict):
        raw = payload["issue"]
    else:
        raw = payload
    item = _as_dict(raw)
    detail = normalize_card(item, root)
    blockers = list(detail["blockerIds"])
    blocker_set = set(blockers)
    relations = []
    relation_set: set[tuple[str, str | None, str]] = set()
    relation_groups = (
        (item.get("relations"), "related"),
        (item.get("dependencies"), "dependency"),
        (item.get("dependents"), "dependent"),
        (item.get("related"), "related"),
    )
    for relations_raw, direction in relation_groups:
        if not isinstance(relations_raw, list):
            continue
        for relation in relations_raw:
            if isinstance(relation, dict):
                relation_id = _as_text(_first(relation, ("id", "issue_id")))
                relation_type = _as_text(_first(relation, ("dependency_type", "type")))
                if relation_id:
                    key = (relation_id, relation_type, direction)
                    if key not in relation_set:
                        relation_set.add(key)
                        relations.append({"id": relation_id, "type": relation_type, "direction": direction})
                    if direction == "dependency" and relation_type == "blocks" and relation_id not in blocker_set:
                        blocker_set.add(relation_id)
                        blockers.append(relation_id)
            else:
                relation_id = _as_text(relation)
                if relation_id:
                    key = (relation_id, None, direction)
                    if key not in relation_set:
                        relation_set.add(key)
                        relations.append({"id": relation_id, "type": None, "direction": direction})
    detail["blockerIds"] = blockers
    detail.update(
        {
            "description": _as_text(item.get("description")),
            "design": _as_text(item.get("design")),
            "acceptanceCriteria": _as_text(_first(item, ("acceptance_criteria", "acceptanceCriteria"))),
            "notes": _as_text(item.get("notes")),
            "relations": relations,
        }
    )
    return detail


def merge_search_results(root: Path, groups: Sequence[tuple[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for match_kind, payload in groups:
        for card in normalize_cards(payload, root):
            existing = merged.get(card["id"])
            if existing is None:
                if len(merged) >= MAX_ISSUES:
                    continue
                existing = {**card, "matchKinds": []}
                merged[card["id"]] = existing
            if match_kind not in existing["matchKinds"]:
                existing["matchKinds"].append(match_kind)
    return list(merged.values())


def _first_api_failure(group: BaseExceptionGroup) -> ApiFailure | None:
    for error in group.exceptions:
        if isinstance(error, ApiFailure):
            return error
        if isinstance(error, BaseExceptionGroup):
            nested = _first_api_failure(error)
            if nested is not None:
                return nested
    return None


async def run_search_reads(
    root: Path,
    query: str,
    *,
    executable: str | Path | None = None,
    deadline_seconds: float = COMMAND_TIMEOUT_SECONDS,
) -> tuple[CommandResult, CommandResult, CommandResult]:
    commands = (
        ("search", f"--query={query}", "--limit", "100"),
        ("list", f"--desc-contains={query}", "--limit", "100", "--flat"),
        ("list", f"--notes-contains={query}", "--limit", "100", "--flat"),
    )
    tasks: list[asyncio.Task[CommandResult]] = []
    try:
        async with asyncio.timeout(deadline_seconds):
            async with asyncio.TaskGroup() as group:
                tasks = [group.create_task(run_bd(root, command, executable=executable)) for command in commands]
    except TimeoutError:
        raise ApiFailure("search_timeout", "Beads search did not respond in time.", True, 504)
    except BaseExceptionGroup as group:
        failure = _first_api_failure(group)
        if failure is not None:
            raise failure
        raise ApiFailure("command_failed", "Beads could not be searched.", True, 502)
    return tasks[0].result(), tasks[1].result(), tasks[2].result()


async def read_context(root: Path, executable: str | Path | None = None) -> dict[str, Any]:
    result = await run_bd(root, ("context",), executable=executable)
    return validate_context(parse_json_output(result), root)


async def load_overview(root: Path, requested_root: str, executable: str | Path | None = None) -> dict[str, Any]:
    try:
        context_result = await run_bd(root, ("context",), executable=executable)
    except ApiFailure as failure:
        if failure.code == "command_failed" and is_missing_beads_context(failure):
            return {
                "requestedRoot": requested_root,
                "root": str(root),
                "project": {"name": root.name, "repository": root.name},
                "available": False,
                "counts": {"ready": 0, "open": 0, "in_progress": 0, "blocked": 0},
                "observedAt": datetime.now(timezone.utc).isoformat(),
            }
        raise
    context = validate_context(parse_json_output(context_result), root)
    status = _as_dict(parse_json_output(await run_bd(root, ("status", "--no-activity"), executable=executable)))
    project_name = _as_text(_first(context, ("project_name", "project", "name"))) or root.name
    repository = _as_text(_first(context, ("repo_name", "repository"))) or root.name
    return {
        "requestedRoot": requested_root,
        "root": str(root),
        "project": {"name": project_name, "repository": repository},
        "available": True,
        "counts": normalize_counts(status),
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }


async def load_issues(root: Path, view: str, executable: str | Path | None = None) -> dict[str, Any]:
    await read_context(root, executable)
    payload = parse_json_output(await run_bd(root, VIEW_COMMANDS[view], executable=executable))
    cards = normalize_cards(payload, root)
    if view == "blocked" and cards:
        issue_ids = [card["id"] for card in cards]
        hydration_payload = parse_json_output(
            await run_bd(
                root,
                ("list", f"--id={','.join(issue_ids)}", "--limit", "100", "--flat"),
                executable=executable,
            )
        )
        hydration_cards = normalize_cards(hydration_payload, root)
        expected = set(issue_ids)
        hydrated: dict[str, dict[str, Any]] = {}
        for card in hydration_cards:
            if card["id"] not in expected or card["id"] in hydrated:
                raise ApiFailure("malformed_response", "Beads returned invalid blocked issue hydration.", True, 502)
            hydrated[card["id"]] = card
        cards = [{**card, "parentId": hydrated.get(card["id"], {}).get("parentId")} for card in cards]
    return {
        "root": str(root),
        "view": view,
        "issues": cards,
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }


async def load_search(
    root: Path,
    query: str,
    executable: str | Path | None = None,
    *,
    deadline_seconds: float = COMMAND_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    await read_context(root, executable)
    results = await run_search_reads(root, query, executable=executable, deadline_seconds=deadline_seconds)
    groups = (
        ("id_or_title", parse_json_output(results[0])),
        ("description", parse_json_output(results[1])),
        ("notes", parse_json_output(results[2])),
    )
    return {
        "root": str(root),
        "query": query,
        "issues": merge_search_results(root, groups),
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }


async def load_issue(root: Path, issue_id: str, executable: str | Path | None = None) -> dict[str, Any]:
    await read_context(root, executable)
    try:
        result = await run_bd(root, ("show", f"--id={issue_id}", "--include-dependents"), executable=executable)
    except ApiFailure as failure:
        if failure.code == "command_failed" and is_missing_issue(failure):
            raise ApiFailure("issue_not_found", "The issue was not found.", False, 404)
        raise
    detail = normalize_detail(parse_json_output(result), root)
    detail["observedAt"] = datetime.now(timezone.utc).isoformat()
    return detail


@router.get("/overview")
async def overview(root: str | None = Query(default=None)) -> dict[str, Any]:
    try:
        canonical = canonicalize_root(root)
        return await load_overview(canonical, root or "")
    except ApiFailure as failure:
        raise_http(failure)
    except Exception:
        raise_http(ApiFailure("internal_error", "The Beads backend failed.", True, 500))


@router.get("/issues")
async def issues(
    root: str | None = Query(default=None),
    view: str | None = Query(default=None),
) -> dict[str, Any]:
    try:
        canonical = canonicalize_root(root)
        selected_view = validate_view(view)
        return await load_issues(canonical, selected_view)
    except ApiFailure as failure:
        raise_http(failure)
    except Exception:
        raise_http(ApiFailure("internal_error", "The Beads backend failed.", True, 500))


@router.get("/issues/{issue_id}")
async def issue(issue_id: str, root: str | None = Query(default=None)) -> dict[str, Any]:
    try:
        canonical = canonicalize_root(root)
        validated_id = validate_issue_id(issue_id)
        return await load_issue(canonical, validated_id)
    except ApiFailure as failure:
        raise_http(failure)
    except Exception:
        raise_http(ApiFailure("internal_error", "The Beads backend failed.", True, 500))


@router.get("/search")
async def search(
    root: str | None = Query(default=None),
    q: str | None = Query(default=None),
) -> dict[str, Any]:
    try:
        canonical = canonicalize_root(root)
        query = validate_search_query(q)
        return await load_search(canonical, query)
    except ApiFailure as failure:
        raise_http(failure)
    except Exception:
        raise_http(ApiFailure("internal_error", "The Beads backend failed.", True, 500))
