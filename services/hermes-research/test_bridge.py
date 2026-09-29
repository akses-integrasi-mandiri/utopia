import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from bridge import HermesRunner, Invalid, Jobs, dispatch, handler, normalize_result, parse_result


def evidence():
    return {"sources": [{"url": "https://example.org/report", "title": "Report", "text": "Alice founded Acme."}],
            "claims": [{"text": "Alice founded Acme", "subject": "Alice", "subject_type": "PERSON",
                        "predicate": "founded", "object": "Acme", "quotes": [{"url": "https://example.org/report", "quote": "Alice founded Acme."}]}]}


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "jobs.db"
        self.calls = []
        def run(q, n):
            self.calls.append(q)
            return normalize_result(evidence(), n, "test-model")
        self.jobs = Jobs(self.path, run, start_worker=False)

    def tearDown(self):
        self.temp.cleanup()

    def test_concurrent_retry_creates_one_acquisition(self):
        jid = str(uuid4())
        with ThreadPoolExecutor(max_workers=8) as pool:
            states = list(pool.map(lambda _: self.jobs.start(jid, "Who is Alice?"), range(8)))
        self.assertTrue(all(s["state"] == "QUEUED" for s in states))
        self.assertTrue(self.jobs.run_one())
        self.assertFalse(self.jobs.run_one())
        self.assertEqual(len(self.calls), 1)
        again = self.jobs.start(jid, "Who is Alice?")
        self.assertEqual(again["state"], "COMPLETED")
        self.assertEqual(again["result"]["model_used"], "test-model")

    def test_idempotency_does_not_rebind_query_or_budget(self):
        jid = str(uuid4())
        self.jobs.start(jid, "Alice")
        for q, n in [("Bob", 8), ("Alice", 4)]:
            with self.assertRaises(Invalid):
                self.jobs.start(jid, q, n)

    def test_restart_preserves_queue_and_marks_interrupted_job_honestly(self):
        waiting, interrupted = str(uuid4()), str(uuid4())
        self.jobs.start(waiting, "Alice")
        self.jobs.start(interrupted, "Bob")
        with self.jobs.db() as db:
            db.execute("UPDATE jobs SET state='SEARCHING' WHERE id=?", (interrupted,))
        restarted = Jobs(self.path, self.jobs.runner, start_worker=False)
        self.assertEqual(restarted.status(interrupted)["state"], "FAILED")
        self.assertEqual(restarted.status(waiting)["state"], "QUEUED")
        restarted.run_one()
        self.assertEqual(restarted.status(waiting)["state"], "COMPLETED")

    def test_provider_error_does_not_leak_secrets(self):
        def fail(*_):
            raise RuntimeError("Authorization: Bearer secret-test-key")
        self.jobs.runner = fail
        jid = str(uuid4())
        self.jobs.start(jid, "Alice")
        self.jobs.run_one()
        result = self.jobs.status(jid)
        self.assertEqual(result["state"], "FAILED")
        self.assertNotIn("secret-test-key", json.dumps(result))

    def test_budget_and_query_are_bounded(self):
        for q, n in [("", 8), ("x" * 2001, 8), ("q", 100), ("q", True)]:
            with self.assertRaises(Invalid):
                self.jobs.start(str(uuid4()), q, n)
        for _ in range(8):
            self.jobs.start(str(uuid4()), "Alice")
        with self.assertRaisesRegex(Invalid, "queue is full"):
            self.jobs.start(str(uuid4()), "Alice")

    def test_mcp_tool_errors_are_errors_not_success_results(self):
        response = dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                             "params": {"name": "research_status", "arguments": {"job_id": str(uuid4())}}}, self.jobs)
        self.assertTrue(response["result"]["isError"])
        self.assertNotIn("structuredContent", response["result"])

    def test_history_limit_does_not_block_idempotent_replays(self):
        jid = str(uuid4())
        self.jobs.start(jid, "Alice")
        self.jobs.run_one()
        with patch("bridge.MAX_HISTORY", 1):
            self.assertEqual(self.jobs.start(jid, "Alice")["state"], "COMPLETED")
            with self.assertRaisesRegex(Invalid, "history is full"):
                self.jobs.start(str(uuid4()), "Bob")


