# LLM Proxy

Lightweight, self-hosted LLM gateway with OpenAI/Anthropic compatibility.

## Development Workflow
When debugging or stuck on a problem, use the `/learning-feedback-loop` skill.
This skill helps break out of unproductive debugging cycles by:
- Reviewing the learnings.md log for patterns and prior discoveries
- Identifying where the investigation has been going in circles
- Proposing a clear path forward based on what's already been learned

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Development
- **Dev:** `npm run dev` (hot reload with tsx)
- **Build:** `npm run build` (TypeScript compile)
- **Start:** `npm start` (production)
- **Test:** `npm test` (vitest)
- **Lint:** `npm run lint`

## Docker
- **Up:** `docker-compose up -d`
- **Logs:** `docker-compose logs -f`
