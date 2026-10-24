#!/usr/bin/env python3
"""Finite ordinary-child tests. No host clients, devices, models or settings."""
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from host_conformance_process import OwnedProcessLoop, successful_outcome

SUPPORTED = os.name == 'posix' and hasattr(os, 'WNOWAIT')
IGNORE_SIGNALS = 'import os,signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN);'


@unittest.skipUnless(SUPPORTED, 'POSIX waitid(WNOWAIT) required; no cleanup evidence on this platform')
class OwnedProcessTests(unittest.TestCase):
    def make_loop(self, source, *, timeout=0.25):
        temporary = tempfile.TemporaryDirectory(prefix='pico-host-process-')
        self.addCleanup(temporary.cleanup)
        return OwnedProcessLoop([sys.executable, '-c', source], cwd=temporary.name,
                                env={**os.environ, 'PICO_ADB': '/fixture/no/such/adb'},
                                timeout=timeout, stream_grace=0.1,
                                signal_graces=(0.05, 0.05, 0.1), reap_grace=0.3)

    def execute(self, loop, on_started=None, on_output=None):
        captured = {'stdout': bytearray(), 'stderr': bytearray()}
        def consume(label, chunk, control):
            captured[label].extend(chunk)
            if on_output:
                on_output(label, chunk, control)
        started = time.monotonic()
        result = loop.run(on_started or (lambda control: control.close_stdin()), consume)
        self.assertLess(time.monotonic() - started, 2.0, result)
        self.assertTrue(result['leaderReaped'], result)
        return result, captured

    def test_normal_exit_retains_output_and_reaps_only_after_group_cleanup(self):
        loop = self.make_loop('print("complete",flush=True)')
        actual_killpg = os.killpg
        signals = []
        def checked_signal(pgid, sig):
            self.assertEqual(pgid, loop.pid)
            self.assertIsNone(loop.process.returncode, 'leader was reaped before signalling')
            # This succeeds only while the reserved PID remains our child.
            os.waitid(os.P_PID, pgid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            signals.append(sig)
            actual_killpg(pgid, sig)
        with mock.patch('host_conformance_process.os.killpg', side_effect=checked_signal):
            result, output = self.execute(loop)
        self.assertEqual(result['exitCode'], 0)
        self.assertIsNone(result['termination'])
        self.assertEqual(output['stdout'], b'complete\n')
        self.assertTrue(result['streamsDrained'])
        self.assertIn(signal.SIGKILL, signals)
        self.assertTrue(successful_outcome(result), result)

    def test_leader_exit_does_not_leave_pipe_owning_descendant_unbounded(self):
        grandchild = IGNORE_SIGNALS + 'time.sleep(3)'
        source = ('import os,subprocess,sys;'
                  f'p=subprocess.Popen([sys.executable,"-c",{grandchild!r}]);'
                  'print(p.pid,flush=True);os._exit(0)')
        result, output = self.execute(self.make_loop(source, timeout=1.0))
        self.assertEqual(result['termination'], 'streams_after_host_exit')
        self.assertEqual(result['exitCode'], 0)
        self.assertTrue(result['streamsDrained'], result)
        descendant = int(output['stdout'].splitlines()[0])
        state = subprocess.run(['/bin/ps', '-p', str(descendant), '-o', 'stat='],
                               capture_output=True, text=True, timeout=1).stdout.strip()
        self.assertTrue(not state or state.startswith('Z'), 'owned descendant remained running: ' + state)

    def test_early_stream_eof_does_not_cause_unbounded_process_wait(self):
        source = IGNORE_SIGNALS + 'os.close(1);os.close(2);time.sleep(3)'
        result, _ = self.execute(self.make_loop(source))
        self.assertEqual(result['termination'], 'deadline')
        self.assertEqual(result['exitCode'], -signal.SIGKILL)
        self.assertTrue(result['streamsDrained'])

    def test_output_callback_exception_still_cleans_owned_group(self):
        source = IGNORE_SIGNALS + 'print("bad-event",flush=True);time.sleep(3)'
        loop = self.make_loop(source)
        def rejected_output(_label, _chunk, _control):
            raise ValueError('synthetic parser failure')
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, 'synthetic parser failure'):
            loop.run(lambda control: control.close_stdin(), rejected_output)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertEqual(loop.report()['termination'], 'exception')
        self.assertTrue(loop.report()['leaderReaped'])
        self.assertEqual(loop.process.returncode, -signal.SIGKILL)

    def test_blocked_stdin_cannot_hold_the_runtime_deadline(self):
        result, _ = self.execute(self.make_loop(IGNORE_SIGNALS + 'time.sleep(3)'),
                                 on_started=lambda control: control.send(b'x' * (1024 * 1024)))
        self.assertEqual(result['termination'], 'deadline')
        self.assertEqual(result['exitCode'], -signal.SIGKILL)

    def test_cleanup_does_not_signal_an_unrelated_task_group(self):
        sentinel = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(3)'],
                                    start_new_session=True, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            result, _ = self.execute(self.make_loop(IGNORE_SIGNALS + 'time.sleep(3)'))
            self.assertIsNone(sentinel.poll(), 'independent sentinel was signalled')
            self.assertNotEqual(result['pid'], sentinel.pid)
        finally:
            sentinel.terminate()
            try:
                sentinel.wait(timeout=1)
            except subprocess.TimeoutExpired:
                sentinel.kill();sentinel.wait(timeout=1)

    def test_nonfinite_bounds_refuse_before_process_creation(self):
        for timeout in (float('inf'), float('nan'), -1):
            with self.assertRaises(ValueError):
                OwnedProcessLoop(['never-spawn'], cwd='/', env={}, timeout=timeout)

    def test_tick_callback_exception_cleans_owned_process(self):
        loop = self.make_loop('import time;time.sleep(3)')
        def tick(_control):
            raise ValueError('synthetic tick failure')
        with self.assertRaisesRegex(ValueError, 'synthetic tick failure'):
            loop.run(lambda control: control.close_stdin(), lambda *_: None, on_tick=tick)
        self.assertTrue(loop.report()['leaderReaped'])
        self.assertEqual(loop.report()['termination'], 'exception')

    def test_permission_refusal_is_not_assumed_to_mean_group_is_dead(self):
        loop = self.make_loop('print("complete",flush=True)')
        with mock.patch('host_conformance_process.os.killpg', side_effect=PermissionError('synthetic EPERM')), \
             mock.patch.object(loop, '_dead_group_members', return_value=None):
            result, _ = self.execute(loop)
        self.assertTrue(result['cleanupErrors'])
        self.assertFalse(successful_outcome(result))

    def test_unsuccessful_host_or_cleanup_cannot_be_reported_as_shell_success(self):
        clean = {'exitCode': 0, 'termination': None, 'leaderReaped': True,
                 'streamsDrained': True, 'cleanupErrors': [], 'outputTruncated': False,
                 'cleanupNotes': [{'kind': 'EPERM-no-live-group-members', 'members': []}]}
        self.assertTrue(successful_outcome(clean))
        for changed in ({'exitCode': 1}, {'termination': 'deadline'}, {'leaderReaped': False},
                        {'streamsDrained': False}, {'cleanupErrors': ['unresolved']},
                        {'outputTruncated': True}, {'runnerError': {'type': 'ValueError'}}):
            self.assertFalse(successful_outcome({**clean, **changed}), changed)


if __name__ == '__main__':
    unittest.main(verbosity=2)
