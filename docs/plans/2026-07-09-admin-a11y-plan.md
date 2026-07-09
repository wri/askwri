# Admin Accessibility Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Work ONLY in /Users/gutelius/Documents/GitHub/askwrimvp on branch qa-wip-david — do NOT create a git worktree** (the branch depends on gitignored state: `search-service/data/`, `search-service/venv/`, `.env.local` files, `/tmp/askWRI_docs` symlink — none of which follow into a worktree).

## ⚠️ SEQUENCING — THIS PLAN EXECUTES LAST OF THE CURRENT BATCH

This slice **sweeps files that the other three in-flight slices modify** (feedback-layer, upload-journey, table-ergonomics). It MUST land **after** all three are merged. It intentionally audits the *final* state of every admin page.

Concretely, do not start until these have landed and are present in `src/app/admin`:

- **feedback-layer** → a shared `Flash` (aria-live notice) component; replaces the ad-hoc `notice`/`error` `<Text>` blocks (e.g. `users/page.tsx:107-108`, `review/page.tsx`). §5's "aria-live on notices is delivered by the Flash component" depends on it — do NOT add aria-live yourself.
- **upload-journey** → a dropzone surface on the upload page; may introduce new buttons/links.
- **table-ergonomics** → sortable column headers; these change `<th>` markup, which §5 (`scope='col'`) must cooperate with, and may add new underlined sort controls.

**The underline-site decision table below is "as of spec time." RE-GREP at implementation** (`grep -rn "textDecoration: 'underline'" src/app/admin`) **and fold in every new site introduced by the intervening slices** (Flash component, dropzone, sortable headers). Apply the same keep-as-link / convert-to-button judgment to each new site. The counts here (41 underline sites, 14 `#888` sites) are a spec-time snapshot, not a target.

---

**Goal:** Make the admin UI keyboard-, touch-, and screen-reader-accessible via mechanical, checkable fixes (no redesign): reachable tooltips, real action buttons, labeled login/user forms, AA-contrast secondary text, and scoped table headers. Per `docs/superpowers/specs/2026-07-09-admin-a11y-design.md`.

**Architecture:** Four dependency-ordered, TDD tasks. Task 1 (Tooltip upgrade + tests) and Task 2 (shared `buttonStyles` + underline sweep) are the load-bearing pieces; Task 3 (form labels + `#888`→`#595959` contrast sweep + table `scope` + contrast unit test) is broad but mechanical; Task 4 is a verification sweep. Inline-style-first (repo convention); one shared CSS class only for `:hover`/`:focus-visible` (not expressible inline). Frequent conventional commits, grouped by concern.

**Tech Stack:** Next.js 16 App Router (client components, `'use client'`), React (`useId`/`useState`), inline `React.CSSProperties` styles, Chakra only where already present (`Box`/`Text`/`Heading`). Tests: Jest (jsdom) + `@testing-library/react` (`render`, `screen`, `fireEvent`, `getByLabelText`, `getByRole`). **`@testing-library/user-event` is NOT installed — use `fireEvent`.**

**Spec (authoritative):** `docs/superpowers/specs/2026-07-09-admin-a11y-design.md`. Read it before starting. Do not exceed it (no focus-traps, no axe CI, no public-app changes, no keyboard-shortcut system).

---

## Context for the implementer

### Repo rules (from CLAUDE.md + global rules — verbatim, non-negotiable)

- **React components are arrow functions** assigned to a const with a named `export` + `export default` (see every file in `src/app/admin`). Do NOT use `function` declarations — there is a `react/function-component-definition` lint rule (commit `3bc01ad` converted Tooltip to arrow form specifically for it).
- **Inline styles** (`style={{…}}` / `React.CSSProperties` constants) are the admin convention. Do not introduce CSS modules, Tailwind, or styled-components. The ONE exception this plan allows: a single global `.admin-btn` rule in `src/app/globals.css` for `:hover`/`:focus-visible` (pseudo-classes cannot be inlined).
- **Prettier before every commit.** Run `npm run format` (or `npx prettier --write <files>`) then `npm run format:check`. CI enforces it.
- **NEVER add `Co-Authored-By` trailers** to commits (global rule + project memory). Not in commits, not in subagent prompts.
- **Bash hygiene:** one command per call; no `&&`/`;`/`|` chains; no `2>/dev/null`; export env vars in a separate call. Stage files explicitly — never `git add -A` / `git commit -am`. Never stage `package-lock.json`.
- **Migrations / DB / `/query` contract:** untouched by this slice (UI-only).

