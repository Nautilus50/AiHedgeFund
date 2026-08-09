# ARF-OS

## AI Research Hedge Fund Operating System

**A multi-agent operating system for discovering, developing, testing, rejecting, forward-testing, and cataloguing systematic trading strategies.**

> **Project status:** Specification complete · MVP implementation pending  
> **Strategy language:** Pine Script® v6  
> **Primary stack:** TypeScript · Next.js · Fastify · PostgreSQL · Redis · BullMQ  
> **Deployment target:** Railway-compatible services

ARF-OS turns systematic trading research into a controlled, reproducible production line.

Instead of asking one AI agent to invent a strategy, code it, optimise it, test it, and then approve its own work, ARF-OS separates the process into independent specialist lanes. Every strategy must move through a versioned research lifecycle, pass deterministic evidence gates, survive adversarial validation, and produce a complete audit trail.

The objective is not to generate attractive equity curves. The objective is to build a research system that can distinguish promising strategies from overfitted, fragile, misleading, or unreproducible ones.

> [!IMPORTANT]
> ARF-OS is initially a **strategy research and paper-validation platform**, not a regulated hedge fund, broker, investment adviser, or autonomous capital manager. Research approval is not permission to deploy live capital. No agent can grant live-trading approval.

---

## Implementation documentation

See [`docs/local-setup.md`](./docs/local-setup.md) for local development and
[`docs/railway-deploy.md`](./docs/railway-deploy.md) for deploying every
service to Railway.