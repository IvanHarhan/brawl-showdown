// Звук: фразы бойцов (assets/voice) + синтезированные эффекты на WebAudio.
// iOS: AudioContext запускается только по первому тапу — unlock().

type Cat = 'attack' | 'super' | 'death' | 'win';

export class Audio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private manifest: Record<string, Record<Cat, string[]>> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private lastVoice = 0;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
      const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
      const d = n.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = n;
      fetch('/voice/manifest.json').then((r) => r.json()).then((m) => { this.manifest = m; }).catch(() => {});
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // пустой звук — окончательно будит iOS
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b; s.connect(this.master); s.start(0);
  }

  private load(path: string) {
    let p = this.buffers.get(path);
    if (!p) {
      const decode = async (url: string) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(url);
        return await this.ctx!.decodeAudioData(await r.arrayBuffer());
      };
      // .ogg не декодируется в старом Safari — тогда берём .m4a с тем же именем
      p = decode(`/voice/${path}.ogg`).catch(() => decode(`/voice/${path}.m4a`)).catch(() => null);
      this.buffers.set(path, p);
    }
    return p;
  }

  preloadVoice(brawler: string) {
    if (!this.ctx || !this.manifest?.[brawler]) return;
    for (const list of Object.values(this.manifest[brawler])) for (const f of list) this.load(`${brawler}/${f}`);
  }

  /** Фраза бойца. force — не учитывать паузу между фразами. */
  async voice(brawler: string, cat: Cat, volume = 1, force = false) {
    if (!this.ctx || this.muted) return;
    const now = performance.now();
    if (!force && now - this.lastVoice < 2500) return;
    const list = this.manifest?.[brawler]?.[cat];
    if (!list?.length) return;
    this.lastVoice = now;
    const buf = await this.load(`${brawler}/${list[Math.floor(Math.random() * list.length)]}`);
    if (!buf) return;
    const s = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = volume;
    s.buffer = buf;
    s.connect(g).connect(this.master);
    s.start();
  }

  // ---------- синтез ----------

  private env(dur: number, vol: number, attack = 0.005) {
    const c = this.ctx!;
    const g = c.createGain();
    const t = c.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.master);
    return g;
  }

  private noiseHit(dur: number, vol: number, freq: number, q = 1, type: BiquadFilterType = 'bandpass') {
    const c = this.ctx!;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f).connect(this.env(dur, vol));
    s.start(); s.stop(c.currentTime + dur);
  }

  private tone(f0: number, f1: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0) {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    const t = c.currentTime + delay;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  sfx(name: 'shot' | 'shotgun' | 'throw' | 'punch' | 'hit' | 'hitme' | 'box' | 'boxbreak' | 'can' | 'gas' | 'super' | 'boom' | 'win' | 'lose' | 'click' | 'death', volume = 1) {
    if (!this.ctx || this.muted || volume <= 0.02) return;
    const v = volume;
    switch (name) {
      case 'shot': this.noiseHit(0.09, 0.35 * v, 2200, 0.8); this.tone(900, 180, 0.08, 0.12 * v, 'square'); break;
      case 'shotgun': this.noiseHit(0.22, 0.6 * v, 900, 0.6); this.tone(160, 50, 0.2, 0.35 * v, 'sawtooth'); break;
      case 'throw': this.noiseHit(0.18, 0.25 * v, 600, 2, 'lowpass'); this.tone(500, 900, 0.12, 0.08 * v, 'triangle'); break;
      case 'punch': this.tone(180, 60, 0.12, 0.45 * v, 'sine'); this.noiseHit(0.06, 0.3 * v, 1200, 1); break;
      case 'hit': this.tone(1400, 900, 0.05, 0.12 * v, 'square'); break;
      case 'hitme': this.tone(300, 120, 0.15, 0.3 * v, 'sawtooth'); break;
      case 'box': this.noiseHit(0.08, 0.35 * v, 500, 3); this.tone(220, 160, 0.07, 0.15 * v, 'triangle'); break;
      case 'boxbreak': this.noiseHit(0.35, 0.6 * v, 400, 0.7); this.tone(140, 60, 0.3, 0.3 * v, 'triangle'); break;
      case 'can': [660, 880, 1320].forEach((f, i) => this.tone(f, f * 1.02, 0.12, 0.18 * v, 'triangle', i * 0.06)); break;
      case 'gas': this.noiseHit(0.4, 0.15 * v, 300, 0.5, 'lowpass'); break;
      case 'super': this.tone(200, 1200, 0.35, 0.25 * v, 'sawtooth'); this.noiseHit(0.3, 0.2 * v, 3000, 0.5); break;
      case 'boom': this.noiseHit(0.5, 0.7 * v, 250, 0.5, 'lowpass'); this.tone(120, 35, 0.45, 0.5 * v); break;
      case 'death': this.tone(500, 80, 0.5, 0.25 * v, 'triangle'); break;
      case 'click': this.tone(800, 600, 0.04, 0.12 * v, 'square'); break;
      case 'win': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, f, 0.22, 0.22 * v, 'triangle', i * 0.12)); break;
      case 'lose': [440, 392, 330, 262].forEach((f, i) => this.tone(f, f * 0.98, 0.3, 0.2 * v, 'triangle', i * 0.18)); break;
    }
  }
}
