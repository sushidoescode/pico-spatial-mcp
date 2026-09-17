"""Explicit-target identity for every package-dependent operation.

Nothing here has a default package or a default expected build. A caller MUST name both, and the
bytes actually installed on the device MUST hash to the expected build, or the operation is refused
before it touches anything. That is what stops an installation check, broadcast, log capture,
performance run or receipt pull from silently addressing the original `com.picoagent.rocketsim`
install now that a second app (`com.picoagent.missionreplay`) exists from the same source tree.

Identity is taken device-side with /system/bin/sha256sum, so a check costs no 66 MB pull. The
installation check additionally pulls and re-hashes on the host; the rest re-verify cheaply.

These are FRESH tools. The frozen CP15 scripts they supersede are not edited; receipts already
produced by those scripts stay reproducible.
"""
from pathlib import Path
import argparse, datetime, hashlib, re, subprocess

PACKAGE_RE = re.compile(r'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
DEBUG_ACTION_SUFFIX = '.DEBUG_CMD'
AGENT_ACTION_SUFFIX = '.AGENT_CMD'


class TargetRefused(Exception):
    """Raised before any side effect when the named target cannot be proved."""


def debug_action(package: str) -> str:
    """Mirror of DebugChannels.debugAction. Never hardcode an action string."""
    if not PACKAGE_RE.match(package):
        raise TargetRefused(f'not a package name: {package!r}')
    return package + DEBUG_ACTION_SUFFIX


def agent_action(package: str) -> str:
    if not PACKAGE_RE.match(package):
        raise TargetRefused(f'not a package name: {package!r}')
    return package + AGENT_ACTION_SUFFIX


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def add_target_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--package', required=True,
                        help='REQUIRED. The exact applicationId to operate on. No default.')
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument('--expected-apk', type=Path,
                          help='REQUIRED (or --expected-sha256). Host path to the sealed build whose '
                               'bytes must already be installed.')
    identity.add_argument('--expected-sha256',
                          help='REQUIRED (or --expected-apk). SHA-256 of the sealed build.')
    parser.add_argument('--device', required=True,
                        help='REQUIRED. Explicit adb serial, e.g. emulator-5554. No default.')
    parser.add_argument('--require-running', action='store_true',
                        help='Refuse unless the target process is alive.')


def expected_sha(args) -> str:
    if args.expected_sha256:
        value = args.expected_sha256.strip().lower()
        if not re.fullmatch(r'[0-9a-f]{64}', value):
            raise TargetRefused('--expected-sha256 must be 64 hex characters')
        return value
    path = args.expected_apk.resolve()
    if not path.is_file():
        raise TargetRefused(f'--expected-apk not found: {path}')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resolve(args, commands: list) -> dict:
    """Prove the named package is installed on the named device with the expected bytes."""
    package, device = args.package, args.device
    if not PACKAGE_RE.match(package):
        raise TargetRefused(f'--package is not a package name: {package!r}')
    if not re.fullmatch(r'[A-Za-z0-9._:-]{3,64}', device):
        raise TargetRefused(f'--device is not an adb serial: {device!r}')
    want = expected_sha(args)

    def sh(*shell_args, required=True):
        argv = ['adb', '-s', device, 'shell', *shell_args]
        result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
        commands.append(dict(argv=argv, exitCode=result.returncode, stdout=result.stdout,
                             stderr=result.stderr, atUtc=now()))
        if required and result.returncode != 0:
            raise TargetRefused(f'{argv} exited {result.returncode}: {result.stderr.strip()}')
        return result

    paths = [line.removeprefix('package:').strip()
             for line in sh('pm', 'path', package, required=False).stdout.splitlines()
             if line.startswith('package:')]
    base = next((p for p in paths if p.endswith('/base.apk')), None)
    if base is None:
        raise TargetRefused(f'{package} is not installed on {device}; refusing to operate')

    digest = sh('sha256sum', base).stdout.split()[0].lower()
    if digest != want:
        raise TargetRefused(
            f'installed bytes of {package} are {digest}, expected {want}. Refusing: the device is '
            f'not running the build this operation was written for.')

    pid = sh('pidof', package, required=False)
    running = pid.returncode == 0 and bool(pid.stdout.strip())
    if args.require_running and not running:
        raise TargetRefused(f'{package} is not running on {device} and --require-running was given')

    return dict(package=package, device=device, remoteApk=base, installedSha256=digest,
                expectedSha256=want, identityVerified=True, running=running,
                pid=pid.stdout.strip() or None,
                fingerprint=sh('getprop', 'ro.build.fingerprint').stdout.strip(),
                bootQemu=sh('getprop', 'ro.boot.qemu').stdout.strip(),
                debugAction=debug_action(package), agentAction=agent_action(package),
                verifiedAtUtc=now(),
                method='pm path + device-side sha256sum of the installed base.apk')


def raw_logcat_argv(device: str, epoch: str) -> list:
    return ['adb', '-s', device, 'logcat', '-b', 'main', '-v', 'epoch', '-T', epoch, '*:V']


def immutable(path: Path) -> Path:
    if path.exists():
        raise TargetRefused(f'evidence is immutable, refusing to overwrite {path}')
    return path