### Verified facts (file:line — confirmed by reading, spec-time state)

- **Tooltip today** (`src/app/admin/components/Tooltip.tsx:13-29`): arrow component; renders a `<span title={help} style={{cursor:'help', borderBottom:'1px dotted #999'}}>` wrapping `{children}` + a `<span style={{color:'#888', marginLeft:3, fontSize:'0.8em'}}>?</span>` (line 25). **No JS state, no focusable trigger** — native `title` only (unreachable by keyboard/touch).
- **Tooltip call sites** (all pass PLAIN TEXT children, never interactive nodes — the upgrade must preserve this contract): `review/page.tsx`, `documents/[id]/page.tsx`, `collections/page.tsx`, `upload/page.tsx` (`grep -rln Tooltip src/app/admin`).
- **Existing test** `src/__tests__/admin-tooltip.test.tsx` (31 lines): 3 tests — "renders trigger text", "exposes help via **title attribute**" (line 11-22), "renders ? marker". The **title-attribute test will break** (title is dropped per §1) → must be replaced with focus/blur/Escape + `role='tooltip'` assertions.
- **`#888` sites — 14 total** (`grep -rn "#888" src/app/admin`): `collections/page.tsx:127`; `Tooltip.tsx:25` (the "?" marker — see collision note below); `documents/[id]/page.tsx:958,1021,1038,1102`; `documents/page.tsx:346`; `import/page.tsx:212,415,451`; `layout.tsx:149`; `review/page.tsx:181,517`; `tags/page.tsx:163`.
- **`textDecoration: 'underline'` sites — 41 total** across 9 files (`grep -rn "textDecoration: 'underline'" src/app/admin`). Full keep/convert table in Task 2.
- **StatusChip** (`src/app/admin/components/StatusChip.tsx:7-42`): exports `STATUS_META` (importable by the contrast test). fg/bg pairs listed in Task 3.
- **Provenance badges** (`src/app/admin/documents/[id]/page.tsx:112-119`): `PROVENANCE_BADGE` is a **module-local const, NOT exported**. Task 3 extracts it to a shared module so the contrast test can import it.
- **Login form** (`src/app/admin/login/page.tsx:48-71`): two placeholder-only `<input>`s (Username / Password), no `<label>`.
- **Users create form** (`src/app/admin/users/page.tsx:168-207`): three placeholder-only `<input>`s (Username / Email / Password), no `<label>`; the user table (`110-119`) uses `<th>` WITHOUT `scope`.
- **`src/app/globals.css` exists** and is the place for the single `.admin-btn` hover rule.
- **`@testing-library/user-event` is NOT in package.json** (`@testing-library/react` `^16.3.2`, `dom` `^10.4.1`, `jest-dom` `6.9.1` are).

### The §1↔§4 collision on Tooltip.tsx (from spec-reviewer — read this)

The blanket `#888`→`#595959` sweep (§4, Task 3) would *also* rewrite the `?`-marker color at `Tooltip.tsx:25`. That is **benign** but would make Task 1 and Task 3 both touch the same line and confusingly collide. **Resolution:** Task 1 rewrites `Tooltip.tsx` wholesale and sets the marker to `#595959` directly. By the time Task 3's `#888` sweep runs, `Tooltip.tsx` contains **no `#888`** — the sweep simply finds nothing there. When you re-grep `#888` in Task 3, `Tooltip.tsx:25` should already be gone; if it still shows `#888`, Task 1 was not completed — fix Task 1, don't patch it in the sweep.

---

## Task 1 — Reachable Tooltip (upgrade in place) + tests