class ParsingTests(unittest.TestCase):
    def test_fenced_json_and_session_footer(self):
        raw = '```json\n' + json.dumps(evidence()) + '\n```\nSession: xyz'
        self.assertEqual(parse_result(raw), evidence())

    def test_final_answer_wins_over_prefatory_schema_example(self):
        raw = '{"sources":[],"claims":[]}\nFinal answer:\n' + json.dumps(evidence())
        self.assertEqual(parse_result(raw), evidence())

    def test_no_fabricated_result_for_plain_language_failure(self):
        with self.assertRaises(Invalid):
            parse_result("I could not access the internet.")

    def test_unknown_quote_source_is_not_retained(self):
        raw = evidence()
        raw["claims"][0]["quotes"][0]["url"] = "https://unknown.org"
        self.assertEqual(normalize_result(raw, 8, "test")["claims"], [])

    def test_nested_model_values_cannot_crash_claim_validation(self):
        raw = evidence()
        raw["claims"][0]["subject_type"] = ["PERSON"]
        self.assertEqual(normalize_result(raw, 8, "test")["claims"], [])
        raw = evidence()
        raw["claims"][0]["quotes"][0]["url"] = {"url": "https://example.org/report"}
        self.assertEqual(normalize_result(raw, 8, "test")["claims"], [])

    def test_invalid_urls_and_empty_sources_fail(self):
        for url in ["file:///etc/passwd", "https://user:secret@example.com", "javascript:alert(1)"]:
            raw = evidence()
            raw["sources"][0]["url"] = url
            with self.assertRaises(Invalid):
                normalize_result(raw, 8, "test")
        with self.assertRaises(Invalid):
            normalize_result({"sources": []}, 8, "test")


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.jobs = Jobs(Path(self.temp.name) / "jobs.db", lambda *_: evidence(), start_worker=False)
        self.token = "a" * 48
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler(self.jobs, self.token))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/mcp"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, body, token=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if origin:
            headers["Origin"] = origin
        return urlopen(Request(self.url, json.dumps(body).encode(), headers), timeout=2)

    def test_auth_and_browser_origin(self):
        for token, origin, status in [(None, None, 401), ("wrong", None, 401), (self.token, "https://evil.example", 403)]:
            with self.assertRaises(HTTPError) as caught:
                self.request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token, origin)
            self.assertEqual(caught.exception.code, status)

    def test_initialize_discover_start_status(self):
        def call(method, params=None):
            with self.request({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, self.token) as response:
                return json.load(response)["result"]
        self.assertEqual(call("initialize", {"protocolVersion": "2025-03-26"})["protocolVersion"], "2025-03-26")
        self.assertEqual([t["name"] for t in call("tools/list")["tools"]], ["research_start", "research_status"])
        jid = str(uuid4())
        started = call("tools/call", {"name": "research_start", "arguments": {"job_id": jid, "query": "Alice"}})
        self.assertEqual(started["structuredContent"]["state"], "QUEUED")
        self.jobs.run_one()
        polled = call("tools/call", {"name": "research_status", "arguments": {"job_id": jid}})
        self.assertEqual(polled["structuredContent"]["state"], "COMPLETED")

    def test_unsupported_protocol_header_is_rejected(self):
        request = Request(self.url, b'{"jsonrpc":"2.0","id":1,"method":"ping"}',
                          {"Authorization": "Bearer " + self.token, "MCP-Protocol-Version": "1900-01-01"})
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=2)
        self.assertEqual(caught.exception.code, 400)


class ProcessTests(unittest.TestCase):
    def test_cli_receives_literal_query_file_and_result_is_parsed(self):
        with tempfile.TemporaryDirectory() as temp:
            command = Path(temp) / "hermes-fake"
            code = f'#!{sys.executable}\nimport json,sys\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index("--query-file")+1]).read_text()\nassert "$(touch" in p\nprint({json.dumps(evidence())!r})\n'
            command.write_text(code)
            command.chmod(0o700)
            runner = HermesRunner(str(command), temp, "test", 5)
            result = runner('$(touch /tmp/aim-should-never-execute) Who is Alice?', 8)
            self.assertEqual(len(result["claims"]), 1)

    def test_timeout_kills_process_and_does_not_return_partial_success(self):
        with tempfile.TemporaryDirectory() as temp:
            command = Path(temp) / "hermes-fake"
            command.write_text(f'#!{sys.executable}\nimport time\ntime.sleep(10)\n')
            command.chmod(0o700)
            with self.assertRaises(TimeoutError):
                HermesRunner(str(command), temp, "test", 0.1)("Alice", 8)

    def test_fast_oversize_output_cannot_be_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            command = Path(temp) / "hermes-fake"
            command.write_text(f'#!{sys.executable}\nprint({json.dumps(evidence())!r})\nprint("x" * 2000)\n')
            command.chmod(0o700)
            with patch("bridge.MAX_OUTPUT", 1000), self.assertRaisesRegex(Invalid, "size limit"):
                HermesRunner(str(command), temp, "test", 5)("Alice", 8)

    @unittest.skipUnless(sys.platform == "linux", "process groups are Linux deployment behavior")
    def test_orphan_child_is_killed_when_leader_exits(self):
        with tempfile.TemporaryDirectory() as temp:
            command = Path(temp) / "hermes-fake"
            child_pid = Path(temp) / "child.pid"
            command.write_text(f'#!{sys.executable}\nimport os,signal,time\npid=os.fork()\nif pid==0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n open({str(child_pid)!r},"w").write(str(os.getpid()))\n time.sleep(30)\nelse:\n time.sleep(0.05)\n print({json.dumps(evidence())!r},flush=True)\n')
            command.chmod(0o700)
            HermesRunner(str(command), temp, "test", 5)("Alice", 8)
            pid = int(child_pid.read_text())
            import time
            for _ in range(50):
                status = Path(f"/proc/{pid}/status")
                if not status.exists() or "\nState:\tZ" in status.read_text():
                    break
                time.sleep(0.02)
            else:
                self.fail("Hermes helper survived process group cleanup")


if __name__ == "__main__":
    unittest.main()
