/**
 * SFX layer for the main-event stage — a direct port of the design
 * prototype's sfx* methods (see design_handoff_main_event_area). One
 * dispatcher, `sfxFor(bulbIndex, newState, prevState)`, fires on every
 * visual-state transition — the exact same contract the stage visuals and
 * room lighting run on, so sound can never drift out of sync with what's
 * on screen. MainEventArea drives it from the derived StageBulb states.
 *
 * Sample-based cues (mp3s from the handoff, served from public/sfx/):
 *   charging    — looped while any bulb is charging
 *   overcharge  — looped during a pre-pop flicker
 *   popped      — one-shot pop
 * The charging/overcharge loops share ONE exclusive stage channel (see
 * setStagePhase): at any moment at most one of charging / overcharge /
 * pop is audible. Every phase change is a strict sequential handoff — the
 * old loop is faded out over ~80ms first, and the next sound starts only
 * after that fade has finished, rather than sounds running out on their
 * own natural duration and bleeding into each other. A pop additionally
 * holds the channel quiet until the one-shot has finished, so charging
 * for the next round can't ride over the pop's tail.
 *
 * Synthesized cues (Web Audio oscillators, verbatim from the prototype):
 *   win         — ascending triangle arpeggio C5/E5/G5/C6 + 2093Hz shimmer
 *   idle        — power-down sweep (only when entered from a LIVE state;
 *                 a popped bulb going idle at cycle reset stays silent)
 *   click       — short UI tick for bulb selection
 *
 * Background music: one ambient track (public/sfx/background.mp3) that is
 * tied to SESSION boundaries — startMusicSession() restarts it from its
 * very first note the moment a new cycle's betting opens, stopMusic()
 * silences it when the cycle completes or cancels. The buffer is fetched
 * and fully decoded up front (preload(), on mount) so the session-start
 * playback is instant, never late or clipped. It runs through its OWN
 * dedicated gain node (independent of every SFX gain) and, should a
 * session outlast the track, loops via a scheduled ~1.5s crossfade so
 * there's never an audible seam. The master enable toggle mutes it
 * together with the SFX; setMusicEnabled() additionally allows muting
 * just the music while keeping SFX (no UI wired to it yet).
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

/** Master SFX level — deliberately soft so the cues sit under the
 *  background ambience instead of competing with it. Tune by ear here. */
const DEFAULT_VOLUME = 0.38;

/** Fade-out applied to a loop on every phase handoff (and the delay before
 *  the next phase's sound starts) — long enough to avoid a hard click,
 *  short enough to read as instantaneous. */
const HANDOFF_FADE_S = 0.08;
const HANDOFF_GAP_MS = 90;

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

/** The one-at-a-time stage channel's phase — an AGGREGATE of the whole
 *  stage, not per-bulb: 'overcharge' if any bulb is overcharging,
 *  'charging' if any bulb is charging, else 'quiet'. */
export type StagePhase = 'quiet' | 'charging' | 'overcharge';

class SfxManager {
  private ctx: AudioContext | null = null;
  private buffers: Partial<Record<SampleKey, AudioBuffer>> = {};
  private preloadStarted = false;
  private enabled = true;
  private volume = DEFAULT_VOLUME;