**Goal:** Same `<Tooltip help='…'>label</Tooltip>` API; trigger becomes a focusable `<button>`; help becomes a `role='tooltip'` popover shown on hover AND focus AND tap, dismissed on blur/Escape; native `title` dropped. No call-site changes.

### 1a. Write the failing test first (TDD)

Replace `src/__tests__/admin-tooltip.test.tsx` entirely:

```tsx
/** @jest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react'
import { Tooltip } from '@/app/admin/components/Tooltip'

describe('Tooltip component', () => {
  it('renders its trigger text and a discoverable ? marker', () => {
    const { container } = render(
      <Tooltip help='The authors as listed in the source CSV.'>Authors</Tooltip>,
    )
    expect(screen.getByText('Authors')).toBeTruthy()
    expect(container.textContent).toContain('?')
  })

  it('exposes the trigger as a real button that describes itself via the tooltip', () => {
    render(<Tooltip help='The DOI link.'>DOI</Tooltip>)
    const trigger = screen.getByRole('button')
    const described = trigger.getAttribute('aria-describedby')
    expect(described).toBeTruthy()
    const tip = document.getElementById(described as string)
    expect(tip?.getAttribute('role')).toBe('tooltip')
    expect(tip?.textContent).toBe('The DOI link.')
  })

  it('does NOT use a native title attribute (it double-announces)', () => {
    const { container } = render(<Tooltip help='No title here.'>Date</Tooltip>)
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('shows the tooltip on focus and hides it on blur', () => {
    render(<Tooltip help='Shown on keyboard focus.'>Field</Tooltip>)
    const trigger = screen.getByRole('button')
    const tip = document.getElementById(
      trigger.getAttribute('aria-describedby') as string,
    ) as HTMLElement
    expect(tip.style.display).toBe('none')
    fireEvent.focus(trigger)
    expect(tip.style.display).toBe('block')
    fireEvent.blur(trigger)
    expect(tip.style.display).toBe('none')
  })

  it('shows the tooltip on hover and hides it on mouse leave', () => {
    render(<Tooltip help='Shown on hover.'>Field</Tooltip>)
    const trigger = screen.getByRole('button')
    const tip = document.getElementById(
      trigger.getAttribute('aria-describedby') as string,
    ) as HTMLElement
    fireEvent.mouseEnter(trigger)
    expect(tip.style.display).toBe('block')
    fireEvent.mouseLeave(trigger)
    expect(tip.style.display).toBe('none')
  })

  it('toggles on tap/click and dismisses on Escape', () => {
    render(<Tooltip help='Tap to toggle.'>Field</Tooltip>)
    const trigger = screen.getByRole('button')
    const tip = document.getElementById(
      trigger.getAttribute('aria-describedby') as string,
    ) as HTMLElement
    fireEvent.click(trigger)
    expect(tip.style.display).toBe('block')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(tip.style.display).toBe('none')
  })
})
```

Run it — it MUST fail (old component has no button/role/state):

```
npx jest src/__tests__/admin-tooltip.test.tsx
```

### 1b. Implement — replace `src/app/admin/components/Tooltip.tsx` entirely

```tsx
'use client'

import { useId, useState } from 'react'

/**
 * Tooltip / HelpHint — an inline help marker with a keyboard-, touch-, and
 * screen-reader-reachable tooltip.
 *
 * Same API as before: <Tooltip help='…'>label</Tooltip>. The trigger is a real
 * <button> (natively focusable — no tabIndex, no role) wrapping ONLY the label
 * text + a "?" marker. The help text is a role='tooltip' popover, shown on
 * hover, focus, and tap (click toggles for touch), dismissed on blur/Escape.
 * Per WAI-ARIA tooltip guidance. The native `title` is intentionally dropped
 * (it double-announces). children MUST be plain text — never interactive nodes.
 */
export const Tooltip = ({
  help,
  children,
}: {
  help: string
  children: React.ReactNode
}) => {
  const id = useId()
  const [open, setOpen] = useState(false)

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type='button'
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        style={{
          font: 'inherit',
          color: 'inherit',
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'help',
          borderBottom: '1px dotted #999',
        }}
      >
        {children}
        <span style={{ color: '#595959', marginLeft: 3, fontSize: '0.8em' }}>
          ?
        </span>
      </button>
      <span
        role='tooltip'
        id={id}
        style={{
          position: 'absolute',
          left: 0,
          top: '100%',
          marginTop: 4,
          zIndex: 10,
          display: open ? 'block' : 'none',
          background: '#1a202c',
          color: '#fff',
          padding: '6px 10px',
          borderRadius: 4,
          fontSize: 13,
          fontWeight: 400,
          lineHeight: 1.4,
          width: 'max-content',
          maxWidth: 280,
          whiteSpace: 'normal',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
      >
        {help}
      </span>
    </span>
  )
}

export default Tooltip
```

