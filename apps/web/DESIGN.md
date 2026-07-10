# Buzzlight Web Demo Design System

## 1. Atmosphere & Identity

Buzzlight should feel like a quiet live-ops console: dark, direct, and fast to scan while a voice session is in motion. The signature is tonal depth with sharp signal accents — the interface stays nearly black until a state label, response chip, or control needs attention.

## 2. Color

### Palette

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Surface/page | `--surface-page` | `#000000` | App background and root canvas |
| Surface/panel | `--surface-panel` | `rgba(6, 9, 14, 0.72)` | Log panel body |
| Surface/input | `--surface-input` | `rgba(255, 255, 255, 0.07)` | Inputs and low-emphasis pills |
| Surface/raised | `--surface-raised` | `rgba(255, 255, 255, 0.1)` | Secondary buttons and control accents |
| Text/primary | `--text-primary` | `#f7f5ee` | Main interface copy |
| Text/secondary | `--text-secondary` | `#aeb8c8` | Status text, form labels, metadata |
| Text/log | `--text-log` | `#e9eef7` | Log body copy |
| Border/default | `--border-default` | `rgba(255, 255, 255, 0.12)` | Panel frames and control outlines |
| Border/subtle | `--border-subtle` | `rgba(255, 255, 255, 0.08)` | Entry separators |
| Accent/assistant | `--accent-assistant` | `#47A85A` | Assistant and agent labels, primary actions |
| Accent/assistant-hover | `--accent-assistant-hover` | `#3a9148` | Primary button hover state |
| Accent/you | `--accent-you` | `#7B52C4` | User labels and focus ring |
| Accent/run | `--accent-run` | `#e8a838` | Run and tool activity labels |
| Accent/approval | `--accent-approval` | `#e87c38` | Approval/alert labels |
| Accent/error | `--accent-error` | `#e85050` | Error labels and destructive emphasis |
| Accent/log-dim | `--accent-log-dim` | `#6b7a8d` | Miscellaneous log labeling |
| Shell/glow-purple | `--glow-purple` | `rgba(90, 45, 160, 0.38)` | Shell ambient gradient |
| Shell/glow-green | `--glow-green` | `rgba(55, 140, 75, 0.22)` | Shell ambient gradient |

### Rules

- Nearly-black surfaces stay dominant; accents communicate origin or urgency, not decoration.
- The assistant green and user purple are the only conversational identity hues.
- New states must map to an existing semantic accent before any new color is introduced.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Usage |
| --- | --- | --- | --- | --- |
| Display | `32px` | `760` | `1.05` | Product title |
| Body | `16px` | `400` | browser default | Primary messages and inputs |
| Label | `13px` | `400` | browser default | Form labels |
| Caption | `12px` | `500+` | browser default | Log kinds, timing chips, status metadata |

### Font Stack

- Primary: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Mono/system fallback: browser default `<pre>` monospace stack for structured log payloads

### Rules

- Sentence case for body and controls; uppercase is reserved for compact metadata labels.
- Metadata should stay at 12px and rely on color/weight for hierarchy instead of larger size jumps.

## 4. Spacing & Layout

### Base Unit

Primary spacing is a 4px rhythm.

| Token | Value | Usage |
| --- | --- | --- |
| `--space-1` | `4px` | Tight gaps inside compact UI |
| `--space-2` | `8px` | Inline pill spacing and micro layouts |
| `--space-3` | `12px` | Form gaps and compact padding |
| `--space-4` | `16px` | Shell/log padding and standard gaps |
| `--space-6` | `24px` | Outer shell padding |
| `--space-8` | `32px` | Large title/panel rhythm |
| `--control-height` | `44px` | Inputs and main buttons |

### Grid

- Max content width: `980px`
- Main layout: single centered panel with stacked rows and a scrolling log region
- Responsive rule: controls and composer collapse to a single column at `720px`

### Rules

- New spacing should stay on the 4px rhythm.
- Existing 6px and 10px optical offsets are legacy exceptions; do not add more off-scale values without a clear visual reason.

## 5. Components

### Log entry
- **Structure**: `.entry > strong + pre` with optional approval actions and optional assistant/agent/speech timing chip
- **Variants**: conversational (`you`, `assistant`, `agent`), system (`session`, `speech`), execution (`run`, `run.event`), alert (`approval`, `error`)
- **Spacing**: `4px` internal gap, `10px` vertical padding, subtle bottom divider
- **States**: visible, filter-hidden
- **Accessibility**: semantic text order preserved; log container remains `aria-live="polite"`
- **Motion**: none beyond container scroll updates

### Filter pill
- **Structure**: compact button in a wrapping flex row above the log
- **Variants**: active, inactive, hover, focus-visible
- **Spacing**: 8px gap between pills, 32px control height
- **Accessibility**: use `aria-pressed` to reflect toggle state
- **Motion**: micro hover/focus transitions only

### Composer controls
- **Structure**: text input followed by action buttons
- **Variants**: default, hover, focus, disabled
- **Spacing**: 10px legacy gap, 44px control height
- **Accessibility**: keyboard reachable with visible focus treatment
- **Motion**: 180ms hover transition on color only

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
| --- | --- | --- | --- |
| Micro | `180ms` | `ease` | Button and filter hover transitions |
| Standard | `200ms` | `ease` | Filter visibility changes if introduced later |

### Rules

- Only color, opacity, and transform should animate.
- Toggle controls require visible hover and focus states.
- Filtering hides content instantly; the scan experience matters more than ornamental motion.

## 7. Depth & Surface

### Strategy

Mixed tonal-shift plus borders.

- The shell gets depth from layered gradients and ambient color glows.
- Panels, inputs, and pills use translucent fills with thin white borders.
- Entry separation uses low-contrast dividers instead of shadows.