  // The exclusive stage channel — at most ONE charging/overcharge loop
  // exists at a time, globally (see setStagePhase).
  private channel: [AudioBufferSourceNode, GainNode] | null = null;
  private channelPhase: StagePhase = 'quiet';
  private desiredPhase: StagePhase = 'quiet';
  private phaseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Audio-clock time before which NO loop may start: pushed forward by
   *  every handoff fade (so the next loop can't begin until the previous
   *  one has fully faded — even if applyStagePhase is re-entered by a
   *  re-render inside the gap) and by playPop() (so nothing loops over
   *  the pop one-shot's tail). */
  private channelBlockedUntil = 0;

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
  /** True between startMusicSession() (a cycle's betting opened) and
   *  stopMusic() (the cycle completed/cancelled). */
  private musicSessionActive = false;

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
      const phase = this.desiredPhase; // stopAllLoops clears it — remember for re-enable
      this.stopAllLoops();
      this.desiredPhase = phase;
      this.stopMusicPlayback(); // the master toggle always silences BOTH layers
    } else {
      this.applyStagePhase();
      this.maybeStartMusic();
    }
  }

  /** Independent music-only toggle (master setEnabled still wins). */
  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (!enabled) this.stopMusicPlayback();
    else this.maybeStartMusic();
  }

  /** A new game cycle just opened for betting: (re)start the background
   *  track from its very first note. The buffer was decoded at preload
   *  time, so this is sample-accurate and instant — nothing is fetched or
   *  decoded on this hot path. Until the first user gesture unlocks audio,
   *  this only marks the session active; unlock() then starts playback. */
  startMusicSession(): void {
    this.musicSessionActive = true;
    this.stopMusicPlayback(); // restart from the top, never resume mid-track
    this.maybeStartMusic();
  }

  /** The cycle ended (complete or cancelled): stop the track until the
   *  next session starts. */
  stopMusic(): void {
    this.musicSessionActive = false;
    this.stopMusicPlayback();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Drive the exclusive stage channel. Callers pass the aggregate phase of
   * the whole stage on every change; this applies it as a strict
   * sequential handoff — fade the current loop out (~80ms), wait for that
   * fade, only then start the next loop — so charging can never bleed
   * into overcharge, nor overcharge into whatever follows. Re-asserting
   * the current phase is a no-op (a second bulb starting to charge does
   * NOT stack a second loop).
   */
  setStagePhase(phase: StagePhase): void {
    this.desiredPhase = phase;
    this.applyStagePhase();
  }

  /** One-shot pop. Fades the stage channel out first (overcharge must be
   *  fully stopped before the pop lands), then keeps the channel quiet
   *  for the pop's duration so the next round's charging can't ride over
   *  its tail. */
  playPop(): void {
    if (!this.enabled) return;
    const ctx = this.getRunningContext();
    const hadChannel = this.channel !== null;
    this.stopChannel(); // blocks the channel past its own fade

    const startDelayS = hadChannel ? HANDOFF_GAP_MS / 1000 : 0;
    const popDuration = this.buffers.pop?.duration ?? 1.2;
    // Extend the block to cover the pop's whole tail: the next round's
    // charging loop may only start once the pop has finished.
    this.channelBlockedUntil = Math.max(
      this.channelBlockedUntil,
      ctx.currentTime + startDelayS + popDuration,
    );

    if (hadChannel) {
      setTimeout(() => this.playSample('pop', { gain: 1 }), HANDOFF_GAP_MS);
    } else {
      this.playSample('pop', { gain: 1 });
    }
    // Re-evaluate the loop channel once the block expires (applyStagePhase
    // schedules itself past channelBlockedUntil).
    this.applyStagePhase();
  }

  /** Stop the stage channel and drop the desired phase (unmount / mute). */
  stopAllLoops(): void {
    this.desiredPhase = 'quiet';
    clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
    this.stopChannel();
  }

  /** Silence the background track with a short fade so it never cuts off
   *  with a click. Does NOT clear the session flag — mute/unmute inside a
   *  running session restarts the track (see maybeStartMusic()). */
  private stopMusicPlayback(): void {
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

  /** Starts the track from the top iff everything lines up: a session is
   *  active, buffer decoded, audio unlocked by a gesture, both toggles
   *  on, not already playing. Called from every place one of those
   *  conditions flips true, so whichever happens LAST starts playback. */
  private maybeStartMusic(): void {
    if (this.musicPlaying) return;
    if (!this.enabled || !this.musicEnabled || !this.musicSessionActive) return;
    if (!this.musicUnlocked || !this.musicBuffer) return;
    const ctx = this.getRunningContext();

    this.musicPlaying = true;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = MUSIC_VOLUME;
    this.musicGain.connect(ctx.destination);
    this.scheduleMusicIteration(ctx.currentTime + 0.02, true);
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
  private scheduleMusicIteration(startAt: number, isFirst = false): void {
    const ctx = this.ctx;
    const buffer = this.musicBuffer;
    const musicGain = this.musicGain;
    if (!ctx || !buffer || !musicGain || !this.musicPlaying) return;

    const duration = buffer.duration;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Per-iteration envelope: fade in over the crossfade window (except
    // the very first pass — the session start must land on the track's
    // first note at full level, not eased in), hold, fade out over the
    // last crossfade window. The master musicGain on top stays at
    // MUSIC_VOLUME (and is what mute/stop ramps down).
    const envelope = ctx.createGain();
    if (isFirst) {
      envelope.gain.setValueAtTime(1, startAt);
    } else {
      envelope.gain.setValueAtTime(0, startAt);
      envelope.gain.linearRampToValueAtTime(1, startAt + MUSIC_CROSSFADE_S);
    }
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

  /**
   * The stage-channel state machine's single step. Runs whenever the
   * desired phase, the enable state, or the pop hold could have changed;
   * reschedules itself when it has to wait (for a handoff fade or for a
   * pop one-shot to finish) so the desired phase is always eventually
   * applied — and applied ALONE.
   */
  private applyStagePhase(): void {
    clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
    if (!this.enabled) return;
    if (this.desiredPhase === this.channelPhase) return;

    // Strict sequential handoff: fade the current loop first (this pushes
    // channelBlockedUntil past the fade), then fall through to the block
    // check below, which schedules the actual start.
    if (this.channel) {
      this.stopChannel();
    }

    // The channel is blocked — a handoff fade is still ringing out, or a
    // pop one-shot owns the stage. Wait it out on the AUDIO clock: this is
    // what makes re-entry harmless — a re-render calling in again just
    // re-derives the same deadline instead of skipping the gap.
    const ctx = this.ctx;
    if (ctx && ctx.currentTime < this.channelBlockedUntil) {
      const waitMs = (this.channelBlockedUntil - ctx.currentTime) * 1000 + 20;
      this.phaseTimer = setTimeout(() => this.applyStagePhase(), waitMs);
      return;
    }

    if (this.desiredPhase === 'quiet') {
      this.channelPhase = 'quiet';
      return;
    }
    const nodes = this.playSample(this.desiredPhase, {
      loop: true,
      gain: this.desiredPhase === 'charging' ? 0.9 : 1,
    });
    if (nodes) this.channel = nodes;
    // Buffer may not be decoded yet on a very early round — treat the
    // phase as applied either way rather than busy-retrying; the next
    // phase change re-evaluates.
    this.channelPhase = this.desiredPhase;
  }

  /** ~80ms gain fade, then stop — no hard cut-off click. Blocks the
   *  channel until the fade has fully finished, so whatever starts next
   *  can never overlap the tail. */
  private stopChannel(): void {
    const nodes = this.channel;
    this.channel = null;
    this.channelPhase = 'quiet';
    if (!nodes) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const [src, gain] = nodes;
    const t = ctx.currentTime;
    this.channelBlockedUntil = Math.max(this.channelBlockedUntil, t + HANDOFF_GAP_MS / 1000);
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + HANDOFF_FADE_S);
    try {
      src.stop(t + HANDOFF_FADE_S + 0.02);
    } catch {
      // already stopped — fine
    }
  }

  /** Celebratory ascending gold arpeggio + shimmer. */
  playWin(): void {
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
  playIdle(): void {
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