Notes:
- `display: open ? 'block' : 'none'` — `onFocus` sets `open` synchronously, so by the time a screen reader reads the focused button the `role='tooltip'` target is in the a11y tree (standard APG behavior).
- The `?` marker is `#595959` from the start (resolves the §1↔§4 collision — see above).
- Trigger keeps `borderBottom: 1px dotted #999` + `cursor:'help'` so it renders visually like the old inline span.

### 1c. Verify + commit

```
npx jest src/__tests__/admin-tooltip.test.tsx
```
```
npx prettier --write src/app/admin/components/Tooltip.tsx src/__tests__/admin-tooltip.test.tsx
```
```
git add src/app/admin/components/Tooltip.tsx src/__tests__/admin-tooltip.test.tsx
```
```
git commit -m "feat(admin-a11y): keyboard/touch-reachable Tooltip (button trigger + role=tooltip popover)"
```

---

## Task 2 — Shared `buttonStyles` + underline→button sweep

**Goal:** Give action controls a real button treatment; leave navigation as styled links. Decisions are pre-judged in the table below — apply it verbatim (after re-grepping for new sites).

### 2a. Create `src/app/admin/lib/buttonStyles.ts`

```ts
import type { CSSProperties } from 'react'

/**
 * Shared inline-style constants giving admin action controls a real button
 * treatment (border, padding, radius) instead of bare underlined text.
 *
 * - `actionButton` — ordinary actions (Save, Promote, Add, pagination, …).
 * - `dangerButton` — destructive actions (Delete).
 *
 * Apply alongside className='admin-btn' so :hover / :focus-visible (which
 * cannot be inlined) come from the single rule in src/app/globals.css.
 * Controls that GO somewhere (navigation) stay styled <Link>/<a>, not buttons.
 */
export const actionButton: CSSProperties = {
  font: 'inherit',
  background: '#fff',
  color: '#1a365d',
  border: '1px solid #cbd5e0',
  borderRadius: 4,
  padding: '4px 10px',
  cursor: 'pointer',
  lineHeight: 1.4,
}

export const dangerButton: CSSProperties = {
  ...actionButton,
  color: '#C11101',
  borderColor: '#f0b4b4',
}
```

