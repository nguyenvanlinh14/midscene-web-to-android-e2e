"""Gemini TTS for the demo narration.

usage: python3 scripts/tts.py <narration.json> <out-dir> [voice]
Fills "audio" and "dur" for every step. The key is read from MIDSCENE_MODEL_API_KEY in .env and never printed.
"""
import base64, json, os, re, sys, urllib.error, urllib.request, wave

MODEL = 'gemini-3.8-flash-tts'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def api_key():
    for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        m = re.match(r'\s*MIDSCENE_MODEL_API_KEY\s*=\s*["\']?([^"\'\s]+)', line)
        if m:
            return m.group(1)
    raise SystemExit('MIDSCENE_MODEL_API_KEY not found in .env')


def synth(text, voice, out):
    body = {'contents': [{'parts': [{'text': text}]}],
            'generationConfig': {'responseModalities': ['AUDIO'],
                                 'speechConfig': {'voiceConfig': {'prebuiltVoiceConfig': {'voiceName': voice}}}}}
    req = urllib.request.Request(
        f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent',
        data=json.dumps(body).encode(), headers={'x-goog-api-key': api_key(), 'content-type': 'application/json'})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        raise SystemExit(f'TTS HTTP {e.code}: {e.read().decode()[:300]}')
    part = next((p for c in d.get('candidates', []) for p in c.get('content', {}).get('parts', []) if 'inlineData' in p), None)
    if not part:
        raise SystemExit('TTS returned no audio: ' + json.dumps(d)[:300])
    mime = part['inlineData'].get('mimeType', '')
    rate = int((re.search(r'rate=(\d+)', mime) or [None, '24000'])[1])
    data = base64.b64decode(part['inlineData']['data'])
    if data[:4] == b'RIFF':
        open(out, 'wb').write(data)
    else:  # raw 16-bit mono PCM
        with wave.open(out, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(data)
    with wave.open(out, 'rb') as w:
        return w.getnframes() / w.getframerate()


if __name__ == '__main__':
    path, outdir = sys.argv[1:3]
    voice = sys.argv[3] if len(sys.argv) > 3 else 'leda'
    os.makedirs(outdir, exist_ok=True)
    steps = json.load(open(path))
    for s in steps:
        out = os.path.join(outdir, f"{s['id']}.wav")
        s['audio'] = os.path.relpath(out)  # relative: no local paths in the repo
        s['dur'] = round(synth(s['text'], voice, out), 2)
        print(f"{s['id']}: {s['dur']}s")
    json.dump(steps, open(path, 'w'), ensure_ascii=False, indent=1)
    print('total narration', round(sum(s['dur'] for s in steps), 1), 's')
