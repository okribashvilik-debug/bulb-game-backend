/**
 * SFX layer for the main-event stage — a direct port of the design
 * prototype's sfx* methods (see design_handoff_main_event_area). One
 * dispatcher, `sfxFor(bulbIndex, newState, prevState)`, fires on every
 * visual-state transition — the exact same contract the stage visuals and
 * room lighting run on, so sound can never drift out of sync with what's
 * on screen. MainEventArea drives it from the derived StageBulb states.
 *
 * Sample-based cues (mp3s from the handoff, served from public/sfx/):
 *   charging    — looped while a bulb is in 'charging'; ~80ms fade on exit
 *   overcharge  — looped during the pre-pop flicker; same stop behavior
 *   popped      — one-shot pop
 * Synthesized cues (Web Audio oscillators, verbatim from the prototype):
 *   win         — ascending triangle arpeggio C5/E5/G5/C6 + 2093Hz shimmer
 *   idle        — power-down sweep (only when entered from a LIVE state;
 *                 a popped bulb going idle at cycle reset stays silent)
 *   click       — short UI tick for bulb selection
 *
 * Background music: one ambient track (public/sfx/background.mp3) loops
 * underneath everything for as long as the page is open — independent of
 * round/bulb state or mode. It starts on the same first-gesture unlock as
 * the rest of the audio, runs through its OWN dedicated gain node (so
 * ambience and SFX are volume-controlled independently), and loops via a
 * scheduled ~1.5s equal-crossfade between iterations so there's never an
 * audible seam or click at the loop point. The master enable toggle mutes
 * it together with the SFX; setMusicEnabled() additionally allows muting
 * just the music while keeping SFX (no UI wired to it yet — it exists so
 * adding that toggle later is one line).
 *
 * This module is deliberately separate from sound.ts (the older cue set —
 * cash-out, decision-window open/close — which stays in use for
 * non-stage UI moments). Both obey the same mute toggle: useBulbGame
 * forwards its `muted` state here via setEnabled().
 */

type SampleKey = 'charging' | 'overcharge' | 'pop';

const SAMPLE_URLS: Record<SampleKey, string> = {
  charging: '/sfx/charging.mp3',
  overcharge: '/sfx/overcharging.mp3',
  pop: '/sfx/pop.mp3',
};

const DEFAULT_VOLUME = 0.6;

const MUSIC_URL = '/sfx/background.mp3';
/** Ambience, not a featured sound — deliberately far below the SFX volume
 *  (0.6) so it never competes with charging/overcharge/pop/win cues.
 *  Tune by ear here; nothing else needs to change. */
const MUSIC_VOLUME = 0.18;
/** Overlap between the end of one loop iteration and the start of the
 *  next — long enough to hide any hard edit at the track boundaries. */
const MUSIC_CROSSFADE_S = 1.5;
/** How far ahead of the crossfade point the next iteration gets scheduled
 *  (in real time, via setTimeout). Generous so a briefly-throttled timer
 *  in a background tab still lands before the audio-clock deadline —
 *  and tabs that are audibly playing are exempt from heavy throttling. */
const MUSIC_SCHEDULE_LOOKAHEAD_S = 5;

export type SfxState = 'idle' | 'charging' | 'overcharge' | 'popped' | 'win';

class SfxManager {
  private ctx: AudioContext | null = null;
  private buffers: Partial<Record<SampleKey, AudioBuffer>> = {};
  private preloadStarted = false;
  /** bulb index -> the looping charge/overcharge nodes currently playing
   *  for that bulb (at most one loop per bulb, exactly like the
   *  prototype's _chargeNodes map). */
  private loopNodes = new Map<number, [AudioBufferSourceNode, GainNode]>();
  private enabled = true;
  private volume = DEFAULT_VOLUME;

  // Background music state — see startMusic()/scheduleMusicIteration().
  private musicBuffer: AudioBuffer | null = null;
  /** Dedicated gain node for the ambience layer, separate from every
   *  per-sample SFX gain, so the two are independently controllable. */
  private musicGain: GainNode | null = null;
  private musicSources: AudioBufferSourceNode[] = [];
  private musicTimer: ReturnType<typeof setTimeout> | undefined;
  private musicPlaying = false;
  /** True once the first user gesture has unlocked audio — from then on
   *  the music (re)starts itself whenever it's allowed to play. */
  private musicUnlocked = false;
  private musicEnabled = true;