Contrast (asserted in Task 3's test): `#1a365d`-on-`#fff` ≈ 12:1; `#C11101`-on-`#fff` ≈ 6.3:1 — both pass AA.

### 2b. Add the ONE hover/focus rule to `src/app/globals.css`

```css
.admin-btn:hover:not(:disabled) {
  background: #f0f4f8;
}
.admin-btn:focus-visible {
  outline: 2px solid #1a365d;
  outline-offset: 1px;
}
```

At each converted site, add `className='admin-btn'` next to `style={actionButton}` / `style={dangerButton}`. Where a site had extra inline props (e.g. `marginRight: 8`, `color:'#C11101'`), spread the constant and keep the layout prop: `style={{ ...actionButton, marginRight: 8 }}`.

### 2c. Underline-site decision table (as of spec time — RE-GREP and extend)

Legend: **BUTTON** = action, convert to `actionButton`. **DANGER** = destructive, `dangerButton`. **LINK** = navigates/downloads, keep link styling (leave `textDecoration:'underline'` as-is). **DARK** = sits on a dark background (nav/review bar) — `actionButton`'s white-bg palette is wrong; give it the dark-bar variant instead (see note under table). Do NOT restyle a LINK as a button.

| File | Line | Element | Label / action | Decision |
|---|---|---|---|---|
| collections/page.tsx | 136 | `<button>` | Save (rename) | BUTTON |
| collections/page.tsx | 140 | `<button>` | Cancel | BUTTON |
| collections/page.tsx | 148 | `<button>` | Rename (startEdit) | BUTTON |
| collections/page.tsx | 154 | `<Link>` | → filtered documents | **LINK** |
| collections/page.tsx | 194 | `<button type=submit>` | Create collection | BUTTON |
| components/ReviewBar.tsx | 94 | `btn` const (4 buttons) | Prev/Promote/Re-ingest/Skip | **DARK** |
| documents/[id]/page.tsx | 553 | `<button>` | Promote to searchable | BUTTON |
| documents/[id]/page.tsx | 563 | `<button>` | Restore | BUTTON |
| documents/[id]/page.tsx | 581 | `<button>` | Withdraw (reversible) | BUTTON |
| documents/[id]/page.tsx | 590 | `<button>` | Re-ingest | BUTTON |
| documents/[id]/page.tsx | 599 | `<a target=_blank>` | Open stored PDF | **LINK** |
| documents/[id]/page.tsx | 608 | `<button>` (`color:#C11101`) | Delete (permanent) | DANGER |
| documents/[id]/page.tsx | 721 | `<button>` | Save metadata | BUTTON |
| documents/[id]/page.tsx | 765 | `<button>` | Keep tag (accept) | BUTTON |
| documents/[id]/page.tsx | 774 | `<button>` | Reject tag suggestion | BUTTON |
| documents/[id]/page.tsx | 785 | `<button>` | Accept tag | BUTTON |
| documents/[id]/page.tsx | 820 | `<button>` | Add tag | BUTTON |
| documents/[id]/page.tsx | 883 | `<button>` | (summary action) | BUTTON |
| documents/[id]/page.tsx | 963 | `<button>` | Remove from collection | BUTTON |
| documents/[id]/page.tsx | 989 | `<button>` | Add to collection | BUTTON |
| documents/[id]/page.tsx | 1115 | `<button>` | Load more history | BUTTON |
| documents/page.tsx | 340 | `<button>` | Add to collection (bulk) | BUTTON |
| documents/page.tsx | 398 | `<Link>` | → document detail | **LINK** |
| documents/page.tsx | 430 | `<button>` | Prev page | BUTTON |
| documents/page.tsx | 444 | `<button>` | Next page | BUTTON |
| import/page.tsx | 242 | `<a href=…/template>` | Download CSV template | **LINK** |
| layout.tsx | 130 | `<button>` (`color:#cbd5e0`) | Log out (on dark nav) | **DARK** |
| layout.tsx | 152 | `<Link>` | Admin Guide | **LINK** |
| layout.tsx | 158 | `<a href=github>` | AskWRI repo | **LINK** |
| review/page.tsx | 376 | `<button>` | Bulk promote | BUTTON |
| review/page.tsx | 384 | `<button>` | Bulk re-ingest | BUTTON |
| review/page.tsx | 398 | `<Link>` | Start review (first doc) | **LINK** |
| review/page.tsx | 469 | `<Link>` | → document detail | **LINK** |
| review/page.tsx | 498 | `<button>` | Promote | BUTTON |
| review/page.tsx | 506 | `<button>` | Re-ingest | BUTTON |
| tags/page.tsx | 253 | `<button>` | Save (rename) | BUTTON |
| tags/page.tsx | 260 | `<button>` | Cancel | BUTTON |
| tags/page.tsx | 271 | `<button>` | Rename (startRename) | BUTTON |
| tags/page.tsx | 282 | `<button>` (`color:#C11101`) | Delete tag | DANGER |
| tags/page.tsx | 357 | `<button type=submit>` | Add tag | BUTTON |
| upload/page.tsx | 179 | `<Link>` | → Review queue | **LINK** |

Tally (spec-time): **32 convert-to-button** (30 `actionButton` + 2 `dangerButton`: doc[id]:608, tags:282), **9 keep-as-link**, **2 DARK groups** (ReviewBar `btn`, layout logout). = 41 sites + the two DARK groups counted once each. **Re-grep before starting; any new site the intervening slices added gets the same treatment (sort controls → BUTTON; new nav/download → LINK).**

**DARK-background variant.** `ReviewBar.tsx:92-96` `btn` (white text on the dark review bar) and `layout.tsx:126-136` logout (light text on dark nav) must NOT take `actionButton` (white bg = invisible/clashing). Give them a bordered treatment that keeps the light foreground:

```ts
// local to ReviewBar.tsx — replaces the current `btn` const
const btn: React.CSSProperties = {
  font: 'inherit',
  color: '#fff',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.55)',
  borderRadius: 4,
  padding: '3px 10px',
  cursor: 'pointer',
}
```

For `layout.tsx` logout, do the same inline (keep `color:'#cbd5e0'`, drop `textDecoration`, add the border/padding/radius). These stay inline (they need bespoke colors); do NOT add them to `buttonStyles.ts`.

### 2d. Execute the sweep in grouped commits

Do one file (or a couple of closely related files) per edit batch, then Prettier, then commit. Suggested grouping:

1. `buttonStyles.ts` + `globals.css` (foundation) — commit alone.
2. `collections/page.tsx`, `tags/page.tsx` (CRUD list pages).
3. `documents/[id]/page.tsx` (largest — many actions incl. 1 danger).
4. `documents/page.tsx`, `review/page.tsx` (list + queue, incl. pagination + bulk).
5. `components/ReviewBar.tsx`, `layout.tsx` (DARK variants) + `upload/page.tsx`/`import/page.tsx` (LINK-only files need no change unless a new site appeared — verify).

For each: leave every **LINK** row exactly as-is. Convert every **BUTTON**/**DANGER** row to the shared constant + `className='admin-btn'`, preserving any layout-only inline props via spread.

Commit messages (per group):

```
git commit -m "feat(admin-a11y): shared actionButton/dangerButton styles + hover rule"
```
```
git commit -m "refactor(admin-a11y): real buttons for collections/tags action controls"
```
```
git commit -m "refactor(admin-a11y): real buttons for document detail action controls"
```
```
git commit -m "refactor(admin-a11y): real buttons for documents list + review queue"
```
```
git commit -m "refactor(admin-a11y): dark-bar button variants for ReviewBar + logout"
```

Run the full admin suite after the sweep (existing page tests assert on button behavior/labels — make sure nothing broke):

```
npx jest src/__tests__/admin-
```

---

## Task 3 — Form labels + contrast sweep + table scope + contrast test

### 3a. `#888` → `#595959` contrast sweep (§4)

Re-grep first: `grep -rn "#888" src/app/admin`. `Tooltip.tsx:25` should already be gone (Task 1). Replace `#888` with `#595959` at all remaining sites (13 spec-time: collections:127; documents/[id]:958,1021,1038,1102; documents:346; import:212,415,451; layout:149; review:181,517; tags:163). `#595959`-on-white ≈ 7.1:1 (comfortably AA). Pure find/replace within each file (the token is unambiguous — always a `color` value). Note `import/page.tsx:212` is a status-color map value (`skipped: '#888'`) — still just a display color, bump it too.

### 3b. Extract `PROVENANCE_BADGE` to a shared module (needed by the contrast test)

`PROVENANCE_BADGE` is currently a non-exported const at `documents/[id]/page.tsx:112-119`. Move it to `src/app/admin/lib/provenance.ts`:

```ts
export const PROVENANCE_BADGE: Record<
  string,
  { text: string; color: string; bg: string }
> = {
  human: { text: 'person', color: '#0A6640', bg: '#e4f2ea' },
  external: { text: 'imported', color: '#0050C8', bg: '#e6f0ff' },
  llm: { text: 'AI', color: '#B7791F', bg: '#fdf3e0' },
}
```

Then in `documents/[id]/page.tsx` delete the local const and add `import { PROVENANCE_BADGE } from '@/app/admin/lib/provenance'`. (`STATUS_META` is already exported from `StatusChip.tsx` — no move needed.)

### 3c. Contrast unit test (§4 + Testing) — write `src/__tests__/admin-contrast.test.ts`

Self-contained WCAG relative-luminance/contrast helper; asserts every fg/bg pair ≥ 4.5:1, plus the two shared button-text colors on white.

```ts
import { actionButton, dangerButton } from '@/app/admin/lib/buttonStyles'
import { STATUS_META } from '@/app/admin/components/StatusChip'
import { PROVENANCE_BADGE } from '@/app/admin/lib/provenance'

// WCAG 2.x relative luminance + contrast ratio.
const channel = (v: number) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
const contrast = (fg: string, bg: string) => {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const AA = 4.5

describe('admin colour contrast meets WCAG AA (>= 4.5:1)', () => {
  it('shared button text on white', () => {
    expect(contrast(actionButton.color as string, '#fff')).toBeGreaterThanOrEqual(AA)
    expect(contrast(dangerButton.color as string, '#fff')).toBeGreaterThanOrEqual(AA)
  })

  it('secondary text colour on white', () => {
    expect(contrast('#595959', '#fff')).toBeGreaterThanOrEqual(AA)
  })

  it.each(Object.entries(STATUS_META))('StatusChip %s', (_status, meta) => {
    expect(contrast(meta.color, meta.bg)).toBeGreaterThanOrEqual(AA)
  })

  it.each(Object.entries(PROVENANCE_BADGE))('provenance badge %s', (_src, badge) => {
    expect(contrast(badge.color, badge.bg)).toBeGreaterThanOrEqual(AA)
  })
})
```

**KNOWN FAILURE — expected and required.** The amber `#B7791F` on tint `#fdf3e0` computes to **≈ 3.30:1** (verified by hand with the formula above). It appears in TWO pairs: `STATUS_META.needs_review` and `PROVENANCE_BADGE.llm`. The test will fail on both until you darken the amber. Per §4 ("darkened only if any fail 4.5:1"), darken it in BOTH places to a value the test accepts. Recommended: **`#8a5a15`** (≈ 5.4:1 on `#fdf3e0` — safe margin) or the lighter-but-still-passing `#96601a` (≈ 4.8:1). Let the test drive the exact value; change `STATUS_META.needs_review.color` (in `StatusChip.tsx`) and `PROVENANCE_BADGE.llm.color` (in `provenance.ts`) together. All other pairs pass unchanged (`#555`/`#eee` ≈ 6.4; `#0050C8`/`#e6f0ff` ≈ 6.1; `#0A6640`/`#e4f2ea` ≈ 6.1; `#C11101`/`#fdeaea` ≈ 5.5).

### 3d. Login form labels (§3) — `src/app/admin/login/page.tsx:48-71`

Add visible `<label htmlFor>` above each input; give each input an `id`; placeholder becomes a hint only (or drop it). Example for the two fields:

```tsx
<form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
  <label htmlFor='login-username' style={{ fontSize: 14, fontWeight: 600 }}>
    Username
  </label>
  <input
    id='login-username'
    value={username}
    onChange={(e) => setUsername(e.target.value)}
    autoFocus
    style={{ padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
  />
  <label htmlFor='login-password' style={{ fontSize: 14, fontWeight: 600 }}>
    Password
  </label>
  <input
    id='login-password'
    type='password'
    value={password}
    onChange={(e) => setPassword(e.target.value)}
    style={{ padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
  />
  {/* submit button unchanged */}
