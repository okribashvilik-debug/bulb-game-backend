import { InfoModal } from './InfoModal';

// ⚠️ DRAFT LEGAL COPY — placeholder language written by the developer, NOT
// reviewed by counsel or the site owner. Every section below must be
// reviewed and approved before this game goes live to real players.
export function PolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <InfoModal open={open} onClose={onClose} ariaLabel="Game policy" title="Game Policy & Rules">
      <section>
        <h3>Terms of Use</h3>
        <p>
          By playing Bulb Game you agree to these terms. The operator may update them at any
          time; continued play after an update constitutes acceptance. If you do not agree,
          do not place bets.
        </p>
      </section>
      <section>
        <h3>Eligibility & Age Restrictions</h3>
        <p>
          You must be at least 18 years old (or the legal gambling age in your jurisdiction,
          whichever is higher) and located where real-money games of chance are lawful. It is
          your responsibility to verify local law before playing.
        </p>
      </section>
      <section>
        <h3>Responsible Gaming</h3>
        <p>
          Only bet what you can afford to lose. Bulb Game is entertainment, not income. If
          play stops being fun, take a break; if you believe you may have a gambling problem,
          seek help from a local support organization and contact support to restrict your
          account.
        </p>
      </section>
      <section>
        <h3>Fairness / RNG Disclosure</h3>
        <p>
          The winning bulb and the full elimination order are decided by a uniform random
          number generator before betting opens, independent of stakes — no bet, large or
          small, influences which bulb survives. Payouts are pari-mutuel: players bet
          against each other, and the house takes a flat 5% fee from each round's eliminated
          stakes.
        </p>
      </section>
      <section>
        <h3>Payouts & Cash-Out Rules</h3>
        <p>
          A cash-out is final and priced at the coefficient shown when the decision window
          opened; it cannot be reversed, and a cashed-out bet has no further claim on the
          cycle, even if that bulb goes on to win. Winning bets are settled automatically at
          cycle end. If fewer than two bulbs receive bets, the cycle is cancelled and all
          stakes refunded in full.
        </p>
      </section>
      <section>
        <h3>Account & Balance Handling</h3>
        <p>
          Balances are held and settled by the operator. Bets are debited when placed;
          payouts and refunds are credited automatically. Obvious errors (technical faults,
          mispriced payouts) may be corrected, with affected bets refunded at stake.
        </p>
      </section>
      <section>
        <h3>Prohibited Use</h3>
        <p>
          Bots, scripts, multiple accounts, exploitation of technical defects, and any form
          of collusion are prohibited. Violations may result in voided bets, forfeited
          winnings, and account closure.
        </p>
      </section>
      <section>
        <h3>Limitation of Liability</h3>
        <p>
          The service is provided "as is." To the maximum extent permitted by law, the
          operator's total liability for any claim is limited to the value of the affected
          stake. The operator is not liable for losses caused by connectivity failures on
          the player's side.
        </p>
      </section>
      <section>
        <h3>Contact / Support</h3>
        <p>
          Questions, disputes, or self-exclusion requests: contact support via the details
          published on the operator's website. Include your player ID and the approximate
          time of the cycle in question.
        </p>
      </section>
    </InfoModal>
  );
}
