from __future__ import annotations

import asyncio
import gc
import importlib.util
import os
import signal
import sys
import tempfile
import textwrap
import time
import unittest
import warnings
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

MODULE_PATH = Path(__file__).parents[1] / "dashboard" / "plugin_api.py"
SPEC = importlib.util.spec_from_file_location("beads_plugin_api", MODULE_PATH)
api = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = api
SPEC.loader.exec_module(api)


class ExecutableFixture:
    def __init__(self, body: str):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "bd-fixture"
        self.path.write_text(
            "#!/usr/bin/python3\n" + textwrap.dedent(body),
            encoding="utf-8",
        )
        self.path.chmod(0o755)

    def cleanup(self):
        self.directory.cleanup()


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.root_dir.name).resolve()
        self.fixtures: list[ExecutableFixture] = []

    async def asyncTearDown(self):
        for fixture in self.fixtures:
            fixture.cleanup()
        self.root_dir.cleanup()

    def executable(self, body: str) -> Path:
        fixture = ExecutableFixture(body)
        self.fixtures.append(fixture)
        return fixture.path

    async def test_fixed_readonly_command_and_sanitized_environment(self):
        executable = self.executable(
            """
            import json, os, sys
            print(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "path": os.environ["PATH"]}))
            """
        )
        result = await api.run_bd(self.root, ("ready", "--limit", "100"), executable=executable)
        payload = api.parse_json_output(result)
        self.assertEqual(
            payload["argv"],
            ["--readonly", "--json", "-C", str(self.root), "ready", "--limit", "100"],
        )
        self.assertEqual(payload["cwd"], str(self.root))
        self.assertEqual(payload["path"], api.SAFE_PATH)

    async def test_successful_stderr_is_not_a_failure(self):
        executable = self.executable(
            """
            import sys
            sys.stderr.write("warning only\\n")
            print("{}")
            """
        )
        result = await api.run_bd(self.root, ("context",), executable=executable)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"warning only", result.stderr)

    async def test_services_execute_context_then_fixed_data_commands(self):
        beads_dir = self.root / ".beads"
        beads_dir.mkdir()
        executable = self.executable(
            """
            import json, pathlib, sys
            args = sys.argv[1:]
            root = args[args.index('-C') + 1]
            command = args[args.index(root) + 1:]
            if command == ['context']:
                print(json.dumps({'repo_root': root, 'beads_dir': str(pathlib.Path(root) / '.beads'), 'project_name': 'Fixture'}))
            elif command == ['status', '--no-activity']:
                print(json.dumps({'counts': {'ready': 2, 'open': 3, 'in_progress': 1, 'blocked': 4}}))
            elif command == ['list', '--status', 'open', '--limit', '100', '--flat']:
                print(json.dumps([{'id': 'gt--xyz', 'title': 'Fixture issue', 'status': 'open', 'owner': 'owner@example.com'}]))
            else:
                raise SystemExit(7)
            """
        )
        overview = await api.load_overview(self.root, str(self.root), executable)
        self.assertEqual(overview["counts"], {"ready": 2, "open": 3, "in_progress": 1, "blocked": 4})
        issues = await api.load_issues(self.root, "open", executable)
        self.assertEqual(issues["issues"][0]["id"], "gt--xyz")
        self.assertEqual(issues["issues"][0]["assignee"], "owner@example.com")
        self.assertEqual(issues["root"], str(self.root))

    async def test_nonzero_exit_is_normalized(self):
        executable = self.executable(
            """
            import sys
            sys.stderr.write("private failure")
            raise SystemExit(9)
            """
        )
        with self.assertRaises(api.ApiFailure) as caught:
            await api.run_bd(self.root, ("context",), executable=executable)
        self.assertEqual(caught.exception.code, "command_failed")
        self.assertNotIn("private", caught.exception.message)

    async def test_oversized_stdout_is_terminated(self):
        executable = self.executable(
            """
            import sys, time
            sys.stdout.write("x" * 4096)
            sys.stdout.flush()
            time.sleep(30)
            """
        )
        with self.assertRaises(api.ApiFailure) as caught:
            await api.run_bd(self.root, ("context",), executable=executable, stream_limit=1024, timeout_seconds=3)
        self.assertEqual(caught.exception.code, "output_too_large")

    async def test_oversized_stderr_is_terminated(self):
        executable = self.executable(
            """
            import sys, time
            sys.stderr.write("x" * 4096)
            sys.stderr.flush()
            time.sleep(30)
            """
        )
        with self.assertRaises(api.ApiFailure) as caught:
            await api.run_bd(self.root, ("context",), executable=executable, stream_limit=1024, timeout_seconds=3)
        self.assertEqual(caught.exception.code, "output_too_large")

    async def test_timeout_is_normalized(self):
        executable = self.executable(
            """
            import time
            time.sleep(30)
            """
        )
        with self.assertRaises(api.ApiFailure) as caught:
            await api.run_bd(self.root, ("context",), executable=executable, timeout_seconds=0.1)
        self.assertEqual(caught.exception.code, "command_timeout")

    async def test_cancellation_terminates_process(self):
        pid_file = Path(self.root_dir.name) / "cancel.pid"
        executable = self.executable(
            """
            import pathlib, sys, time
            pathlib.Path(sys.argv[-1]).write_text(str(__import__('os').getpid()))
            time.sleep(30)
            """
        )
        task = asyncio.create_task(api.run_bd(self.root, (str(pid_file),), executable=executable, timeout_seconds=10))
        for _ in range(100):
            if pid_file.exists():
                break
            await asyncio.sleep(0.01)
        self.assertTrue(pid_file.exists())
        pid = int(pid_file.read_text())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assert_process_gone(pid)

    async def test_timeout_kills_descendants_that_ignore_sigterm(self):
        child_file = Path(self.root_dir.name) / "child.pid"
        executable = self.executable(
            """
            import os, pathlib, signal, sys, time
            child = os.fork()
            if child == 0:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                pathlib.Path(sys.argv[-1]).write_text(str(os.getpid()))
                while True:
                    time.sleep(1)
            while True:
                time.sleep(1)
            """
        )
        with self.assertRaises(api.ApiFailure) as caught:
            await api.run_bd(
                self.root,
                (str(child_file),),
                executable=executable,
                timeout_seconds=0.2,
                termination_grace_seconds=0.1,
            )
        self.assertEqual(caught.exception.code, "command_timeout")
        self.assertTrue(child_file.exists())
        self.assert_process_gone(int(child_file.read_text()))

    async def test_reader_failure_terminates_process(self):
        pid_file = Path(self.root_dir.name) / "reader.pid"
        executable = self.executable(
            """
            import os, pathlib, sys, time
            pathlib.Path(sys.argv[-1]).write_text(str(os.getpid()))
            time.sleep(30)
            """
        )
        original = api._read_limited
        calls = 0

        async def failing_reader(stream, limit):
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.sleep(0.05)
                raise RuntimeError("reader failed")
            return await original(stream, limit)

        with mock.patch.object(api, "_read_limited", side_effect=failing_reader):
            with self.assertRaises(api.ApiFailure) as caught:
                await api.run_bd(self.root, (str(pid_file),), executable=executable, timeout_seconds=3)
        self.assertEqual(caught.exception.code, "command_failed")
        self.assertTrue(pid_file.exists())
        self.assert_process_gone(int(pid_file.read_text()))

    async def test_repeated_escaped_descendant_pipes_leave_no_transport_warnings(self):
        executable = self.executable(
            """
            import os, pathlib, sys, time
            child = os.fork()
            if child == 0:
                os.setsid()
                pathlib.Path(sys.argv[-1]).write_text(str(os.getpid()))
                time.sleep(30)
                raise SystemExit
            while not pathlib.Path(sys.argv[-1]).exists():
                time.sleep(0.001)
            time.sleep(30)
            """
        )
        descriptor_root = Path("/proc/self/fd")
        before = len(list(descriptor_root.iterdir()))
        child_pids = []
        try:
            with warnings.catch_warnings(record=True) as caught_warnings:
                warnings.simplefilter("always", ResourceWarning)
                for index in range(4):
                    child_file = Path(self.root_dir.name) / f"escaped-{index}.pid"
                    started = time.monotonic()
                    with self.assertRaises(api.ApiFailure) as caught:
                        await api.run_bd(
                            self.root,
                            (str(child_file),),
                            executable=executable,
                            timeout_seconds=0.2,
                            termination_grace_seconds=0.1,
                        )
                    self.assertEqual(caught.exception.code, "command_timeout")
                    self.assertLess(time.monotonic() - started, 2.0)
                    for _ in range(100):
                        if child_file.exists():
                            break
                        await asyncio.sleep(0.01)
                    self.assertTrue(child_file.exists())
                    child_pid = int(child_file.read_text())
                    os.kill(child_pid, 0)
                    child_pids.append(child_pid)
                await asyncio.sleep(0.05)
                gc.collect()
                await asyncio.sleep(0.05)
                after = len(list(descriptor_root.iterdir()))
            resource_warnings = [warning for warning in caught_warnings if issubclass(warning.category, ResourceWarning)]
            self.assertEqual(resource_warnings, [])
            self.assertLessEqual(after, before + 2)
        finally:
            for child_pid in child_pids:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def assert_process_gone(self, pid: int):
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.01)
        self.fail(f"process {pid} survived cleanup")


