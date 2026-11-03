"""Check committed Git objects without importing or running candidate code.

This is a static source check, not a business test, approval, secret scanner, or
merge authorization. CI must run the copy from the PR's trusted base commit.
"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


MAX_FILE_BYTES = 20 * 1024 * 1024
# Keep the source-only boundary aligned with maintenance/git_manager.py. These
# constants live here so CI can extract one trusted file and import no PR code.
PRIVATE_PARTS = {
    '.git', '.build', '.venv', '.migration', '.openai', '_shared_memory',
    'data', 'state', 'logs', 'runtime', 'node_modules', '__pycache__',
    'browser-profile', 'user-data', 'failure-records', 'failure_records',
    'outputs', 'work', 'reports', '.next', '.vinext', '.wrangler',
}
PRIVATE_NAMES = {
    'config.json', 'state.json', 'protected.json', 'cookies', 'login data',
    'bridge-token', 'credentials.json', 'installation.json', 'local-collaboration.json',
}
PRIVATE_SUFFIXES = {
    '.sqlite', '.sqlite3', '.db', '.log', '.pem', '.key', '.pfx', '.exe',
    '.dll', '.pyd', '.zip', '.7z', '.bundle', '.pyc', '.pyo', '.xpi', '.crx',
}
CONTROL_PATHS = {
    'AGENTS.md', 'COLLABORATION.md', '.gitignore',
    'maintenance/git_manager.py', 'maintenance/check_collaboration.py',
    'maintenance/test_collaboration.py',
}


class CheckError(RuntimeError):
    pass


def git(root: Path, *args: str, allow_failure: bool = False) -> bytes:
    result = subprocess.run(
        ['git', '-c', 'core.quotepath=false', '-C', str(root), *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=60,
    )
    if result.returncode and not allow_failure:
        # Do not echo source lines, tokens in Git configuration, or stderr.
        raise CheckError('Git operation failed: ' + args[0])
    if allow_failure:
        return b'1' if result.returncode else b'0'
    return result.stdout


def resolve_commit(root: Path, ref: str) -> str:
    if not ref or '\x00' in ref:
        raise CheckError('An explicit base and head commit are required')
    value = git(root, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise CheckError('Expected a full SHA-1 Git commit')
    return value


def private_reason(name: str) -> str:
    parts = name.split('/')
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {'', '.', '..'} or ':' in part or '\\' in part for part in parts):
        return 'path outside the source tree'
    lower = {part.casefold() for part in parts}
    if lower & PRIVATE_PARTS or any(part.startswith('.env') for part in lower):
        return 'runtime or private directory'
    if path.name.casefold() in PRIVATE_NAMES or path.suffix.casefold() in PRIVATE_SUFFIXES:
        return 'private, binary, or release file'
    if tuple(part.casefold() for part in parts[:3]) == ('local_tools', 'qualification', 'assets'):
        return 'personal qualification assets'
    return ''


def reject_constant(value: str):
    raise ValueError('Non-standard JSON constant: ' + value)


def check(root: Path, base_ref: str, head_ref: str) -> dict:
    base = resolve_commit(root, base_ref)
    head = resolve_commit(root, head_ref)
    if git(root, 'merge-base', '--is-ancestor', base, head, allow_failure=True) != b'0':
        raise CheckError('The exact base is not an ancestor of head; update the task branch and review again')

    changed = [name.decode('utf-8') for name in git(
        root, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head, '--',
    ).split(b'\0') if name]
    if git(root, 'diff', '--no-ext-diff', '--no-textconv', '--check', base, head, '--', allow_failure=True) != b'0':
        raise CheckError('The committed diff contains whitespace errors or conflict markers')

    tree = {}
    for record in git(root, 'ls-tree', '-r', '-l', '-z', '--full-tree', head).split(b'\0'):
        if not record:
            continue
        meta, raw_name = record.split(b'\t', 1)
        mode, kind, oid, size = meta.split()
        name = raw_name.decode('utf-8')
        if mode not in {b'100644', b'100755'} or kind != b'blob':
            raise CheckError('Links and submodules are excluded: ' + name)
        reason = private_reason(name)
        if reason:
            raise CheckError(reason + ': ' + name)
        if int(size) > MAX_FILE_BYTES:
            raise CheckError('File exceeds the 20 MiB source limit: ' + name)
        tree[name] = oid.decode('ascii')

    python_files, json_files = [], []
    for name in changed:
        if name not in tree:  # Deleted files have no candidate content to parse.
            continue
        suffix = PurePosixPath(name).suffix.casefold()
        if suffix not in {'.py', '.json'}:
            continue
        source = git(root, 'cat-file', 'blob', tree[name])
        try:
            if suffix == '.py':
                # Compile in memory to catch scope errors (e.g. top-level
                # return) too. The resulting code is never executed or saved.
                compile(ast.parse(source, filename=name), name, 'exec', dont_inherit=True)
                python_files.append(name)
            else:
                json.loads(source, parse_constant=reject_constant)
                json_files.append(name)
        except (SyntaxError, ValueError, UnicodeError) as error:
            # Print only the path/type, never the candidate source line.
            raise CheckError('Invalid ' + suffix + ' syntax: ' + name + ' (' + type(error).__name__ + ')') from None

    controls = [name for name in changed if name in CONTROL_PATHS or name.startswith('.github/')]
    return {
        'ok': True,
        'base': base,
        'head': head,
        'changed_files': changed,
        'tracked_files_checked': len(tree),
        'python_syntax_checked': python_files,
        'json_syntax_checked': json_files,
        'requires_special_review': controls,
        'validation_scope': 'static-only; no candidate code, dependencies, business API, or model executed',
        'limitations': [
            'Not a functional test or credential-content scanner',
            'Control-file changes require independent maintainer review; this JSON is not approval',
            'PR-controlled workflows need repository protections; this script cannot enforce those settings',
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--base', required=True)
    parser.add_argument('--head', required=True)
    args = parser.parse_args()
    try:
        result = check(args.root.resolve(), args.base, args.head)
    except (CheckError, OSError, subprocess.TimeoutExpired, UnicodeError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True))
        return 1
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