  /** Create the (suspended) context and start fetching + decoding samples
   *  so first playback is instant. Safe to call more than once. */
  preload(): void {
    if (this.preloadStarted) return;
    this.preloadStarted = true;
    const ctx = this.getContext();
    for (const [key, url] of Object.entries(SAMPLE_URLS) as Array<[SampleKey, string]>) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => {
          this.buffers[key] = buf;
        })
        .catch(() => {
          // Missing/undecodable sample — the game plays fine silently.
        });
    }
    fetch(MUSIC_URL)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        this.musicBuffer = buf;
        // Decode may finish after the unlock gesture — start now if so.
        this.maybeStartMusic();
      })
      .catch(() => {
        // No background track — everything else still works.
      });
  }

  /** Browsers keep an AudioContext suspended until a user gesture — call
   *  this from the first pointer interaction (same pattern as sound.ts). */
  unlock(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    this.musicUnlocked = true;
    this.maybeStartMusic();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stopAllLoops();
      this.stopMusic(); // the master toggle always silences BOTH layers
    } else {
      this.maybeStartMusic();
    }
  }

  /** Independent music-only toggle (master setEnabled still wins). */
  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (!enabled) this.stopMusic();
    else this.maybeStartMusic();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  /** The one dispatcher: state string -> sound, same contract as the
   *  stage's visual()/roomLight() families. No-op when nothing changed. */
  sfxFor(bulbIndex: number, state: SfxState, prev: SfxState | undefined): void {
    if (state === prev) return;
    switch (state) {
      case 'idle':
        this.stopLoop(bulbIndex);
        // Power-down only from a live state — a popped bulb resetting to
        // idle for the next cycle shouldn't make N simultaneous thuds.
        if (prev && prev !== 'popped') this.playIdle();
        break;
      case 'charging':
        this.startLoop(bulbIndex, 'charging', 0.9);
        break;
      case 'overcharge':
        this.startLoop(bulbIndex, 'overcharge', 1);
        break;
      case 'popped':
        this.stopLoop(bulbIndex);
        this.playPop();
        break;
      case 'win':
        this.stopLoop(bulbIndex);
        this.playWin();
        break;
    }
  }

  /** Stop every running loop (component unmount / mute). */
  stopAllLoops(): void {
    for (const index of [...this.loopNodes.keys()]) this.stopLoop(index);
  }

  /** Stop the background track (mute / unmount) with a short fade so it
   *  never cuts off with a click. Restartable via maybeStartMusic(). */
  stopMusic(): void {
    if (!this.musicPlaying) return;
    this.musicPlaying = false;
    clearTimeout(this.musicTimer);
    this.musicTimer = undefined;
    const ctx = this.ctx;
    if (ctx && this.musicGain) {
      const t = ctx.currentTime;
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t);
      this.musicGain.gain.linearRampToValueAtTime(0, t + 0.2);
    }
    for (const src of this.musicSources) {
      try {
        src.stop(ctx ? ctx.currentTime + 0.25 : undefined);
      } catch {
        // already stopped — fine
      }
    }
    this.musicSources = [];
    this.musicGain = null;
  }

  // -----------------------------------------------------------------
  // Background music internals
  // -----------------------------------------------------------------

  /** Starts the ambience loop iff everything lines up: buffer decoded,
   *  audio unlocked by a gesture, both toggles on, not already playing.
   *  Called from every place one of those conditions flips true. */
  private maybeStartMusic(): void {
    if (this.musicPlaying) return;
    if (!this.enabled || !this.musicEnabled || !this.musicUnlocked || !this.musicBuffer) return;
    const ctx = this.getRunningContext();

    this.musicPlaying = true;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = MUSIC_VOLUME;
    this.musicGain.connect(ctx.destination);
    this.scheduleMusicIteration(ctx.currentTime + 0.05);
  }

  /**
   * Plays one pass of the track starting at `startAt` (audio-clock time)
   * and pre-schedules the next pass to begin MUSIC_CROSSFADE_S before this
   * one ends, with matching fade-out/fade-in ramps — a seamless crossfade
   * loop that doesn't rely on the file's own edit points being clean.
   * Scheduling for iteration N+1 happens well ahead of the deadline (see
   * MUSIC_SCHEDULE_LOOKAHEAD_S) on the sample-accurate audio clock, so a
   * lazy setTimeout can't cause an audible gap.
   */
  private scheduleMusicIteration(startAt: number): void {
    const ctx = this.ctx;
    const buffer = this.musicBuffer;
    const musicGain = this.musicGain;
    if (!ctx || !buffer || !musicGain || !this.musicPlaying) return;

    const duration = buffer.duration;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Per-iteration envelope: fade in over the crossfade window, hold,
    // fade out over the last crossfade window. The master musicGain on
    // top stays at MUSIC_VOLUME (and is what mute/stop ramps down).
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, startAt);
    envelope.gain.linearRampToValueAtTime(1, startAt + MUSIC_CROSSFADE_S);
    envelope.gain.setValueAtTime(1, startAt + duration - MUSIC_CROSSFADE_S);
    envelope.gain.linearRampToValueAtTime(0, startAt + duration);
    src.connect(envelope).connect(musicGain);
    src.start(startAt);
    src.stop(startAt + duration + 0.1);

    this.musicSources.push(src);
    src.onended = () => {
      this.musicSources = this.musicSources.filter((s) => s !== src);
    };

    // Next iteration begins where this one's fade-out begins.
    const nextStartAt = startAt + duration - MUSIC_CROSSFADE_S;
    const delayMs = Math.max(
      0,
      (nextStartAt - ctx.currentTime - MUSIC_SCHEDULE_LOOKAHEAD_S) * 1000,
    );
    clearTimeout(this.musicTimer);
    this.musicTimer = setTimeout(() => this.scheduleMusicIteration(nextStartAt), delayMs);
  }

  /** Short UI tick for selecting a bulb (triangle 1800→700Hz over 40ms). */
  playClick(): void {
    if (!this.enabled) return;
    const ctx = this.getRunningContext();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + 0.04);
    gain.gain.setValueAtTime(0.25 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  // -----------------------------------------------------------------
  // Internals — each cue verbatim from the prototype's sfx* methods
  // -----------------------------------------------------------------

  private getContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private getRunningContext(): AudioContext {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  private playSample(key: SampleKey, options: { loop?: boolean; gain?: number } = {}):
    | [AudioBufferSourceNode, GainNode]
    | null {
    if (!this.enabled) return null;
    const buffer = this.buffers[key];
    if (!buffer) return null; // not decoded yet — skip silently
    const ctx = this.getRunningContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = options.loop ?? false;
    const gain = ctx.createGain();
    gain.gain.value = (options.gain ?? 1) * this.volume;
    src.connect(gain).connect(ctx.destination);
    src.start(ctx.currentTime);
    return [src, gain];
  }

  private startLoop(bulbIndex: number, key: Exclude<SampleKey, 'pop'>, gain: number): void {
    this.stopLoop(bulbIndex);
    const nodes = this.playSample(key, { loop: true, gain });
    if (nodes) this.loopNodes.set(bulbIndex, nodes);
  }

  /** ~80ms gain fade, then stop — no hard cut-off click. */
  private stopLoop(bulbIndex: number): void {
    const nodes = this.loopNodes.get(bulbIndex);
    if (!nodes) return;
    this.loopNodes.delete(bulbIndex);
    const ctx = this.ctx;
    if (!ctx) return;
    const [src, gain] = nodes;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    try {
      src.stop(t + 0.1);
    } catch {
      // already stopped — fine
    }
  }

  private playPop(): void {
    this.playSample('pop', { gain: 1 });
  }

  /** Celebratory ascending gold arpeggio + shimmer. */
  private playWin(): void {
    if (!this.enabled) return;
    const ctx = this.getRunningContext();
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, k) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const start = t + k * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22 * this.volume, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + (k === 3 ? 0.9 : 0.3));
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1);
    });
    const shimmer = ctx.createOscillator();
    const shimmerGain = ctx.createGain();
    shimmer.type = 'sine';
    shimmer.frequency.value = 2093;
    shimmerGain.gain.setValueAtTime(0.0001, t + 0.3);
    shimmerGain.gain.exponentialRampToValueAtTime(0.08 * this.volume, t + 0.4);
    shimmerGain.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    shimmer.connect(shimmerGain).connect(ctx.destination);
    shimmer.start(t + 0.3);
    shimmer.stop(t + 1.5);
  }

  /** Soft low "power down" sweep when a bulb returns to idle from a live
   *  state (sine 320→90Hz over 0.25s). */
  private playIdle(): void {
    if (!this.enabled) return;
    const ctx = this.getRunningContext();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.25);
    gain.gain.setValueAtTime(0.18 * this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  }
}

export const sfxManager = new SfxManager();
