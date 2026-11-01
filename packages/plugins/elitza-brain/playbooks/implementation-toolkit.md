---
name: implementation-toolkit
description: "Tools and patterns for building AI Enablement systems: n8n, Make, agents, RAG."
source: Elitza knowledge base
---

# Implementation toolkit

## Automation platforms

- n8n (self-hosted or cloud): best for complex flows, code nodes, self-hosting. Use for document processing and multi-step pipelines.
- Make (Integromat): best for visual, non-technical handover. Use for intake qualification and CRM automation.
- Zapier: simplest, most expensive. Use only when the client already has it.

## AI building blocks

- LLM calls: OpenAI, Anthropic, or local (Ollama) for sensitive data. Use the cheapest model that passes the eval.
- RAG: vector store (Chroma, Qdrant, pgvector) + embeddings. Use only when the corpus is large (>50 docs).
- Agents: tool-calling loops with a fixed tool set. Keep tools minimal and typed.
- Structured output: JSON mode / tool calls. Never parse free text.

## Integration patterns

- Webhook in, process, webhook out.
- Polling a folder or inbox on a schedule.
- Cron-triggered batch jobs.
- Human-in-the-loop: approval step before anything is sent.

## Delivery checklist

- Working flow on the client's own credentials.
- A one-page operating note.
- A handover document (CLIENT_SOP_HANDOVER.md).
- A test run with their real data.
- Payment recorded.
