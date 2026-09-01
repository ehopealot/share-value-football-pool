---
title: Office Pool Reborn Design
generated-from: final-source-dist-and-screenshots
---

# Office Pool Reborn Design

## Visual direction

Office Pool Reborn is a compact, table-first operating surface for a private football pool. It deliberately uses a late-2000s private sports-site vocabulary: dark masthead, blue ribbon navigation, square table borders, dense rows, orange action controls, and direct text labels instead of dashboard cards or decorative graphics.

## Palette

- Navy masthead: `#002b5c`
- Blue ribbon and secondary actions: `#135a99`
- Orange primary actions: `#c75000`
- White paper surface: `#ffffff`
- Gray table fill: `#e3e6e8`
- Ink: `#151515`
- Structural line: `#6e7780`
- Focus on paper: `#7a2d00`; focus on dark ribbon: `#ffdf7e`

## Typography

The interface uses `Arial, Verdana, sans-serif` with a compact 1.45 line height. Headings are modestly scaled rather than promotional. Links remain underlined and controls retain native-shaped affordances.

## Layout

The site shell is centered and capped at 980px on desktop, with a white paper surface over a pale gray page background. Odds and standings can intentionally use the full available shell width. Narrow screens make the shell fluid, wrap the ribbon, reduce main padding, and place wide tables in horizontal scroll containers rather than forcing document-level overflow.

## Components

The masthead identifies the product; the blue ribbon carries account and pool navigation. Tables use gray headers, square borders, and compact data cells. Forms use labels above controls except where dense slip controls require inline alignment. The Games page uses a two-row event block and a sticky bet slip. Confirmation, error, and state surfaces use direct language and clear action buttons.

## Responsive and accessibility

Visible three-pixel focus outlines cover links, buttons, inputs, and selects. The ribbon uses its light dark-surface focus token. At widths up to 600px, ribbon and action controls have 44px minimum touch targets. Reduced-motion preferences disable transitions and smooth scrolling. Table overflow is localized, keyboard controls remain semantic, and the documented palette meets the tested AA contrast combinations.
