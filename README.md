# Property Tool website

Mobile-friendly website version of the **Property Search** part of the PBEA Chrome extension.

It deliberately does **not** include Sales Progression, reminders, email templates, launches or any other extension-only tools.

## What is included

- Address search with the same property-number/postcode fallbacks used by the extension.
- GOV.UK EPC matching for rating, floor area, property type and tenure where available.
- HM Land Registry sold-price history and recent local comparables.
- Current Rightmove postcode listings as a market cross-check.
- Rightmove-link mode. The server-side reader tries the normal Rightmove sold-history address match first; if that cannot identify the address it can use the safe EPC fallback and will not guess between ambiguous matches.
- Mobile-first valuation results with evidence and comparable sales.

## Hosting

This is not a GitHub-Pages-only static site because browsers block several of the cross-site requests that the Chrome extension is allowed to make.

Use **Cloudflare Pages** with this GitHub repository:

1. In Cloudflare, create a Pages project and connect this repository.
2. Use the repository root as the output directory. No build command is required.
3. Deploy.

The root `_worker.js` file is Cloudflare Pages Advanced Mode. It serves the static site and provides same-origin `/api/` endpoints for the public property-data requests.

## Files

- `index.html` – website UI
- `styles.css` – responsive styling
- `app.js` – property search, EPC/Land Registry/Rightmove evidence and valuation UI
- `_worker.js` – same-origin proxy plus the Rightmove listing/address reader

The Chrome extension code is separate and is not modified by this website.
