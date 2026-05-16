# 📚 Documentation Index

Welcome to the GateForge Parrot documentation. Start here.

## Reading Order

For first-time readers, we recommend this order:

1. **[../README.md](../README.md)** — Project overview, quick start, status
2. **[../ARCHITECTURE.md](../ARCHITECTURE.md)** — System architecture and diagrams
3. **[../SECURITY.md](../SECURITY.md)** — Encryption and threat model
4. **[../USER_JOURNEYS.md](../USER_JOURNEYS.md)** — How each role uses the system
5. **[../PLUGIN_DESIGN.md](../PLUGIN_DESIGN.md)** — OpenClaw plugin specifics
6. **[../poc/README.md](../poc/README.md)** — Run the crypto PoC

## By Role

### I'm an engineer building this
- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [PLUGIN_DESIGN.md](../PLUGIN_DESIGN.md)
- [poc/](../poc/)

### I'm a security reviewer
- [SECURITY.md](../SECURITY.md)
- [USER_JOURNEYS.md](../USER_JOURNEYS.md) → Auditor section

### I'm a product / business person
- [README.md](../README.md)
- [USER_JOURNEYS.md](../USER_JOURNEYS.md)

### I'm an admin / operator
- [USER_JOURNEYS.md](../USER_JOURNEYS.md) → Admin section
- [PLUGIN_DESIGN.md](../PLUGIN_DESIGN.md) → Installation flow

## Diagrams

All diagrams use **Mermaid** and render natively on GitHub.

To edit interactively, open [mermaid.live](https://mermaid.live) and paste any `mermaid` code block.

To export to PNG/SVG:

```bash
npm install -g @mermaid-js/mermaid-cli
mmdc -i ARCHITECTURE.md -o diagrams.pdf
```
