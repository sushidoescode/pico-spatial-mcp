"""Scoped handoff/artifact validation; does not build or execute MCP/app tests."""
import base64
import datetime
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
from urllib.parse import unquote

BASE = Path(__file__).resolve().parent
REPO = BASE.parent.parent
SOURCE = "308c898e9c33975b5a21ecb78fed245fab17a0ed"
DOCS = [REPO / name for name in [
    "docs/CLI_050_SDK61_EVOLUTION_HANDOFF_2026-09-15.md",
    "docs/CLI_050_SDK61_FRESH_CHAT_PROMPT_2026-09-15.md",
    "docs/superpowers/plans/2026-09-15-cli050-sdk61-evolution.md",
    "docs/superpowers/plans/2026-09-15-mcp-release-reliability.md",
    "docs/superpowers/plans/2026-09-15-sdk61-toolchain-knowledge.md",
]]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_json(path):
    return json.loads(path.read_text())

def git(*args):
    return subprocess.run(["git", *args], cwd=REPO, check=True, capture_output=True, text=True).stdout.strip()

def validate():
    release = read_json(BASE / "RELEASE_IDENTITY_001.json")
    registry = (BASE / "REGISTRY_001.json").read_bytes()
    assert digest(registry) == release["registrySha256"]
    assert json.loads(registry)["dist-tags"]["latest"] == "0.5.0"
    archives = {}
    for package in release["packages"]:
        payload = (BASE / package["saved"]).read_bytes()
        assert len(payload) == package["bytes"]
        assert digest(payload) == package["sha256"]
        assert "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode() == package["dist"]["integrity"]
        archives[package["version"]] = tarfile.open(fileobj=io.BytesIO(payload))

    members = {}
    excerpt_count = 0
    for filename in ["CLI050_STATIC_EXCERPTS_001.json", "FINAL_CONSUMER_EXCERPTS_001.json"]:
        for excerpt in read_json(BASE / filename)["excerpts"]:
            version = excerpt.get("version", "0.5.0")
            member = excerpt["member"]
            key = (version, member)
            if key not in members:
                if "!" in member:
                    outer, inner = member.split("!", 1)
                    nested = archives[version].extractfile(outer).read()
                    with tarfile.open(fileobj=io.BytesIO(nested)) as archive:
                        members[key] = archive.extractfile(inner).read()
                else:
                    members[key] = archives[version].extractfile(member).read()
            payload = members[key]
            assert digest(payload) == excerpt["memberSha256"]
            section = payload[excerpt["byteStart"]:excerpt["byteEndExclusive"]]
            assert digest(section) == excerpt["excerptSha256"]
            assert section.decode() == excerpt["excerpt"]
            excerpt_count += 1

    raw = read_json(BASE / "RAW_HELP_INDEX_002.json")
    for observation in raw["invocations"]:
        stem = BASE / observation["artifactStem"]
        assert digest(Path(str(stem) + ".stdout.txt").read_bytes()) == observation["stdoutSha256"]
        assert digest(Path(str(stem) + ".stderr.txt").read_bytes()) == observation["stderrSha256"]
        argv = observation["argv"]
        assert argv == ["-v"] or argv[-1] == "--help"
        assert argv[0] != "setup"
        assert not any(argv[i:i+2] == ["update", "--check"] for i in range(len(argv)-1))
        assert not observation["timedOut"] and not observation["outputTruncated"]
    assert len(raw["invocations"]) == 162
    assert sum(row["code"] != 0 for row in raw["invocations"]) == 6
    for run in ["001", "002"]:
        report = read_json(BASE / f"HELP_COMPARISON_{run}.json")
        receipt = read_json(BASE / f"HELP_COMPARISON_RUN_{run}.json")
        assert receipt["exitCode"] == 0
        assert (report["from"]["commandCount"], report["to"]["commandCount"]) == (69, 91)
        assert (len(report["addedCommands"]), len(report["removedCommands"])) == (25, 3)

    links = 0
    documents = DOCS + sorted(BASE.glob("*.md"))
    for document in documents:
        content = document.read_text()
        assert content.count("```") % 2 == 0, document
        stripped = re.sub(r"```[\s\S]*?```", "", content)
        stripped = re.sub(r"`[^`\n]*`", "", stripped)
        for match in re.finditer(r"!?\[[^\]]*\]\(([^)]+)\)", stripped):
            target = match.group(1).strip().split()[0].strip("<>")
            if re.match(r"^(https?:|mailto:|#)", target):
                continue
            target = unquote(target.split("#", 1)[0])
            target = re.sub(r":\d+(?:-\d+)?$", "", target)
            assert (document.parent / target).resolve().exists(), (str(document), target)
            links += 1

    # Tracked source is still exactly the audited baseline; only new handoff files are intended.
    unchanged = git("diff", "--name-only", SOURCE, "--", "src", "scripts", "test", "package.json", "package-lock.json", ".github", "AGENTS.md", "appskeleton", "unityskeleton")
    assert not unchanged, unchanged
    result = {
        "checkedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sourceBaseline": SOURCE,
        "observedHead": git("rev-parse", "HEAD"),
        "branch": git("branch", "--show-current"),
        "scope": "Handoff links, retained archive/help/excerpt integrity and unchanged audited production paths; no MCP build, regression battery or native acceptance.",
        "status": "pass",
        "documentCount": len(documents),
        "resolvedRelativeLinks": links,
        "verifiedPackageArchives": len(archives),
        "verifiedSourceExcerpts": excerpt_count,
        "verifiedVersionHelpInvocations": len(raw["invocations"]),
        "preservedNonzeroHelpResults": 6,
        "productionPathsUnchanged": True,
        "documentHashes": [{"path": str(p.relative_to(REPO)), "sha256": digest(p.read_bytes())} for p in DOCS],
    }
    for archive in archives.values():
        archive.close()
    return result

if __name__ == "__main__":
    import sys
    result = validate()
    output = json.dumps(result, indent=2) + "\n"
    if "--record" in sys.argv:
        with (BASE / "AUDIT_VALIDATION_001.json").open("x") as handle:
            handle.write(output)
    print(output)
