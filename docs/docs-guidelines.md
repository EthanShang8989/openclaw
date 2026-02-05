---
title: "Documentation Guidelines"
description: "Mintlify linking rules, i18n workflow, and README conventions"
---

# Documentation Guidelines

## Mintlify Hosting

Docs are hosted on Mintlify at [docs.openclaw.ai](https://docs.openclaw.ai).

## Internal Linking Rules

### Within docs/**/*.md

- Use **root-relative paths**, no `.md`/`.mdx` extension
- Example: `[Config](/configuration)` (not `[Config](configuration.md)`)

### Section Cross-References

- Use anchors on root-relative paths
- Example: `[Hooks](/configuration#hooks)`

### Heading & Anchor Guidelines

- **Avoid em dashes (—) and apostrophes (')** in headings
- These characters break Mintlify anchor links

### External URLs

When Peter asks for links, reply with full URLs:
- ✅ `https://docs.openclaw.ai/configuration`
- ❌ `/configuration`

### README (GitHub)

- Keep **absolute docs URLs** so links work on GitHub
- Example: `https://docs.openclaw.ai/getting-started`

### Doc URLs Referenced

When you touch docs, end your reply with the `https://docs.openclaw.ai/...` URLs you referenced.

## Content Guidelines

- Docs content must be **generic**
- No personal device names, hostnames, or paths
- Use placeholders like `user@gateway-host` and "gateway host"

## i18n (zh-CN)

### Generated Files

`docs/zh-CN/**` is **generated** — do not edit unless the user explicitly asks.

### Translation Pipeline

1. Update English docs
2. Adjust glossary: `docs/.i18n/glossary.zh-CN.json`
3. Run: `scripts/docs-i18n`
4. Apply targeted fixes only if instructed

### Translation Memory

- Location: `docs/.i18n/zh-CN.tm.jsonl` (generated)
- Reference: `docs/.i18n/README.md`

### Performance Note

The pipeline can be slow/inefficient. If it's dragging, ping @jospalmbier on Discord instead of hacking around it.
