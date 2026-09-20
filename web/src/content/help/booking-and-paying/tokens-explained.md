---
title: "Tokens, explained"
description: "How Saathum tokens use an internal value anchor, how local-currency quotes work, and what tokens can and cannot do."
section: booking-and-paying
order: 4
updated: 2026-09-11
keywords: ["tokens", "wallet", "top up", "balance", "paise", "withdraw", "UPI", "recharge"]
audience: buyer
faq:
  - q: "How much is one token worth?"
    a: "100 Tokens = $1 as Saathum's internal accounting anchor. Checkout may be shown in local currency using a server-owned FX quote captured with the payment."
  - q: "Can I get my unused tokens back as cash?"
    a: "Withdrawal semantics are not yet available. If a refund or reversal applies, Saathum uses the exact token amount recorded for the original transaction."
draft: false
---

## The internal anchor: 100 Tokens = $1

Tokens are the unit you pay with everywhere on Saathum — booking a session, buying a ticket to a live show, or using an AI feature. **100 Tokens = $1** is the internal accounting anchor. It is not a promise that checkout or any future payout uses USD.

## Topping up

Top-ups use a server-owned FX quote to show the local-currency amount for the requested token amount. The quote and payment snapshot are immutable records for that payment. Before you confirm, the token amount and local-currency amount are shown up front.

## What tokens are not

A token is an in-app unit of account, not a bank product. It is not a deposit, not e-money, not a security, and not a cryptocurrency. It does not earn interest, and it cannot be sent to another person's account. Withdrawal semantics are not yet available. The full legal detail lives on the [Tokens & Wallet](/tokens) policy page.

## Your balance

Your current balance and your recent activity are visible in the app at all times. Worth checking in on now and then, and worth flagging to support quickly if a number looks off.

## Refunds and reversals

Unused tokens remain in your wallet as tokens. If a refund or reversal applies, Saathum returns the exact token amount recorded in the original transaction snapshot, without repricing it at a later FX rate. See [Refunds & Cancellations](/refunds).

## Payments are still being tested

Saathum uses a server-owned FX quote for local-currency checkout. If a refund or reversal is approved, it returns the exact token amount in the immutable transaction snapshot — see [Refunds & Cancellations](/refunds) for the details.