</form>
```

### 3e. Users create form labels (§3) — `src/app/admin/users/page.tsx:168-207`

Same treatment for Username / Email / Password (and the role `<select>` — give it `<label htmlFor='new-user-role'>` + `id`). The form is `flex-wrap` row today; to keep labels associated without a big layout change, wrap each field in a `<div style={{ display:'flex', flexDirection:'column' }}>` holding its label+input (label above input). Placeholders become hints or are removed. IDs: `new-user-username`, `new-user-email`, `new-user-password`, `new-user-role`.

### 3f. Table `scope='col'` (§5)

Add `scope='col'` to every admin data-table header cell. **Coordinate with the table-ergonomics slice** — if it turned `<th>` into sortable buttons/components, add `scope='col'` on the `<th>` itself (the `scope` belongs on the cell, not the inner button). Spec-time known table: `users/page.tsx:113-117` (`<th>` in the `.map`). Re-grep `<th` across `src/app/admin` and cover every one (documents, review, tags, collections, import, documents/[id] sub-tables). Header cells only — never `scope` on `<td>`.

### 3g. Form-label + contrast tests

Add to a suitable admin test (or a small new `src/__tests__/admin-login.test.tsx`) a `getByLabelText` assertion proving the login inputs are associated:

```tsx
/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react'
import LoginPage from '@/app/admin/login/page'

