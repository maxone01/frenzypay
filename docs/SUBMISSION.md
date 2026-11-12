# NEAR HACKATHON submission — FrenzyPay

**FrenzyPay** — non-custodial invoicing and treasury on NEAR Intents: get paid in USDC or USDT from any chain into your own `intents.near` balance, then swap, pay bills, run payroll and withdraw, with every outflow signed in your wallet.

- Repository: https://github.com/maxone01/frenzypay
- Live app: `<add after deploy>`
- Demo video: `<add after recording>`
- X demo post: `<add after posting>`
- NEAR payout wallet: `<add before submitting>`

## What did you build?

<!-- desc:start -->
FrenzyPay is non-custodial invoicing and treasury software for small businesses and freelancers who get paid in crypto across many chains.

Problem: a client holds USDC on Arbitrum, SOL or BTC; the business wants USDC or USDT in one place it controls, plus a way to pay vendors and staff without handing funds to a custodian.

What we built: wallet sign-in (NEAR via NEP-413, EVM via ERC-191); invoices in USDC or USDT with a public pay link; the payer picks any token on any chain and gets an exact deposit address from a NEAR Intents 1Click quote that delivers the invoice total into the owner's own intents.near balance; an invoice is marked paid only after the server verifies 1Click's SUCCESS status against recipient, asset and amount. From that balance the owner swaps, pays vendor bills (including another FrenzyPay invoice), runs CSV payroll and withdraws to any chain. Every outflow is an intent the owner signs in their wallet; the server only quotes, checks and relays.

NEAR's role: NEAR Intents 1Click for multichain payments, swaps and withdrawals; signed intents on intents.near for every outflow.
<!-- desc:end -->

## Tracks

- **08 Real-World Money**: invoices, multichain payment into a non-custodial balance, verified reconciliation, bill pay, payroll, withdrawals.

## 3-minute demo script

| Time | Scene | Show |
|---|---|---|
| 0:00–0:15 | Intro | Title card: "FrenzyPay — built at NEAR HACKATHON". One line: get paid from any chain into your own NEAR Intents balance. |
| 0:15–0:30 | Sign in | Login page → Connect EVM wallet (or NEAR wallet) → sign the message. Point out: signing does not send a transaction. |
| 0:30–0:50 | Invoice | Invoices → New invoice, ~1 USDC, one line item → Issue → copy the pay link. |
| 0:50–1:15 | Pay from another chain | Open the pay link in a second browser/wallet → choose USDC on Arbitrum → enter refund address → show the deposit address and exact amount from the 1Click quote → send. |
| 1:15–1:30 | Paid + balance | Invoice flips to Paid after the verified 1Click status; Home shows the new USDC in the Intents balance and the activity feed. |
| 1:30–1:45 | Swap | Swap → 1 USDC → wNEAR, 1 % slippage → review expected/minimum → sign. |
| 1:45–2:00 | Bill | Bills → paste a FrenzyPay invoice link → vendor fields read-only → Pay → confirm address → sign. |
| 2:00–2:20 | Payroll | Payroll → upload a 2-line CSV → Send all → one signature per line. |
| 2:20–2:45 | Withdraw | Withdraw → Arbitrum address → review expected/minimum → confirm address → sign → tracked to the destination transaction. |
| 2:45–3:00 | Close | Repo link; "non-custodial: every outflow signed by you". |

## X post draft

<!-- x:start -->
Built at NEAR HACKATHON: FrenzyPay. Invoice in USDC/USDT, get paid in any token on any chain into your own NEAR Intents balance, then swap, pay bills, run payroll, withdraw. Every outflow signed in your wallet. https://github.com/maxone01/frenzypay
<!-- x:end -->

Attach the demo video or screenshots (invoice paid, Home balance, payroll sent).

## Submission checklist

- [ ] Repository is public (https://github.com/maxone01/frenzypay) and the README quickstart works from a clean clone.
- [ ] Demo recorded (video or screenshots) following the script above.
- [ ] Public X post published stating "Built at NEAR HACKATHON", with the video/screenshots and the repo link; link added above.
- [ ] NEAR payout wallet added above and in the submission form.
- [ ] Live launch gates in the README "Launch checklist" run with small amounts (or the submission says which were not run).
- [ ] Submitted before **14 Nov 2026 23:59 UTC**.
- [ ] If the team enters a second project, the README names it.
