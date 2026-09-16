#!/usr/bin/env python3
"""Regenerate Flutter typed UI source and registry. No network or paid calls."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'app/lib/core/localization'

def dart_string(value):
    return json.dumps(value, ensure_ascii=False).replace('$', '\\$')

messages = json.loads((ROOT / 'shared/i18n/source/app.json').read_text())
if not messages or not all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) and isinstance(v, str)
                           for k, v in messages.items()):
    raise ValueError('App source needs Dart-compatible stable keys and string messages')
messages = dict(sorted(messages.items()))
canonical = json.dumps(messages, ensure_ascii=False, separators=(',', ':'))
source_hash = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
(OUT / 'ui_messages.dart').write_text(
    '// Generated from shared/i18n/source/app.json; preserve typed IDs when updating.\n'
    + 'const uiSourceHash = ' + dart_string(source_hash) + ';\nenum UiMessage {\n'
    + ''.join('  ' + k + ',\n' for k in messages) + '}\n'
    + 'const uiSourceMessages = <String, String>{\n'
    + ''.join('  ' + dart_string(k) + ': ' + dart_string(v) + ',\n' for k, v in messages.items())
    + '};\n')

registry = json.loads((ROOT / 'shared/i18n/locales.json').read_text())
registry_file = OUT / 'ui_locales.dart'
text = registry_file.read_text()
start = text.index('const uiLocales = <UiLocale>[')
end = text.index('\n];', start) + len('\n];')
rows = []
for locale in registry:
    rows.append('  UiLocale(' + ', '.join(dart_string(locale[k])
                for k in ('code', 'nativeName', 'script'))
                + (', true' if locale['dir'] == 'rtl' else '') + '),')
registry_file.write_text(text[:start] + 'const uiLocales = <UiLocale>[\n'
                        + '\n'.join(rows) + '\n];' + text[end:])
print(f'Generated {len(messages)} app messages; sourceHash={source_hash}')
