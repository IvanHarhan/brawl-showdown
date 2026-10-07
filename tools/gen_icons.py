"""Иконки PWA: python tools/gen_icons.py"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'icons')
os.makedirs(OUT, exist_ok=True)

for size in (192, 512):
    s = size / 512
    im = Image.new('RGB', (size, size), '#1b1440')
    d = ImageDraw.Draw(im)
    # череп-бейдж в духе шоудауна: жёлтый круг с обводкой и «банка»
    d.ellipse([60 * s, 60 * s, 452 * s, 452 * s], fill='#ffd23f', outline='#120c2a', width=int(18 * s))
    d.rounded_rectangle([196 * s, 150 * s, 316 * s, 370 * s], radius=int(26 * s), fill='#36e07a', outline='#120c2a', width=int(14 * s))
    d.rectangle([196 * s, 230 * s, 316 * s, 270 * s], fill='#120c2a')
    d.rounded_rectangle([212 * s, 128 * s, 300 * s, 160 * s], radius=int(8 * s), fill='#d8d8d8', outline='#120c2a', width=int(10 * s))
    im.save(os.path.join(OUT, f'icon-{size}.png'))
print('ok')
