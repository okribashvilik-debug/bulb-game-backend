import { InfoModal } from './InfoModal';

export function HowToPlayModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <InfoModal open={open} onClose={onClose} ariaLabel="How to play" title="How to Play">
      <section>
        <h3>1. Place your bet</h3>
        <p>
          Each cycle starts with a betting window. Pick a bulb — click it on stage or use the
          numbered chips — set your stake, and hit Bet. You can play with 5, 7 or 10 bulbs
          (the selector on the right applies from the next cycle).
        </p>
      </section>
      <section>
        <h3>2. Bulbs pop, one per round</h3>
        <p>
          Once betting closes, the round begins: every few seconds one bulb overcharges and
          pops. If your bulb pops, your stake is lost — it joins the prize pool for the
          players still standing.
        </p>
      </section>
      <section>
        <h3>3. Your coefficient grows</h3>
        <p>
          The pool of losing stakes (minus a 5% house fee) is shared among the surviving
          bulbs. Every pop makes the pool bigger, so the payout coefficient on your bulb
          only ever goes up the longer it survives.
        </p>
      </section>
      <section>
        <h3>4. Cash out or continue</h3>
        <p>
          After every round your bulb survives, a decision window opens: take the current
          payout (stake × coefficient) and lock it in, or ride to the next round for a
          bigger multiple. A cash-out is final — you keep the money even if your bulb would
          have won.
        </p>
      </section>
      <section>
        <h3>5. Last bulb standing wins</h3>
        <p>
          If your bulb is the last one alight, you win the full payout at the final
          coefficient. If it pops before then and you never cashed out, the stake is gone.
          Risk versus greed — that's the whole game.
        </p>
      </section>
    </InfoModal>
  );
}
