---
name: client-handover
description: "What a finished job must hand over: architecture, environment, maintenance, recovery, approval gates."
source: Elitza knowledge base (Task H)
---

# Client handover

The handover is the product the buyer keeps. It is written from what actually shipped, not from the proposal.

## Sections the document must have

1. Architecture — what runs where, in plain language, with the one diagram or file tree that makes it obvious.
2. Environment and secrets — the names of every variable and where its value lives. Values never go in the document.
3. Daily operation — the three things the buyer does each week, written for a person who is not an engineer.
4. Maintenance — what must be updated, how often, what happens if it is ignored.
5. Edge cases and recovery — the failures that can happen, what the system does, what the human does.
6. Approval gates — every place a human must say yes before anything goes out, listed with how to say it.
7. Support and ownership — who fixes what, and where the code lives if they ever take it elsewhere.

## Rules

- No secret values. Names of variables only.
- Written to be read once and used forever: short sections, imperative sentences, no reassurance.
- Delivered with the final payment.
- Source of truth: the code and the execution log, not memory of the sale.
