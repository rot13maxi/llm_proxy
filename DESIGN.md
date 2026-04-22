# Design System — LLM Proxy

## Product Context
- **What this is:** Self-hosted LLM gateway with OpenAI/Anthropic compatibility
- **Who it's for:** Engineers running local LLM inference (sglang, vllm, etc.)
- **Space/industry:** Developer infrastructure / AI tooling
- **Project type:** Admin dashboard / usage monitoring tool

## Aesthetic Direction
- **Direction:** Neo-Brutalist with Skuomorphic Shadows
- **Mood:** Bold, tactile, unapologetically physical. UI elements feel like paper cutouts, metal panels, or physical buttons. Hard offset shadows create layered depth. Typography is heavy and uppercase.
- **Reference aesthetic:** Traditional Swiss poster design meets digital brutalism. Think Neue Grafik + Memphis Group + terminal aesthetics.

## Theming Architecture

The UI supports **6 switchable themes**, each a complete re-skin of all components. All themes share a core set of structural patterns while diverging on color, typography, and atmosphere.

### Available Themes

| Theme | Character | Accent | Background |
|-------|-----------|--------|------------|
| **Paper Punch** (default) | Off-white paper, dot grid, electric blue | #1240ff | Cream |
| **Classic Pop** | Pastel cards, chalky shadows | Pastel rotation | Warm cream |
| **Swiss Editorial** | Massive black/red type, thick rules | #e63946 | Cream |
| **Memphis Arcade** | Primary colors, geometric confetti | Rotation | Warm cream |
| **CRT Terminal** | Amber phosphor, scanlines, monospace | #f3b341 | Near-black |
| **Industrial** | Brushed metal, LED readouts, beveled buttons | #ffb84a | Dark gunmetal |

### Shared Structural DNA

Despite visual divergence, all themes share these hard-coded patterns:

1. **3-tier shadow system** — Consistent shadow sizes for layered depth
   - `--shadow`: Primary card/element shadow (5-8px offset)
   - `--shadow-sm`: Secondary/interactive shadow (3-5px offset)
   - `--shadow-xs`: Micro shadow for tight elements (2-3px offset)

2. **Hard offset shadows** — Zero blur, equal-x/y offset. Creates paper-cutout/skumorphic depth.

3. **Thick borders** — 2-4px solid borders on cards, buttons, inputs. No 1px hairline borders.

4. **Border radius: 0** — Most themes use sharp corners throughout. (Industrial uses 4-8px for its hardware aesthetic.)

5. **Interactive lift/press** — Hover: `translate(-1px, -1px)` + shadow grows. Active: `translate(2-3px, 2-3px)` + shadow disappears. Creates tactile button feel.

6. **Dashed secondary borders** — Card headers, key details, alias notes use `border-bottom: 2px dashed` for internal divisions.

7. **Monospace labels** — Technical labels (card titles, form labels, stat labels) always use monospace font.

8. **Uppercase for labels** — All labels, badges, and navigation use `text-transform: uppercase` with generous `letter-spacing` (0.08-0.18em).

## Typography

Each theme defines its own font stack. Common choices:
- **Display:** Space Grotesk, Archivo Black, Inter, Oswald, VT323
- **Body:** Work Sans, Space Grotesk, IBM Plex Sans, JetBrains Mono
- **Mono:** JetBrains Mono, IBM Plex Mono (for all code/labels)

**Label scale:**
- Card titles: 12px, uppercase, 0.14-0.18em letter-spacing
- Form labels: 11px, uppercase, 0.08-0.14em letter-spacing
- Badges: 11px, uppercase

## Color

Color is theme-dependent, but all follow this semantic pattern:

- **Accent** — Primary brand color, used for links, primary buttons, active states
- **Success** — Used for connected status, positive changes
- **Warning** — Used for rate limits, approaching thresholds
- **Error** — Used for inactive/disconnected, destructive actions
- **Ink/Neutral** — Text, borders, and UI chrome (varies by theme)

Data visualization colors are theme-specific and defined per theme.

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
- Heavy borders (3-4px), hard offset shadow
- Hover: lift (translate -1px -1px) + shadow grows
- Active: press (translate 2-3px 2-3px) + shadow disappears
- Primary: accent color background, white/dark text
- Secondary: paper background, border + shadow
- Danger: error/red background
- Ghost: transparent, no shadow

### Cards
- Thick border (3-4px solid ink)
- Box shadow (5-8px offset)
- Sharp corners (border-radius: 0) for most themes
- Card header: dashed bottom border
- Card title: monospace, uppercase, 0.14-0.18em letter-spacing

### Forms
- Thick input borders (3-4px)
- Monospace labels, uppercase
- Focus: shadow appears, sometimes with border color change

### Badges/Status
- Monospace, uppercase, small (11px)
- Border + background color for semantic meaning
- Success/error/inactive states use semantic colors

### Data Tables
- No zebra striping
- Hover row highlight
- Tabular-nums on numeric columns
- Bottom borders (dashed for secondary rows)

### Modals
- Centered overlay with ~50% opacity backdrop
- Thick border + hard shadow
- Max-width 500px for forms
- Full-width on mobile

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-23 | Initial design system created | Refined brutalist aesthetic for developer tool. Monochrome UI with color reserved for data/status. Flat borders over shadows. Tighter spacing for data density. Geist/Inter/JetBrains Mono type stack. |
| 2026-03-23 | Removed emoji from buttons | Emoji feel out of place on a technical infrastructure tool. Use icons or text only in production. |
| 2026-03-23 | Header padding adjustment | Add horizontal padding to header content for breathing room on mobile |
| 2026-04-22 | Multi-theme system | Replaced single design with 6 switchable neo-brutalist themes. Shared 3-tier shadow system, thick borders, lift/press interactions. Each theme is a complete visual re-skin. |

---

**Created by:** /design-consultation  
**Product:** LLM Proxy
