---
name: delivery-sop
description: "Delivery standard operating procedure: from yes to done."
source: Elitza knowledge base
---

# Delivery SOP

## Stages

diagnose -> proposal -> workbook -> scheduled -> payment -> done.

Each move is idempotent: re-running on the current stage records the note/asset instead of throwing.

## Diagnose

Write the diagnosis note in the CRM. Tools, volume, break, owner, budget signal, constraint.

## Proposal

Send the fixed-scope proposal as a file. One follow-up at +3 days.

## Workbook

Pick one workbook from the library. Pull it into the client's assets. Adapt to their data.

## Scheduled

Book the call. Confirm the date. Set next_action_at.

## Payment

Record payment. 50% upfront, 50% on delivery (or full on delivery for small jobs).

## Done

Generate CLIENT_SOP_HANDOVER.md from git evidence. Sign it. Hand over credentials. Close the case.

## Handover document

Generated from git history, env-var name scan, package scripts, and live permission gates. Values are never written. Signed with Ed25519.
