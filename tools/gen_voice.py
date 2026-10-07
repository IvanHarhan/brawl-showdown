"""Озвучка бойцов через Silero TTS (локально, русский).

python tools/gen_voice.py            — сгенерировать всё
python tools/gen_voice.py --convert  — только пересобрать .m4a и manifest из уже лежащих .ogg
                                       (после замены фраз своими записями)

Пишет assets/voice/<id>/<категория><N>.ogg и .m4a, плюс assets/voice/manifest.json.
"""
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOICE = os.path.join(ROOT, 'assets', 'voice')
CATS = ('attack', 'super', 'death', 'win')
SR = 48000


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *args], check=True)


def save_wav(path, audio):
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def to_m4a(ogg):
    ffmpeg('-i', ogg, '-c:a', 'aac', '-b:a', '64k', ogg[:-4] + '.m4a')


def manifest():
    data = {}
    for bid in sorted(os.listdir(VOICE)):
        d = os.path.join(VOICE, bid)
        if not os.path.isdir(d):
            continue
        files = sorted(f[:-4] for f in os.listdir(d) if f.endswith('.ogg'))
        data[bid] = {c: [f for f in files if f.startswith(c)] for c in CATS}
    with open(os.path.join(VOICE, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('manifest:', {k: sum(len(v) for v in d.values()) for k, d in data.items()})


def generate():
    import torch
    with open(os.path.join(ROOT, 'tools', 'voice_lines.json'), encoding='utf-8') as f:
        lines = json.load(f)
    model, _ = torch.hub.load('snakers4/silero-models', 'silero_tts', language='ru', speaker='v4_ru', trust_repo=True)
    tmp = tempfile.mkdtemp()
    for bid, spec in lines.items():
        if bid.startswith('_'):
            continue
        out = os.path.join(VOICE, bid)
        os.makedirs(out, exist_ok=True)
        for cat in CATS:
            for i, text in enumerate(spec.get(cat, []), 1):
                audio = model.apply_tts(text=text, speaker=spec['speaker'], sample_rate=SR, put_accent=True, put_yo=True).numpy()
                audio = audio / max(1e-3, np.abs(audio).max()) * 0.9
                wav = os.path.join(tmp, f'{bid}_{cat}{i}.wav')
                save_wav(wav, audio)
                p = spec.get('pitch', 1.0)
                # смена тембра: высота через asetrate, темп возвращаем atempo
                af = f'asetrate={int(SR * p)},aresample={SR},atempo={1 / p:.4f},highpass=f=80,acompressor=threshold=-18dB:ratio=3'
                ogg = os.path.join(out, f'{cat}{i}.ogg')
                ffmpeg('-i', wav, '-af', af, '-c:a', 'libvorbis', '-q:a', '4', ogg)
                to_m4a(ogg)
                print(bid, cat, i, text)


if __name__ == '__main__':
    if '--convert' in sys.argv:
        for bid in os.listdir(VOICE):
            d = os.path.join(VOICE, bid)
            if os.path.isdir(d):
                for f in os.listdir(d):
                    if f.endswith('.ogg'):
                        to_m4a(os.path.join(d, f))
    else:
        generate()
    manifest()
