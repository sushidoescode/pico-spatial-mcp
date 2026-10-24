"""Bounded I/O and cleanup for one newly-created POSIX process session.

The leader stays an unreaped child until the last group signal. Its reserved PID
cannot be reused as an unrelated process-group ID during cleanup. This module
never signals individual discovered PIDs or process groups outside that session.
"""
import math
import os
import selectors
import signal
import subprocess
import time


class OwnedProcessLoop:
    def __init__(self, command, *, cwd, env, timeout=180.0, stream_grace=2.0,
                 signal_graces=(2.0, 2.0, 1.0), reap_grace=0.5,
                 max_output_bytes=64 * 1024 * 1024):
        if os.name != 'posix' or not all(hasattr(os, name) for name in ('waitid', 'WNOWAIT', 'WEXITED', 'WNOHANG', 'P_PID')):
            raise RuntimeError('bounded host runner requires POSIX waitid(WNOWAIT)')
        if len(signal_graces) != 3 or any(not math.isfinite(g) or g <= 0 for g in (timeout, stream_grace, *signal_graces, reap_grace)):
            raise ValueError('positive finite process/stream/cleanup bounds required')
        self.command, self.cwd, self.env = command, cwd, env
        self.timeout, self.stream_grace = timeout, stream_grace
        self.signal_graces, self.reap_grace = signal_graces, reap_grace
        self.max_output_bytes = max_output_bytes
        self.process = self.selector = None
        self.started = self.exited_at = None
        self.termination = None
        self.terminating = self.reaped = False
        self.stdin_closed = self.close_input_when_drained = False
        self.pending_input = bytearray()
        self.open_outputs = set()
        self.cleanup_signals, self.cleanup_errors = [], []
        self.cleanup_notes = []
        self.output_bytes = 0
        self.output_truncated = False
        self.streams_drained = False

    @property
    def pid(self):
        return self.process.pid if self.process else None

    def _error(self, message):
        if len(self.cleanup_errors) < 20:
            self.cleanup_errors.append(message)

    def _observe_exit(self):
        # Never poll()/wait() here: either would reap the leader and release the
        # PID reservation before group cleanup. ECHILD means ownership was lost.
        state = os.waitid(os.P_PID, self.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if state is not None and state.si_pid == self.pid and self.exited_at is None:
            self.exited_at = time.monotonic()
        return self.exited_at is not None

    def send(self, data):
        if self.terminating or self.stdin_closed or self.close_input_when_drained:
            raise BrokenPipeError('owned host stdin is closed or draining')
        if len(self.pending_input) + len(data) > 1024 * 1024:
            raise RuntimeError('host input queue exceeded bounded capacity')
        self.pending_input.extend(data)
        if data:
            try:
                self.selector.get_key(self.process.stdin)
            except KeyError:
                self.selector.register(self.process.stdin, selectors.EVENT_WRITE, 'stdin')

    def close_stdin(self, *, discard=False):
        self.close_input_when_drained = True
        if discard:
            self.pending_input.clear()
        if self.stdin_closed or self.pending_input:
            return
        self.stdin_closed = True
        try:
            self.selector.unregister(self.process.stdin)
        except (KeyError, ValueError, AttributeError):
            pass
        self.process.stdin.close()

    def _pump(self, seconds, on_output, *, cleanup=False):
        if not self.selector.get_map():
            time.sleep(seconds)
            return
        for key, _ in self.selector.select(seconds):
            if key.data == 'stdin':
                try:
                    written = os.write(key.fileobj.fileno(), self.pending_input)
                    del self.pending_input[:written]
                except BlockingIOError:
                    continue
                except BrokenPipeError:
                    self.close_stdin(discard=True)
                    continue
                if not self.pending_input:
                    self.selector.unregister(key.fileobj)
                    if self.close_input_when_drained:
                        self.close_stdin()
                continue
            try:
                chunk = os.read(key.fileobj.fileno(), 65536)
            except BlockingIOError:
                continue
            if not chunk:
                self.selector.unregister(key.fileobj)
                self.open_outputs.discard(key.data)
                key.fileobj.close()
                continue
            remaining = max(0, self.max_output_bytes - self.output_bytes)
            self.output_bytes += len(chunk)
            self.output_truncated |= len(chunk) > remaining
            if remaining:
                try:
                    on_output(key.data, chunk[:remaining], self)
                except BaseException as error:
                    if not cleanup:
                        raise
                    self._error('cleanup output callback: ' + type(error).__name__)
            if self.output_truncated and not cleanup:
                raise RuntimeError('host output exceeded bounded capacity')

    def _signal_group(self, sig):
        if self.reaped:
            self._error('refused signal after leader reaped')
            return
        try:
            self._observe_exit()  # Confirms this exact PID is still our unreaped child.
        except OSError:
            self._error('refused signal: unreaped child identity unavailable')
            return
        try:
            os.killpg(self.pid, sig)
            self.cleanup_signals.append(signal.Signals(sig).name)
        except ProcessLookupError:
            pass
        except PermissionError as error:
            # Darwin can report EPERM for a group containing only the reserved
            # zombie leader. Do not infer that from EPERM or pipe EOF alone.
            members = self._dead_group_members() if self.exited_at is not None else None
            if members is not None:
                self.cleanup_notes.append({'signal': signal.Signals(sig).name,
                                           'kind': 'EPERM-no-live-group-members', 'members': members})
            else:
                self._error('group signal refused without proof of a dead group: ' + str(error))
        except OSError as error:
            self._error('group signal failed: ' + str(error))

    def _dead_group_members(self):
        """Bounded, read-only corroboration; never used to authorize a signal."""
        probe = None
        try:
            probe = subprocess.Popen(['/bin/ps', '-ax', '-o', 'pid=,pgid=,stat='],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0)
            stdout, _ = probe.communicate(timeout=0.2)
            if probe.returncode != 0:
                return None
            members = []
            for line in stdout.decode('ascii', errors='strict').splitlines():
                pid, pgid, state = line.split()
                if int(pgid) == self.pid:
                    if not state.startswith('Z'):
                        return None
                    members.append({'pid': int(pid), 'state': state})
            return members
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return None
        finally:
            if probe is not None:
                try:
                    if probe.returncode is None:
                        probe.kill()
                        probe.wait(timeout=0.1)
                except (OSError, subprocess.TimeoutExpired):
                    self._error('read-only process snapshot did not reap within its bound')
                finally:
                    probe.stdout.close();probe.stderr.close()

    def signal_leader(self, sig):
        """Interrupt only this still-owned live leader, without Popen.poll/reap."""
        if self.reaped or self._observe_exit():
            return False
        os.kill(self.pid, sig)
        return True

    def _finish(self, on_output):
        self.terminating = True
        try:
            self.close_stdin(discard=True)
        except BaseException as error:
            self._error('stdin close: ' + type(error).__name__)
        try:
            # Continue draining output during finite cleanup, even when the
            # leader exited earlier and only its descendants hold the pipes.
            for sig, grace in zip((signal.SIGINT, signal.SIGTERM, signal.SIGKILL), self.signal_graces):
                self._signal_group(sig)
                deadline = time.monotonic() + grace
                while time.monotonic() < deadline:
                    try:
                        if self.selector is None:
                            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
                        else:
                            self._pump(min(0.05, max(0, deadline - time.monotonic())), on_output, cleanup=True)
                    except BaseException as error:
                        self._error('cleanup drain: ' + type(error).__name__)
                        break
        finally:
            # Even a cleanup callback/selector failure cannot skip the final
            # owned-group kill. No group signalling occurs after wait reaps it.
            self._signal_group(signal.SIGKILL)
            self.streams_drained = not self.open_outputs
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                try:
                    stream.close()
                except BaseException as error:
                    self._error('pipe close: ' + type(error).__name__)
            if self.selector is not None:
                try:
                    self.selector.close()
                except BaseException as error:
                    self._error('selector close: ' + type(error).__name__)
            try:
                self.process.wait(timeout=self.reap_grace)
                self.reaped = True
            except subprocess.TimeoutExpired:
                self._error('leader did not exit within bounded reap grace')

    def run(self, on_started, on_output, *, on_tick=None):
        self.started = time.monotonic()
        self.process = subprocess.Popen(self.command, cwd=self.cwd, env=self.env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
        self.open_outputs = {'stdout', 'stderr'}
        try:
            self.selector = selectors.DefaultSelector()
            for name, stream in (('stdout', self.process.stdout), ('stderr', self.process.stderr)):
                os.set_blocking(stream.fileno(), False)
                self.selector.register(stream, selectors.EVENT_READ, name)
                self.open_outputs.add(name)
            os.set_blocking(self.process.stdin.fileno(), False)
            on_started(self)
            while True:
                exited = self._observe_exit()
                if on_tick is not None:
                    on_tick(self)
                now = time.monotonic()
                if exited and not self.open_outputs:
                    break
                if now >= self.started + self.timeout:
                    self.termination = 'deadline'
                    break
                if exited and now >= self.exited_at + self.stream_grace:
                    self.termination = 'streams_after_host_exit'
                    break
                deadline = min(self.started + self.timeout, self.exited_at + self.stream_grace if exited else float('inf'))
                self._pump(min(0.1, max(0, deadline - now)), on_output)
        except BaseException:
            self.termination = 'exception'
            raise
        finally:
            self._finish(on_output)
        return self.report()

    def report(self):
        return {'exitCode': self.process.returncode if self.process else None,
                'durationSeconds': round(time.monotonic() - self.started, 3) if self.started else 0,
                'pid': self.pid, 'termination': self.termination,
                'cleanupSignals': self.cleanup_signals, 'cleanupErrors': self.cleanup_errors,
                'cleanupNotes': self.cleanup_notes,
                'leaderReaped': self.reaped, 'streamsDrained': self.streams_drained,
                'outputTruncated': self.output_truncated,
                'cleanupScope': 'new task-owned process group; no discovered PID signalling',
                'maximumSeconds': self.timeout + sum(self.signal_graces) + self.reap_grace + 1.2}


def successful_outcome(report):
    return (report.get('exitCode') == 0 and report.get('termination') is None
            and report.get('leaderReaped') is True and report.get('streamsDrained') is True
            and not report.get('cleanupErrors') and not report.get('outputTruncated')
            and not report.get('runnerError'))
