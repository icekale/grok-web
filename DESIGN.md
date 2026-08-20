---
name: Grok Web
description: Local browser workspace for Grok Build — a terminal window that happens to be a page.
colors:
  canvas: "#ffffff"
  panel: "#f5f5f5"
  hover: "#eeeeee"
  selected: "#e8e8e8"
  border: "#e0e0e0"
  ink: "#1a1a1a"
  muted: "#4b5563"
  dim: "#6b7280"
  accent: "#2563eb"
  accent-hover: "#1d4ed8"
  warning: "#b45309"
  danger: "#b44747"
  user-wash: "#eff6ff"
  tool-wash: "#f9fafb"
  on-accent: "#ffffff"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
  label:
    fontFamily: "\"Noto Sans Mono Variable\", \"JetBrains Mono\", ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
rounded:
  xs: "4px"
  sm: "5px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-accent}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "36px"
  dialog:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
---

# Design System: Grok Web

## Overview

**Creative North Star: "The Terminal Window"**

This is a coding-agent workspace that happens to render in a browser. The field is mostly white. Chrome is thin. Type is small and scannable. The conversation is the stage; everything else is a tool rail. It should feel like an IDE pane, not a product site.

Personality is restrained and task-first. Density is high: 32px controls, 8–16px rhythm, 4px scrollbars. The system UI sans carries chrome; Noto Sans Mono carries code, paths, and meta. Dark mode inverts the same roles onto near-black plates (`#171717` canvas) without changing the geometry.

Confirmed rejections: marketing landings, dashboard card walls, toy-large rounded consumer chrome, and treating the workspace as a gray cave. White is the field; gray is only a plate or a hairline.

**Key Characteristics:**
- White-majority canvas with hairline borders
- One rare blue for action and focus
- System sans + mono meta
- Three-pane operate layout that collapses on a 640px phone
- Flat surfaces; shadow only on floating chrome

## Colors

The palette is a white work surface, a cooler ink stack, and a single blue reserved for “this is actionable.”

### Primary
- **Work Blue** (`{colors.accent}`): primary buttons, focus rings, connected-state dots, user-turn wash pairing. Dark mode remaps the same role to `#60a5fa`.

### Neutral
- **Paper** (`{colors.canvas}`): app background and assistant transcript. This is the majority of every screen.
- **Plate** (`{colors.panel}`): sidebar, dialog footers, input wells, tool output. A 6% step off paper, not a gray theme.
- **Hairline** (`{colors.border}`): 1px structure. Prefer this over shadow.
- **Ink** (`{colors.ink}`): primary text.
- **Muted / Dim** (`{colors.muted}`, `{colors.dim}`): secondary labels and placeholders.
- **Hover / Selected** (`{colors.hover}`, `{colors.selected}`): row and chip states.
- **User wash** (`{colors.user-wash}`): user bubbles only.
- **Tool wash** (`{colors.tool-wash}`): tool cards.
- **Warning / Danger** (`{colors.warning}`, `{colors.danger}`): caution text and destructive confirms.

**The White Field Rule.** Most of the screen is paper. Gray exists as plates and lines, never as the atmosphere.

**The One Blue Rule.** Work Blue is for action and focus. It is not a background, not a large fill, and not decoration. Audit: if blue covers more than a thin control or a small wash, it is wrong.

## Typography

**Display Font:** none. There is no marketing display face.
**Body Font:** system UI sans (`--font-ui`)
**Label/Mono Font:** Noto Sans Mono Variable (`--font-mono`)

**Character:** Chrome is native and quiet. Chat is slightly larger than UI. Meta, paths, and keys are mono so they scan like a terminal.

### Hierarchy
- **Title** (650, `0.875rem`, 1.25): dialog headings, settings group titles, sidebar workspace name.
- **Body** (400, `0.9375rem`, 1.55): assistant and user prose in the transcript.
- **UI** (400/600, `0.8125rem`, 1.35): buttons, inputs, lists, menus.
- **Label** (400, `0.75rem`, 1.35, mono or sans): timestamps, hints, section labels, keyboard chips.

Root `html` is `16px` so rem tokens stay honest. Product CSS must not set type below 12px.

**The Floor Rule.** No product type smaller than 12px. Prefer `--text-meta` / `--text-ui` / `--text-chat` / `--text-title` over raw pixel sizes.

