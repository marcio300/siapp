# SIAPP Brand & UI tokens

Source: the logo (bold grotesque "sorry" with a detached comma, italic serif "it's a private party",
cream on bright red). The platform does not run on bright red; red is an accent.

## Colours

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#141414` | App background (dark default). |
| `--bg-elevated` | `#1E1E1E` | Cards, sheets. |
| `--ink` | `#F3EBDD` | Primary text (the logo's cream). |
| `--ink-muted` | `#B7B0A3` | Secondary text. |
| `--red` | `#FF1E00` | Primary CTA, active states, the key icon, the comma. Never as a surface larger than a button. |
| `--red-soft` | `#FF6A4D` | Hover/pressed on red, badges ("private sale"). |
| `--line` | `#2A2A2A` | Borders, dividers. |
| `--ok` | `#3DDC97` | Scanner OK, success. |
| `--warn` | `#FFB020` | Window closing, keys expiring. |
| `--danger` | `--red` | Reuse red; don't add a second red. |

Light theme for backoffice/scanner is acceptable: `--bg #F3EBDD`, `--ink #141414`, same red.
Scanner result screens may flood the whole screen (`--ok` green / `--red`) for at-a-glance reading.

## Type

- Display / headings: a heavy grotesque with tight tracking (e.g. **Archivo Black** or **Bricolage
  Grotesque 800**), lowercase where the logo is lowercase.
- Editorial accents (taglines, empty states, one-liners): an italic serif (e.g. **Instrument Serif
  Italic** or **Fraunces Italic**).
- UI body: **Inter** or the system stack.
- Pairing rule: grotesque for the "no", serif italic for the "but". Example empty state:
  **sorry,** *nothing tonight — check tomorrow.*

## The key

Keys are the unit. Icon: a simple, chunky key glyph in `--red` (custom SVG, 2 weights: 16 and 24px).
Format everywhere as `<key-icon> 50`, never "50 credits". Wallet headline: `<key-icon> 120` with the
sub-line *80 plan keys expire 30 Nov · 40 purchased*. Keep the comma as a secondary motif (loading
state, app icon alternative).

## Voice

Dry, confident, a little cheeky, never sarcastic at the member's expense. Short sentences. The door
says "sorry"; the key is the answer. Examples: "You're in." / "Sorry, this one opens to Plus members
first — 23h to go." / "No keys left this month. Top up, or wait for Friday."

## Components to standardise early (shadcn-based)

Key badge, offer card (type, cost, allocation state, private-sale pill), ticket card (QR, photo, +1),
wallet pools panel, scanner result screen, eligibility explanation line.
