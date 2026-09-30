#!/usr/bin/env python3
"""One-time title migration. Rebuild packages before running --check."""
from pathlib import Path
import base64
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path.cwd()
OLD = re.compile(r'charon', re.I)
SELF = {'scripts/rename-game.py', '.github/workflows/rename-game.yml'}
SKIP_DIRS = {'.git', 'node_modules', '.wrangler', '.github', 'dist'}


def replacement(match):
    token = match.group(0)
    if token == 'Charon':
        return 'Saturn Devouring'
    if token == 'CHARON':
        return 'SATURN DEVOURING'
    if token == 'charon':
        return 'saturn-devouring'
    # Keep identifiers valid; protocol and file slugs are handled separately.
    def part(m):
        value = m.group(0)
        return ('SATURN_DEVOURING' if value.isupper() else
                'SaturnDevouring' if value[0].isupper() else 'saturnDevouring')
    return OLD.sub(part, token)


def rewrite(text):
    # This is the vessel's design/class, not its proper name. Do not invent a
    # new canonical class by calling it a "Saturn Devouring-class" frigate.
    text = re.sub(r'Charon-class(?:\s+light)?\s+frigate', 'light frigate', text, flags=re.I)
    text = re.sub(r'Charon-class', 'reference frigate', text, flags=re.I)
    text = re.sub(r'[A-Za-z_$][A-Za-z0-9_$]*', replacement_if_needed, text)
    text = text.replace('Halo Saturn Devouring', 'Saturn Devouring')
    text = text.replace('HALO SATURN DEVOURING', 'SATURN DEVOURING')
    text = text.replace('halo-saturn-devouring-poc', 'saturn-devouring')
    return text


def replacement_if_needed(match):
    return replacement(match) if OLD.search(match.group(0)) else match.group(0)


def tracked():
    return [p for p in subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0') if p]


def text_of(path):
    data = path.read_bytes()
    if b'\0' in data:
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


def audit_tree(root):
    bad = []
    for path in root.rglob('*'):
        rel = path.relative_to(root)
        if not path.is_file() or any(p in SKIP_DIRS for p in rel.parts):
            continue
        if str(rel) in SELF:
            continue
        if OLD.search(str(rel)):
            bad.append(str(rel) + ' (filename)')
        if path.suffix == '.peerd':
            continue
        text = text_of(path)
        if text is not None and OLD.search(text):
            bad.append(str(rel))
    if bad:
        raise RuntimeError('Old title remains: ' + ', '.join(bad))


def audit_package(path):
    envelope = json.loads(path.read_text())
    manifest = envelope['manifest']
    chunks = [base64.b64decode(c, validate=True) for c in envelope['chunks']]
    assert len(chunks) == len(manifest['chunks'])
    for chunk, entry in zip(chunks, manifest['chunks']):
        assert len(chunk) == entry['size']
        assert hashlib.sha256(chunk).hexdigest() == entry['hash']
    payload = b''.join(chunks)
    assert len(payload) == manifest['size']
    assert manifest['meta']['name'] == 'Saturn Devouring'
    content = json.loads(payload)
    for name, value in content['files'].items():
        assert not OLD.search(name), name
        if content['fileKinds'][name] == 'text':
            assert not OLD.search(base64.b64decode(value).decode('utf-8')), name
    print('Packaged app: correct title, valid chunk hashes, no old branding in decoded text')


if '--check' in sys.argv:
    audit_tree(ROOT)
    audit_tree(ROOT / 'dist/site')
    audit_package(ROOT / 'dwapp/saturn-devouring-app.peerd')
    for name in ['index.html', 'game/index.html', 'dwapp/hub/index.html']:
        text = (ROOT / name).read_text()
        assert 'Saturn Devouring' in text or 'SATURN DEVOURING' in text, name
    assert '<strong>SATURN DEVOURING</strong>' in (ROOT / 'game/index.html').read_text()
    assert 'UNSC SATURN DEVOURING' in (ROOT / 'game/index.html').read_text()
    assert 'Saturn Devouring-class' not in (ROOT / 'game/index.html').read_text()
    print('Brand audit passed for source, filenames, built website, and packaged app')
    sys.exit(0)

changed = []
for name in tracked():
    if name in SELF:
        continue
    path = ROOT / name
    if not path.is_file():
        continue
    if path.suffix != '.peerd':
        text = text_of(path)
        if text is not None:
            updated = rewrite(text)
            if updated != text:
                path.write_bytes(updated.encode('utf-8'))
                changed.append(name)
    new_name = OLD.sub('saturn-devouring', name)
    if new_name != name:
        destination = ROOT / new_name
        assert not destination.exists(), new_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        path.rename(destination)
        changed.append(name + ' -> ' + new_name)

# Let the longer brand wrap on narrow devices, without changing the visual design.
css = ROOT / 'game/launcher.css'
with css.open('a') as stream:
    stream.write('''\n/* Keep the full game title legible on narrow screens. */\n.hub-brand { min-width: 0; }\n.hub-mark { flex-shrink: 0; }\n.hub-brand strong { line-height: 1.35; }\n@media (max-width: 760px) {\n  .hub-top { flex-wrap: wrap; }\n  .hub-nav { flex-wrap: wrap; }\n}\n''')

# Keep transient build/CI tooling out of the deployed static directory.
site = ROOT / 'scripts/build-site.mjs'
text = site.read_text()
assert "'.git', '.claude'" in text
site.write_text(text.replace("'.git', '.claude'", "'.git', '.github', '.claude'"))
print('Renamed', len(changed), 'tracked file contents/paths:')
print('\n'.join(changed))