## Layout

Operate, three panes: project/session sidebar on a plate, conversation in the white field, files/Git as a right inspector. Open lands on the last project and session.

Spacing is 4 / 8 / 12 / 16. Sidebar brand row is 40px; tool rows hover around 32px. Dialogs pad 16px with a 12–14px header and a plated footer.

Breakpoints observed: `640px` turns dialogs into bottom sheets and the shell into a single column (left drawer, right as an in-page panel). `360px` tightens compact chrome. `pointer: coarse` enlarges hit targets. `prefers-reduced-motion: reduce` kills the 120ms dialog enter.

**The Pane Rule.** New product surfaces join a pane or a dialog. They do not introduce a fourth dashboard.

## Elevation & Depth

Flat by default. Depth is a background step or a 1px hairline. Shadows are only for things that float over the field.

### Shadow Vocabulary
- **Dialog lift** (`box-shadow: 0 10px 28px rgba(15, 23, 42, .18)`): modal shells; backdrop `rgba(15, 23, 42, .32)` plus 6px blur.
- **Menu lift** (`0 8px 18px rgba(0, 0, 0, .28)`): compact popovers.
- **Chip lift** (`0 2px 10px` / `0 4px 8px`): floating pills and toasts.

**The Flat-By-Default Rule.** Resting panes have no shadow. If it is not floating, do not lift it.

## Shapes

Corners are tight and mechanical: 4px on keycaps, 5–6px on compact rows, 8px on buttons and fields, 12px on dialogs, pill only for status dots and FABs. Borders are 1px `{colors.border}`. No squircles, no 16px+ consumer cards.

**The Hard Control Rule.** Controls stay short (~32–36px) and 8px-round. Do not grow them into mobile-marketing buttons.

## Components

### Buttons
- **Shape:** gently hard (8px).
- **Primary:** Work Blue fill, white label, 600, 32px tall, 0 12px. Hover uses accent-hover. Active may shift 1px down.
- **Ghost:** transparent, muted text, hairline or none; hover plate.
- **Danger:** `#b44747` fill for confirms that destroy data.
- **Focus:** 2px Work Blue outline, 2px offset (inset −2px inside the sidebar).

### Cards / Containers
- **Corner Style:** 8–12px when boxed; many rows have no card at all.
- **Background:** paper or plate.
- **Shadow Strategy:** none at rest.
- **Border:** 1px hairline when a box is required.
- **Internal Padding:** 16px in dialogs; 8–10px in sidebar rows.

### Inputs / Fields
- **Style:** plate well, 8px corners, 36px tall in dialogs, 1px hairline.
- **Focus:** accent outline; search wrap darkens the border to dim ink.
- **Error:** `#dc2626` / dark `#f87171` at meta size.
- **Secrets:** same field with a 24px eye toggle, no extra chrome.

### Navigation
- Sidebar sits on plate. Brand is a 20px ink-masked Grok mark, not a wordmark lockup.
- Rows: 5px radius, hover plate, selected a step darker. Section labels are uppercase-ish meta.
- Mobile: drawer + back chevron; do not keep list and detail side by side under 640px.

### Dialog (signature)
Codex-shaped modal: 12px corners, paper body, plated footer, sizes confirm 420 / request 520 / editor 680 / tool 820 / terminal 920. On a phone it becomes a 12px-top-radius sheet pinned to the bottom.

### Transcript
User turns sit on the blue wash. Assistant turns sit on paper. Tools sit on the tool wash. Composer is a hard field at the bottom, not a floating chat bubble.

## Do's and Don'ts

### Do:
- **Do** keep the field white (or near-black in dark mode) and spend gray only on plates and lines.
- **Do** use Work Blue for the one action and the focus ring.
- **Do** set type with `--text-*` tokens and keep the 12px floor.
- **Do** put new work in the existing three-pane shell or a Codex dialog.

### Don't:
- **Don't** paint large regions blue or gray to “feel branded.”
- **Don't** add card grids, hero type, or a second display font.
- **Don't** give resting panes drop shadows.
- **Don't** invent a Pi-colored or marketing Grok.com landing inside the app.
- **Don't** ship type at 9–11px to squeeze chrome.
