/**
 * Tiny synthesized sound engine — no audio assets, everything is a few
 * oscillator/gain nodes shaped into short tones. Keeps the app fully
 * self-contained and keeps the *intent* of each cue explicit in code
 * (frequency/duration/envelope) rather than buried in an opaque mp3.
 *
 * Cue taxonomy is deliberately kept small and distinct per event type:
 *   - decisionOpen / decisionClose: the cash-out/continue window itself
 *   - cashOut: a separate "locked in" confirm, layered on top of decisionClose
 *   - popNeutral: any bulb popping that isn't the human's own bet
 *   - popLoss: muted/deliberately anticlimactic — the human's bulb popped
 *   - nearMiss: reserved, only for a statistically-close survival
 *   - win: energetic — the human's bulb was the sole survivor
 */

type ToneShape = 'sine' | 'triangle' | 'square' | 'sawtooth';

interface ToneSpec {
  freq: number;
  /** Frequency to glide to by the end of the tone, if different from freq. */
  toFreq?: number;
  startAt: number;
  duration: number;
  peakGain: number;
  shape?: ToneShape;
}

class SoundManager {
  private ctx: AudioContext | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Must be called from within a user-gesture handler the first time —
   *  browsers block audio contexts from starting themselves. Safe to call
   *  repeatedly; a no-op once already running. */
  unlock(): void {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  private playTones(tones: ToneSpec[]): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone.shape ?? 'sine';
      const t0 = now + tone.startAt;
      const t1 = t0 + tone.duration;

      osc.frequency.setValueAtTime(tone.freq, t0);
      if (tone.toFreq !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, tone.toFreq), t1);
      }

      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(tone.peakGain, t0 + Math.min(0.02, tone.duration / 4));
      gain.gain.exponentialRampToValueAtTime(0.001, t1);

      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
  }

  /** Soft rising two-note blip — a decision window just opened. */
  playDecisionOpen(): void {
    this.playTones([
      { freq: 440, startAt: 0, duration: 0.09, peakGain: 0.05, shape: 'triangle' },
      { freq: 660, startAt: 0.08, duration: 0.12, peakGain: 0.06, shape: 'triangle' },
    ]);
  }

  /** Soft falling two-note blip — the decision window closed (any reason). */
  playDecisionClose(): void {
    this.playTones([
      { freq: 560, startAt: 0, duration: 0.09, peakGain: 0.05, shape: 'triangle' },
      { freq: 380, startAt: 0.07, duration: 0.12, peakGain: 0.05, shape: 'triangle' },
    ]);
  }

  /** Satisfying, distinct "locked it in" confirm — separate from decisionClose. */
  playCashOut(): void {
    this.playTones([
      { freq: 520, startAt: 0, duration: 0.07, peakGain: 0.07, shape: 'square' },
      { freq: 780, startAt: 0.06, duration: 0.07, peakGain: 0.07, shape: 'square' },
      { freq: 1040, startAt: 0.12, duration: 0.14, peakGain: 0.07, shape: 'square' },
    ]);
  }

  /** Quick, restrained click/fizzle — a bulb popped that wasn't yours. */
  playPopNeutral(): void {
    this.playTones([{ freq: 300, toFreq: 120, startAt: 0, duration: 0.14, peakGain: 0.05, shape: 'sawtooth' }]);
  }

  /** Deliberately muted, low, anticlimactic — YOUR bulb popped. Never exciting. */
  playPopLoss(): void {
    this.playTones([{ freq: 160, toFreq: 60, startAt: 0, duration: 0.32, peakGain: 0.035, shape: 'sine' }]);
  }

  /** Reserved cue — a bulb was statistically close to popping but survived. */
  playNearMiss(): void {
    this.playTones([
      { freq: 900, toFreq: 1500, startAt: 0, duration: 0.1, peakGain: 0.04, shape: 'sine' },
      { freq: 1500, toFreq: 900, startAt: 0.09, duration: 0.14, peakGain: 0.04, shape: 'sine' },
    ]);
  }

  /** Energetic celebratory arpeggio — the human's bulb won the cycle. */
  playWin(): void {
    const notes = [523, 659, 784, 1047, 1319];
    this.playTones(
      notes.map((freq, i) => ({
        freq,
        startAt: i * 0.09,
        duration: 0.28,
        peakGain: 0.08,
        shape: 'triangle' as const,
      })),
    );
  }
}

export const soundManager = new SoundManager();
