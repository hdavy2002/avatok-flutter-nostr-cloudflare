#!/usr/bin/env python3
"""Explicit CI-only R2 publication. Immutable objects first; release pointer last."""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


def publish():
    if os.environ.get('AVATOK_CF_WRAPPER') != '1':
        raise RuntimeError('Use scripts/cf.sh catalogs publish for the shared environment gate')
    import boto3
    from botocore.exceptions import ClientError
    target = os.environ.get('AVATOK_TARGET')
    if target not in ('staging', 'prod'):
        raise RuntimeError('Explicit AVATOK_TARGET required')
    if target == 'prod' and os.environ.get('ALLOW_PROD') != '1':
        raise RuntimeError('Production write requires ALLOW_PROD=1 and approved workflow environment')
    account = os.environ.get('R2_ACCOUNT_ID', '')
    if not re.fullmatch(r'[a-f0-9]{32}', account):
        raise RuntimeError('R2 account must be configured explicitly')
    root = Path(os.environ.get('UI_CATALOG_OUTPUT', 'artifacts/ui-catalogs')).resolve()
    subprocess.run(['node', 'scripts/i18n/validate_release.mjs', str(root)], check=True)
    manifest_bytes = (root / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    release = manifest['release']
    if manifest.get('schemaVersion') != 1 or not re.fullmatch(r'[a-f0-9]{64}', release):
        raise RuntimeError('Invalid manifest')
    locales = {item['code'] for item in json.loads(Path('shared/i18n/locales.json').read_text())}
    complete = all(locale in manifest['locales'] and set(manifest['locales'][locale]['namespaces']) == set(manifest['namespaces']) for locale in locales)
    if not complete and os.environ.get('ACKNOWLEDGE_PARTIAL') != '1':
        raise RuntimeError('Incomplete locale coverage: explicit ACKNOWLEDGE_PARTIAL=1 is required to replace the release pointer')
    objects = []
    for locale, entry in manifest['locales'].items():
        if locale not in locales:
            raise RuntimeError('Unsupported locale')
        for ns in entry['namespaces']:
            if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', ns) or ns not in manifest['namespaces']:
                raise RuntimeError('Invalid namespace')
            relative = f'{release}/{locale}/{ns}.json'
            data = (root / relative).read_bytes()
            obj = json.loads(data)
            if len(data) > 2 * 1024 * 1024 or any(obj.get(k) != v for k, v in dict(schemaVersion=1, release=release, locale=locale, namespace=ns).items()):
                raise RuntimeError('Catalog envelope mismatch')
            objects.append((relative, data))
    if not objects or 'en' not in manifest['locales']:
        raise RuntimeError('No English source catalogs')
    # A dedicated bucket-scoped CI credential; no broad Cloudflare API token.
    s3 = boto3.client('s3', endpoint_url=f'https://{account}.r2.cloudflarestorage.com', region_name='auto')
    bucket = 'avatok-blobs' if target == 'prod' else 'avatok-blobs-staging'
    prefix = f'ui-catalogs/{target}/v1/'
    objects.append((f'{release}/manifest.json', manifest_bytes))
    for relative, data in objects:
        key = prefix + relative
        digest = hashlib.sha256(data).hexdigest()
        try:
            s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType='application/json; charset=utf-8',
                          CacheControl='public, max-age=31536000, immutable', Metadata={'sha256': digest}, IfNoneMatch='*')
        except ClientError as exc:
            if exc.response['ResponseMetadata']['HTTPStatusCode'] not in (409, 412):
                raise
            existing = s3.get_object(Bucket=bucket, Key=key)
            if existing['ContentLength'] > 2 * 1024 * 1024 or hashlib.sha256(existing['Body'].read()).hexdigest() != digest:
                raise RuntimeError('Immutable catalog conflict') from exc
        head = s3.head_object(Bucket=bucket, Key=key)
        if head['ContentLength'] != len(data) or head.get('Metadata', {}).get('sha256') != digest:
            raise RuntimeError('Published catalog verification failed')
    # Compatibility pointers are keyed by namespace source hash, never by app version.
    # Only hashes in this release are updated; old installed apps retain previous pointers.
    source_hashes = sorted(set(manifest['sourceHashes'].values()))
    for source_hash in source_hashes:
        key = prefix + f'sources/{source_hash}/manifest.json'
        s3.put_object(Bucket=bucket, Key=key, Body=manifest_bytes,
                      ContentType='application/json; charset=utf-8', CacheControl='public, max-age=60, must-revalidate')
        pointer = s3.get_object(Bucket=bucket, Key=key)
        if pointer['Body'].read() != manifest_bytes:
            raise RuntimeError('Source compatibility pointer verification failed')
    # A failed upload never replaces the active release. Workflow concurrency serializes this pointer.
    s3.put_object(Bucket=bucket, Key=prefix + 'manifest.json', Body=manifest_bytes,
                  ContentType='application/json; charset=utf-8', CacheControl='public, max-age=60, must-revalidate')
    actual = s3.get_object(Bucket=bucket, Key=prefix + 'manifest.json')
    if actual['Body'].read() != manifest_bytes:
        raise RuntimeError('Release pointer verification failed')
    print(json.dumps({'environment': target, 'release': release, 'objects': len(objects), 'sourcePointersVerified': len(source_hashes), 'manifestVerified': True}))


if __name__ == '__main__':
    publish()
