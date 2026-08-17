# Relay website design guidelines

_Generated: 2026-08-17_

## Design direction

Industrial signal switchboard: precise, tactile, and operational without looking
like a generic dark developer tool. The interface uses the physical idea of a
message travelling between two endpoints.

## Color palette

- **Carbon** `#1B241B` — primary text, controls, dark surfaces
- **Paper** `#F6F4DF` — main canvas
- **Paper deep** `#E6E7BD` — structure and secondary surfaces
- **Signal orange** `#FF5A2F` — routing, active actions, focus
- **Marigold** `#FFD34E` — acknowledgement and secondary emphasis
- **Celery** `#D9EF75` — healthy/available state
- **Moss** `#607842` — quiet status accents

The palette intentionally avoids purple and blue. Carbon maintains strong text
contrast, while the three signal colors encode motion, acknowledgement, and
health.

## Typography

- **Display:** Archivo Black, used only for theses and major section headings
- **Body:** Familjen Grotesk, used for readable product copy and controls
- **Utility:** IBM Plex Mono, used for commands, task metadata, and system labels

Headings use tight tracking and short measures. Body copy stays below roughly 70
characters per line.

## Layout

The maximum content width is 1180px with 20px desktop edge gutters and 14px
mobile gutters. Large statements use generous negative space. Operational
content uses borders and aligned rails instead of a repeated rounded-card grid.

The hero is asymmetrical: product thesis on the left and a working handoff model
on the right. Below it, content moves from the three-step workflow to product
details, principles, setup, and source.

## Signature element

The interactive handoff board visualizes one request moving from a client
channel to an engineering card and back. Its four states—triage, claimed,
working, and done—use real Relay vocabulary rather than decorative animation.

## Components and interaction

- Primary buttons use carbon with a hard orange offset shadow.
- Secondary buttons use the paper surface and turn marigold on hover.
- Feature cards use one clipped corner and subtle vertical movement.
- Scroll reveals use opacity and transform only, with a 550ms ease-out.
- Hover/focus transitions stay between 180ms and 350ms.
- Reduced-motion preferences disable orchestrated movement.
- Focus rings are 3px signal orange with a 4px offset.
- Touch targets are at least 44px.

## Accessibility

Semantic landmarks and heading order are used on every page. The mobile menu
exposes `aria-expanded`; changing demo messages use polite live regions.
Content does not depend on color alone. Pages remain readable without JavaScript,
and keyboard focus remains visible against all surfaces.

## Responsive behavior

- Desktop: asymmetric hero, three-column workflow, two-column feature layouts
- Tablet: hero stacks; trust strip becomes two columns
- Mobile: single-column flow, stacked switchboard panels, full-width actions,
  and a collapsible navigation menu

## Technologies

Plain HTML, CSS, and JavaScript. Google Fonts is the only external presentation
dependency; system fallbacks preserve the layout when it is unavailable.
