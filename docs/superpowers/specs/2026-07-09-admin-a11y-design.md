# Admin Accessibility Pass — Design

**Date:** 2026-07-09
**Status:** Approved direction (batch green light); spec authored from the UX-review backlog
**Scope:** Admin UI only. Runs LAST of the batch so it audits the final state of every page (including the new upload/table/feedback surfaces).
**Guiding constraint:** simplicity — mechanical, checkable fixes; no redesign.

## Problem

The help layer added this cycle lives entirely in native `title` tooltips — unreachable by keyboard and touch. Action "buttons" are underlined text with link affordance. Login/user forms are placeholder-only (no labels). Secondary text at `#888` on white fails WCAG AA contrast. Tables lack header scoping.

## Design

### 1. Reachable tooltips

`src/app/admin/components/Tooltip.tsx` is upgraded in place (same `<Tooltip help='…'>label</Tooltip>` API, so all call sites keep working): the trigger becomes a focusable element (`tabIndex=0`, `role='note'` trigger button with `aria-describedby` pointing at an inline `<span role='tooltip'>`), and the help text becomes a CSS-positioned popover shown on `:hover` AND `:focus-visible` AND tap (click toggles on touch). Pure CSS/inline-style + a few lines of state — no dependency. The native `title` attribute is dropped from the component (it double-announces). Raw `title=` attributes on buttons elsewhere remain (they're supplements on already-focusable controls, acceptable), except where a Tooltip replacement is one line.

### 2. Real buttons

A shared inline-style constant (`src/app/admin/lib/buttonStyles.ts`, e.g. `actionButton` / `dangerButton`) giving action buttons a visible button treatment: border, padding, radius, hover state — replacing bare `textDecoration: underline` on the ~30 admin action buttons. Links that navigate stay link-styled; things that DO stay button-styled. Mechanical sweep, no layout changes.

### 3. Form labels

Login and user-creation forms get real `<label htmlFor>` elements (visible labels above inputs — placeholder text becomes hint-only or is removed). Any other placeholder-only input found in the sweep gets the same treatment.

### 4. Contrast

`#888`-on-white secondary text globally bumped to `#595959` (7:1, comfortably AA) via find/replace in the admin pages; the `#cbd5e0`-on-`#1a365d` nav already passes. StatusChip/provenance-badge color pairs verified against their tinted backgrounds and darkened only if any fail 4.5:1 (check with a contrast computation during implementation, record results in the commit message).

### 5. Table semantics

All admin data tables get `scope='col'` on header cells. (aria-live on notices is delivered by the feedback-layer slice's Flash component.)

## Non-goals

- No focus-trap/modal work (the app has no modals in admin).
- No public-app changes; no automated axe CI gate (worth a future slice if desired).
- No keyboard-shortcut system.

## Testing

Component tests: Tooltip shows its content on focus (not just hover) and hides on blur/Escape; login renders labels associated with inputs (`getByLabelText`); a spot-check test that a representative action button has the shared style applied. Contrast values asserted once in a small unit test over the shared style constants (guards regressions).

## Acceptance

A keyboard-only user can reach and read every tooltip in the admin UI; a screen reader announces labeled login/user fields and column headers correctly; action controls look like buttons; no admin text sits below AA contrast.