class BoundaryTests(unittest.TestCase):
    def test_root_component_containment_rejects_workspace_other(self):
        with tempfile.TemporaryDirectory() as base:
            base_path = Path(base)
            workspace = base_path / "workspace"
            workspace_other = base_path / "workspace-other"
            workspace.mkdir()
            workspace_other.mkdir()
            with self.assertRaises(api.ApiFailure) as caught:
                api.canonicalize_root(str(workspace_other), workspace)
        self.assertEqual(caught.exception.code, "root_outside_workspace")

    def test_root_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as base:
            base_path = Path(base)
            workspace = base_path / "workspace"
            outside = base_path / "outside"
            workspace.mkdir()
            outside.mkdir()
            link = workspace / "escape"
            link.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(api.ApiFailure) as caught:
                api.canonicalize_root(str(link), workspace)
        self.assertEqual(caught.exception.code, "root_outside_workspace")

    def test_context_rejects_redirected_repo_and_beads_escape(self):
        with tempfile.TemporaryDirectory() as base:
            base_path = Path(base)
            root = base_path / "project"
            other = base_path / "other"
            beads = root / ".beads"
            root.mkdir()
            other.mkdir()
            beads.mkdir()
            with self.assertRaises(api.ApiFailure) as redirected:
                api.validate_context({"repo_root": str(other), "beads_dir": str(beads)}, root)
            self.assertEqual(redirected.exception.code, "redirected_context")
            with self.assertRaises(api.ApiFailure) as escaped:
                api.validate_context({"repo_root": str(root), "beads_dir": str(other)}, root)
            self.assertEqual(escaped.exception.code, "context_escape")
            with self.assertRaises(api.ApiFailure) as redirected_flag:
                api.validate_context(
                    {"repo_root": str(root), "beads_dir": str(beads), "is_redirected": True},
                    root,
                )
            self.assertEqual(redirected_flag.exception.code, "redirected_context")

    def test_sanitized_path_resolves_installed_beads(self):
        executable = api.resolve_executable(env=api.sanitized_environment())
        self.assertEqual(executable.name, "beads")

    def test_live_status_field_names_are_normalized(self):
        status = {
            "summary": {
                "ready_issues": 43,
                "open_issues": 44,
                "in_progress_issues": 0,
                "blocked_issues": 1,
            }
        }
        self.assertEqual(
            api.normalize_counts(status),
            {"ready": 43, "open": 44, "in_progress": 0, "blocked": 1},
        )

    def test_view_commands_are_closed_and_fixed(self):
        self.assertEqual(api.VIEW_COMMANDS["ready"], ("ready", "--limit", "100"))
        self.assertEqual(api.VIEW_COMMANDS["open"], ("list", "--status", "open", "--limit", "100", "--flat"))
        self.assertEqual(
            api.VIEW_COMMANDS["in_progress"],
            ("list", "--status", "in_progress", "--limit", "100", "--flat"),
        )
        self.assertEqual(api.VIEW_COMMANDS["blocked"], ("blocked",))
        with self.assertRaises(api.ApiFailure):
            api.validate_view("closed")

    def test_repeated_hyphen_issue_id_is_valid(self):
        self.assertEqual(api.validate_issue_id("gt--xyz"), "gt--xyz")
        with self.assertRaises(api.ApiFailure):
            api.validate_issue_id("../gt--xyz")

    def test_normalization_caps_cards_and_stabilizes_shape(self):
        root = Path("/home/hermes/workspace/example")
        payload = [
            {
                "id": f"gt-{index}",
                "title": f"Issue {index}",
                "status": "open",
                "blocked_by": ["gt-0"],
            }
            for index in range(105)
        ]
        cards = api.normalize_cards(payload, root)
        self.assertEqual(len(cards), 100)
        self.assertEqual(cards[1]["blockerIds"], ["gt-0"])
        self.assertEqual(cards[1]["root"], str(root))

    def test_detail_keeps_relations_separate_from_blockers(self):
        root = Path("/home/hermes/workspace/example")
        detail = api.normalize_detail(
            {
                "id": "gt-1",
                "title": "Issue",
                "blocked_by": ["gt-blocker"],
                "dependencies": [
                    {"id": "gt-parent", "dependency_type": "parent-child"},
                    {"id": "gt-dependency", "dependency_type": "blocks"},
                ],
                "dependents": [{"id": "gt-child", "dependency_type": "blocks"}],
            },
            root,
        )
        self.assertEqual(detail["blockerIds"], ["gt-blocker", "gt-dependency"])
        self.assertEqual(
            detail["relations"],
            [
                {"id": "gt-parent", "type": "parent-child", "direction": "dependency"},
                {"id": "gt-dependency", "type": "blocks", "direction": "dependency"},
                {"id": "gt-child", "type": "blocks", "direction": "dependent"},
            ],
        )

    def test_invalid_status_shape_is_rejected(self):
        with self.assertRaises(api.ApiFailure) as missing:
            api.normalize_counts({})
        self.assertEqual(missing.exception.code, "malformed_response")
        with self.assertRaises(api.ApiFailure) as incomplete:
            api.normalize_counts({"summary": {"ready_issues": 1}})
        self.assertEqual(incomplete.exception.code, "malformed_response")

    def test_command_failures_are_classified_from_internal_output(self):
        missing_context = api.ApiFailure(
            "command_failed",
            "Beads could not be read.",
            True,
            502,
            api.CommandResult(b"", b"no beads project found", 1),
        )
        missing_issue = api.ApiFailure(
            "command_failed",
            "Beads could not be read.",
            True,
            502,
            api.CommandResult(b'{"error":"no issues found matching the provided IDs"}', b"", 1),
        )
        other = api.ApiFailure(
            "command_failed",
            "Beads could not be read.",
            True,
            502,
            api.CommandResult(b"", b"database corrupted", 1),
        )
        self.assertTrue(api.is_missing_beads_context(missing_context))
        self.assertTrue(api.is_missing_issue(missing_issue))
        self.assertFalse(api.is_missing_beads_context(other))
        self.assertFalse(api.is_missing_issue(other))

    def test_malformed_json_is_normalized(self):
        with self.assertRaises(api.ApiFailure) as caught:
            api.parse_json_output(api.CommandResult(b"not-json", b"", 0))
        self.assertEqual(caught.exception.code, "malformed_response")


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api.WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
        cls.root_dir = tempfile.TemporaryDirectory(dir=api.WORKSPACE_ROOT)
        cls.root = str(Path(cls.root_dir.name).resolve())
        app = FastAPI()
        app.include_router(api.router)
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.root_dir.cleanup()

    def assert_api_error(self, response, status, code):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.json(), {"detail": {"code": code, "message": response.json()["detail"]["message"], "retryable": False}})
        self.assertIsInstance(response.json()["detail"]["message"], str)

    def test_missing_root_uses_normalized_error(self):
        response = self.client.get("/overview")
        self.assert_api_error(response, 400, "invalid_root")

    def test_invalid_view_uses_normalized_error(self):
        response = self.client.get("/issues", params={"root": self.root, "view": "closed"})
        self.assert_api_error(response, 400, "invalid_view")

    def test_missing_view_uses_normalized_error(self):
        response = self.client.get("/issues", params={"root": self.root})
        self.assert_api_error(response, 400, "invalid_view")

    def test_invalid_issue_id_uses_normalized_error(self):
        response = self.client.get("/issues/bad!", params={"root": self.root})
        self.assert_api_error(response, 400, "invalid_issue_id")

    def test_routes_preserve_repeated_hyphen_id(self):
        expected = {"root": self.root, "id": "gt--xyz", "title": "ok"}
        with mock.patch.object(api, "load_issue", new=mock.AsyncMock(return_value=expected)) as load:
            response = self.client.get("/issues/gt--xyz", params={"root": self.root})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), expected)
        load.assert_awaited_once_with(Path(self.root), "gt--xyz")

    def test_overview_preserves_requested_root(self):
        requested = self.root + "/."
        expected = {"requestedRoot": requested, "root": self.root, "available": True}
        with mock.patch.object(api, "load_overview", new=mock.AsyncMock(return_value=expected)) as load:
            response = self.client.get("/overview", params={"root": requested})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["requestedRoot"], requested)
        load.assert_awaited_once_with(Path(self.root), requested)

    def test_issue_not_found_is_normalized(self):
        failure = api.ApiFailure("issue_not_found", "The issue was not found.", False, 404)
        with mock.patch.object(api, "load_issue", new=mock.AsyncMock(side_effect=failure)):
            response = self.client.get("/issues/gt-404", params={"root": self.root})
        self.assert_api_error(response, 404, "issue_not_found")

    def test_unexpected_route_failure_is_normalized(self):
        with mock.patch.object(api, "load_overview", new=mock.AsyncMock(side_effect=RuntimeError("private"))):
            response = self.client.get("/overview", params={"root": self.root})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            response.json(),
            {"detail": {"code": "internal_error", "message": "The Beads backend failed.", "retryable": True}},
        )


if __name__ == "__main__":
    unittest.main()
