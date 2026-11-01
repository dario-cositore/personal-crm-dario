---
name: ai-tools-landscape
description: "The current AI tools landscape for enablement: LLMs, frameworks, agents."
source: Elitza knowledge base
---

# AI tools landscape

## LLM providers (use the cheapest that passes the eval)

- OpenAI: GPT-4o, GPT-4o-mini. Strong general, good tool calling.
- Anthropic: Claude Sonnet, Haiku. Strong reasoning, long context.
- Google: Gemini Flash/Pro. Cheap, fast, good for classification.
- Xiaomi MiMo: cost-efficient, good for high-volume extraction.
- Local (Ollama): Llama, Mistral. Use for sensitive data, no network.

## Automation platforms

- n8n: self-hosted or cloud. Best for complex flows and code nodes.
- Make: visual, non-technical handover.
- Zapier: simplest, most expensive.

## Agent frameworks

- OpenAI function calling / tool use (native).
- LangChain / LangGraph: orchestration, state machines.
- CrewAI: multi-agent roles.
- Elitza brain: local-first, SQLite-backed, permission-gated.

## Vector stores

- Chroma: simplest, in-process.
- Qdrant: production, self-hosted.
- pgvector: if you already have Postgres.
- SQLite (sqlite-vec): minimal, for small corpora.

## OCR and document processing

- Tesseract (local, free).
- Google Document AI, AWS Textract (cloud, paid).
- LLM vision (GPT-4o, Claude) for structured extraction.

## Rule

Always start with the simplest tool that solves the problem. Upgrade only when measured.
