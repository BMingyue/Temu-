"""Publish reviewed artifacts as one GitHub release; credentials stay in memory.

The plan lives outside Git and lists absolute artifact paths, sizes and hashes.
Without --publish this command only validates local files and the pushed tag.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
from pathlib import Path
import re
import subprocess
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
REPO = 'BMingyue/Temu-'
API = 'https://api.github.com/repos/' + REPO


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Unexpected GitHub API redirect; authentication was not forwarded')


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Git release precondition failed: ' + ' '.join(args[:2]))
    return result.stdout.strip()


def validate_plan(plan):
    if plan.get('repository') != REPO or not re.fullmatch(r'\d{4}\.\d{2}\.\d{2}\.\d+', plan.get('version', '')):
        raise ValueError('Unexpected repository or release version')
    if plan.get('tag') != 'v' + plan['version'] or not re.fullmatch('[0-9a-f]{40}', plan.get('commit', '')):
        raise ValueError('Release tag or source commit is invalid')
    assets = plan.get('assets')
    if not isinstance(assets, list) or not assets:
        raise ValueError('Reviewed artifact list is required')
    names = set()
    for item in assets:
        name = item.get('name', '')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,180}', name) or name.casefold() in names:
            raise ValueError('Unsafe or duplicate artifact name')
        names.add(name.casefold())
        path = Path(item['path'])
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise ValueError('Artifact must be an existing absolute regular file')
        if type(item.get('size')) is not int or not 0 < item['size'] < 2 * 1024**3 or path.stat().st_size != item['size']:
            raise ValueError('Artifact size mismatch: ' + name)
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != item.get('sha256'):
            raise ValueError('Artifact checksum mismatch: ' + name)
    required = {'SHA256SUMS.txt', 'TextileWorkbench-Setup-' + plan['version'] + '.zip'}
    if not required.issubset({a['name'] for a in assets}):
        raise ValueError('Setup and SHA256SUMS.txt artifacts are required')
    sums_path = Path(next(a['path'] for a in assets if a['name'] == 'SHA256SUMS.txt'))
    checks = {}
    for line in sums_path.read_text(encoding='utf-8-sig').splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,180})', line)
        if not match or match[2] in checks:
            raise ValueError('Malformed or duplicate checksum entry')
        checks[match[2]] = match[1]
    expected = {a['name']: a['sha256'] for a in assets if a['name'] != 'SHA256SUMS.txt'}
    if checks != expected:
        raise ValueError('Public checksum list must cover exactly the release artifacts')


def check_source(plan):
    if git('branch', '--show-current') != 'main' or git('status', '--porcelain'):
        raise RuntimeError('Publish only from a clean reviewed main worktree')
    if git('rev-parse', 'HEAD') != plan['commit']:
        raise RuntimeError('Plan does not match the source commit')
    origin = git('remote', 'get-url', 'origin')
    if origin.rstrip('/').removesuffix('.git') != 'https://github.com/' + REPO:
        raise RuntimeError('Unexpected Git origin')
    refs = dict(line.split('\t', 1)[::-1] for line in git(
        'ls-remote', 'origin', 'refs/heads/main', 'refs/tags/' + plan['tag']).splitlines())
    if refs.get('refs/heads/main') != plan['commit'] or refs.get('refs/tags/' + plan['tag']) != plan['commit']:
        raise RuntimeError('Push the reviewed main commit and matching lightweight tag first')


class GitHub:
    def __init__(self):
        result = subprocess.run(['git', 'credential', 'fill'], cwd=ROOT,
                                input='protocol=https\nhost=github.com\n\n',
                                capture_output=True, text=True, timeout=60)
        values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        self.token = values.get('password', '') if result.returncode == 0 else ''
        if not self.token:
            raise RuntimeError('GitHub authentication unavailable; use the Git credential manager')

    def headers(self):
        return {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'TextileWorkbench-release'}

    def call(self, method, path, body=None):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
        request = Request(API + path, data=data, method=method,
                          headers={**self.headers(), 'Content-Type': 'application/json'})
        try:
            with build_opener(NoRedirect()).open(request, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 404 and method == 'GET':
                return None
            raise RuntimeError('GitHub API returned HTTP ' + str(error.code)) from None

    def upload(self, release, asset):
        endpoint = urlsplit(release['upload_url'].split('{', 1)[0])
        if endpoint.scheme != 'https' or endpoint.netloc != 'uploads.github.com':
            raise RuntimeError('Unexpected GitHub asset upload host')
        connection = http.client.HTTPSConnection(endpoint.netloc, timeout=600)
        try:
            connection.putrequest('POST', endpoint.path + '?name=' + quote(asset['name']))
            for key, value in self.headers().items():
                connection.putheader(key, value)
            connection.putheader('Content-Type', 'application/octet-stream')
            connection.putheader('Content-Length', str(asset['size']))
            connection.endheaders()
            digest, sent = hashlib.sha256(), 0
            with Path(asset['path']).open('rb') as stream:
                while block := stream.read(1024 * 1024):
                    digest.update(block)
                    connection.send(block)
                    sent += len(block)
                    if sent % (32 * 1024 * 1024) == 0:
                        print(json.dumps({'upload': asset['name'], 'sent': sent, 'total': asset['size']}), flush=True)
            response = connection.getresponse()
            if response.status != 201:
                response.read()
                raise RuntimeError('GitHub asset upload returned HTTP ' + str(response.status))
            result = json.load(response)
            if sent != asset['size'] or digest.hexdigest() != asset['sha256']:
                raise RuntimeError('Artifact changed during upload; draft remains unpublished')
            return result
        finally:
            connection.close()


def verify_asset(remote, asset):
    if (remote.get('state') != 'uploaded' or remote.get('size') != asset['size']
            or remote.get('digest') != 'sha256:' + asset['sha256']):
        raise RuntimeError('Uploaded artifact checksum or size mismatch: ' + asset['name'])


def publish(plan, client):
    release = client.call('GET', '/releases/tags/' + quote(plan['tag']))
    if release and not release.get('draft'):
        raise RuntimeError('Release is already public; this tool never replaces public artifacts')
    if not release:
        release = client.call('POST', '/releases', {'tag_name': plan['tag'], 'target_commitish': plan['commit'],
            'name': plan['title'], 'body': plan['notes'], 'draft': True, 'prerelease': False})
    if release.get('target_commitish') not in (plan['commit'], 'main'):
        raise RuntimeError('Existing draft has an unexpected source target')
    existing = {a['name']: a for a in release.get('assets', [])}
    expected = {a['name']: a for a in plan['assets']}
    if set(existing) - set(expected):
        raise RuntimeError('Existing draft contains unreviewed artifacts')
    for asset in plan['assets']:
        remote = existing.get(asset['name']) or client.upload(release, asset)
        verify_asset(remote, asset)
        print(json.dumps({'verified_uploaded': asset['name'], 'size': asset['size']}), flush=True)
    checked = client.call('GET', '/releases/' + str(release['id']))
    actual = {a['name']: a for a in checked.get('assets', [])}
    if set(actual) != set(expected):
        raise RuntimeError('Draft artifact set differs; not published')
    for name, asset in expected.items():
        verify_asset(actual[name], asset)
    result = client.call('PATCH', '/releases/' + str(release['id']), {'draft': False, 'make_latest': 'true'})
    if result.get('draft') or result.get('prerelease'):
        raise RuntimeError('Release did not become public')
    return {'url': result['html_url'], 'tag': result['tag_name'], 'assets': len(actual)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding='utf-8'))
    validate_plan(plan)
    check_source(plan)
    if args.publish:
        print(json.dumps(publish(plan, GitHub()), ensure_ascii=False), flush=True)
    else:
        print(json.dumps({'validated': True, 'tag': plan['tag'], 'assets': len(plan['assets']), 'published': False}))


if __name__ == '__main__':
    main()