it('login inputs are associated with visible labels', () => {
  render(<LoginPage />)
  expect(screen.getByLabelText('Username')).toBeTruthy()
  expect(screen.getByLabelText('Password')).toBeTruthy()
})
```

(If rendering `LoginPage` needs router/searchParams mocks that jsdom lacks, mock `next/navigation` as the existing admin page tests do — check `admin-review-page.test.tsx` for the established mock pattern rather than inventing one.)

### 3h. Verify + commit (grouped)

```
npx jest src/__tests__/admin-contrast.test.ts
```
```
npx jest src/__tests__/admin-
```
```
npx prettier --write "src/app/admin/**/*.{ts,tsx}" "src/__tests__/admin-*.{ts,tsx}" src/app/globals.css
```
```
git commit -m "fix(admin-a11y): bump #888 secondary text to #595959 (AA) + darken amber badge"
```
```
git commit -m "feat(admin-a11y): labeled login/user forms + scope=col table headers"
```
```
git commit -m "test(admin-a11y): durable WCAG contrast assertions over shared colours + badges"
```

---

## Task 4 — Verification sweep

- [ ] Re-grep confirms **zero** un-converted action buttons: `grep -rn "textDecoration: 'underline'" src/app/admin` — every remaining hit is a **LINK** row (Link/anchor that navigates) or a newly-appeared site you've judged. No `<button …textDecoration:'underline'…>` remains.
- [ ] Re-grep confirms **zero** `#888` in `src/app/admin`: `grep -rn "#888" src/app/admin` returns nothing.
- [ ] Every admin `<th>` has `scope='col'`: `grep -rn "<th" src/app/admin` — spot-check each.
- [ ] No native `title` on the Tooltip component: `grep -n "title" src/app/admin/components/Tooltip.tsx` returns nothing.
- [ ] Full admin test suite green: `npx jest src/__tests__/admin-`.
- [ ] Contrast test green (amber darkened): `npx jest src/__tests__/admin-contrast.test.ts`.
- [ ] Lint + format: `npm run lint` then `npm run format:check`.
- [ ] Local build sanity: `npx next build --webpack` (Turbopack panics on the venv symlink — do NOT use it).
- [ ] **Manual keyboard pass** (acceptance criterion): Tab through one page with tooltips (e.g. `documents/[id]`) — each `?` trigger receives focus and reveals its `role='tooltip'` popover; Escape dismisses; action controls read as buttons; login/users fields announce their labels. Drive with the `run`/`verify` skill or the browser if available.

Final commit if anything was touched during verification:

```
git commit -m "chore(admin-a11y): verification-pass fixups"
```

---

## DRY / YAGNI guardrails

- One `buttonStyles.ts` (2 constants) + one `.admin-btn` CSS rule — do NOT create per-page style helpers or a `<Button>` component (spec is inline-style-first, mechanical).
- Do NOT add aria-live anywhere — that ships with the feedback-layer Flash component (§5).
- Do NOT touch retrieval, `/query`, migrations, the public app, or add axe/CI gates or focus-traps (explicit non-goals).
- Extract `PROVENANCE_BADGE` only because the durable contrast test needs to import it — no other refactors.
- Commit frequently, grouped by concern (as above); Prettier before every commit; never a `Co-Authored-By` trailer.
