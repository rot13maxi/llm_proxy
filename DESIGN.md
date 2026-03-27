# Design System — LLM Proxy

## Product Context
- **What this is:** Self-hosted LLM gateway with OpenAI/Anthropic compatibility
- **Who it's for:** Engineers running local LLM inference (sglang, vllm, etc.)
- **Space/industry:** Developer infrastructure / AI tooling
- **Project type:** Admin dashboard / usage monitoring tool

## Aesthetic Direction
- **Direction:** Refined Brutalist
- **Decoration level:** Minimal
- **Mood:** Technical, precise, no-nonsense. A tool that feels like it was built by engineers who hate visual noise. Flat borders, monochrome UI, color only for data and status.
- **Reference aesthetic:** Linear, Vercel, Railway, Supabase

## Typography
- **Display/Hero:** Geist — Clean, modern, professional. Used by Vercel for their design system. Optimal for headings and large text.
- **Body:** Inter — Highly readable at small sizes. Industry standard for UI text (Figma, Linear, etc.).
- **UI/Labels:** Same as body (Inter), with code-style treatment for technical labels
- **Data/Tables:** Geist with tabular-nums — Critical for aligned numbers in cost/usage displays
- **Code:** JetBrains Mono — For API keys, curl commands, and technical output
- **Loading:** Google Fonts CDN (Geist, Inter, JetBrains Mono)

**Font Scale:**
- Display (h1): 2.5rem (40px) → 1.75rem (28px) on mobile
- Section headers (h2): 1.25rem (20px) → 1rem (16px) on mobile
- Body: 0.875rem (14px)
- Small/labels: 0.6875rem (11px)
- Code: 0.8125rem (13px)

## Color
- **Approach:** Monochrome UI with restrained accent. Color is reserved for data visualization, status indicators, and links — not UI chrome.

- **Primary:** #2563eb — For data viz, links, and primary actions (when color is needed)
- **Success:** #16a34a — Active status, positive changes
- **Warning:** #ca8a04 — Rate limited, approaching limits
- **Error:** #dc2626 — Inactive/expired, destructive actions
- **Info:** #2563eb — Informational messages

- **Neutrals (Cool Slate):**
  - Background: #ffffff (light) / #0a0a0a (dark)
  - Subtle background: #fafafa (light) / #171717 (dark)
  - Border: #e5e5e5 (light) / #262626 (dark)
  - Border subtle: #f0f0f0 (light) / #202020 (dark)
  - Text primary: #171717 (light) / #f5f5f5 (dark)
  - Text muted: #737373 (light) / #a3a3a3 (dark)
  - Text subtle: #a3a3a3 (light) / #737373 (dark)

- **Data Visualization Palette** (for charts/comparisons):
  - Key 1: #2563eb (blue)
  - Key 2: #0891b2 (cyan)
  - Key 3: #7c3aed (violet)
  - Key 4: #16a34a (green)
  - Key 5: #ca8a04 (amber)

- **Dark mode:** Full surface redesign. Reduce saturation on colored elements by 10-20%. Maintain contrast ratios.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable on desktop, compact on mobile

**Scale:**
- 2xs: 2px
- xs: 4px
- sm: 8px
- md: 12px
- lg: 16px
- xl: 24px
- 2xl: 32px

## Layout
- **Approach:** Hybrid — grid-disciplined for data tables and metrics, responsive stacking for mobile

**Grid:**
- Desktop: 12-column, max-width 800px for admin views, 1200px for dashboards
- Tablet: 8-column
- Mobile: Single column, full-width cards

**Max content width:** 800px (admin), 1200px (dashboard)

**Border radius hierarchy:**
- sm: 3px (badges, code blocks, tight UI elements)
- md: 5px (cards, buttons, modals)
- lg: 8px (modal containers, elevated surfaces)
- full: 9999px (progress bars, pills)

## Motion
- **Approach:** Minimal-functional — Only state transitions that aid comprehension

**Easing:**
- enter: ease-out
- exit: ease-in
- move: ease-in-out

**Duration:**
- micro: 100ms (hover states, focus states)
- short: 180ms (modals, toasts, overlays)
- medium: 250ms (complex transitions)

## Component Patterns

### Buttons
- Flat, border-based (no shadows)
- Primary: Solid text color (#171717), white text on dark
- Secondary: Transparent with border
- Danger: Error color background
- Hover: Background shifts to subtle gray, border darkens
- No emoji in production (used only in mockups)

### Cards
- 1px border, no shadow
- Padding: 16px (lg)
- Border radius: 5px (md)
- Background: White (light) / #0a0a0a (dark)

### Forms
- Labels: Code font, uppercase, muted color
- Inputs: 1px border, focus state with 1px outline (not glow)
- No decorative elements

### Badges/Status
- Code font, uppercase, small (11px)
- Border-based with subtle background tint
- Color only for semantic meaning (active/inactive, success/error)

### Data Tables
- No zebra striping
- Hover row highlight with subtle background
- Tabular-nums on all numeric columns
- Compact padding (8px)

### Modals
- Centered overlay with 50% opacity black
- Border-based, no heavy shadows
- Max-width 500px for forms
- Full-width on mobile

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-23 | Initial design system created | Refined brutalist aesthetic for developer tool. Monochrome UI with color reserved for data/status. Flat borders over shadows. Tighter spacing for data density. Geist/Inter/JetBrains Mono type stack. |
| 2026-03-23 | Removed emoji from buttons | Emoji feel out of place on a technical infrastructure tool. Use icons or text only in production. |
| 2026-03-23 | Header padding adjustment | Add horizontal padding to header content for breathing room on mobile |

---

**Created by:** /design-consultation  
**Product:** LLM Proxy v0.1.0
