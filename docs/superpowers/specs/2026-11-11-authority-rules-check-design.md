# CDA / RDA society rules check — design

Date: 2026-11-11 · Status: approved in chat, awaiting spec review

## Goal

After the wizard generates alternatives (either generator: spine-and-grid or "Build on the existing roads"), compare
each alternative with the housing-society rules of the authority that controls the site, chosen automatically from
the site's location: **CDA** (Islamabad Capital Territory) or **RDA** (Rawalpindi). Report each rule as ✓/✗ with
its clause and the measured value. Report only: the generators are not changed and plans are not adjusted.

## What the user said vs. assumptions

- Said: compare the analysis with CDA or RDA society rules according to the selected area, chosen automatically.
  Chose: older official texts, labelled as superseded; bundled boundaries for auto-selection.
- Assumed: "compare" = report, not auto-fix. RDA applies the Punjab rules (RDA has no rule set of its own for schemes).
  Rawalpindi is one of the "five City Districts" in Punjab 2010 rule 10(2)(f).

## Rule sources (encoded exactly; each check cites its clause)

**CDA — SRO 64(I)/2020, Revised Modalities & Procedures (2020) under ICT (Zoning) Regulation 1992**, Gazette of
Pakistan Extraordinary Part II, 30 Jan 2020 (http://www.pcp.gov.pk/SiteImage/Downloads/5104(20)Ex%20Gaz-II.pdf).
Superseded by SRO 886(I)/2023 (07-07-2023) per cda.gov.pk/public/housing-schemes; that text was not available.

| Rule | Clause | Zone 2 & 5 | Zone 4 |
|---|---|---|---|
| Scheme area | 1(i); 5B | ≥ 50 acres (202 343 m²) | ≥ 50 acres |
| Residential | 5A(i) / 5B(i) | ≤ 55 % | ≤ 50 % |
| Open / green space / parks | (ii) | ≥ 10 % | ≥ 15 % |
| Roads / streets | (iii) | ≥ 23 % | ≥ 23 % |
| Graveyards | (iv) | ≥ 2 % | ≥ 2 % |
| Commercial | (v) | ≤ 5 % | ≤ 5 % |
| Public buildings | (vi) | ≥ 5 % | ≥ 5 % |
| Vehicular street width | (vii) | ≥ 40 ft (12.19 m); 30 ft (9.14 m) where plots ≤ 130 sq yd | ≥ 40 ft |
| Smallest residential plot | 5A(viii) / 5B(viii) | ≥ 90 sq yd (75.3 m²) | ≥ 130 sq yd (108.7 m²) |
| Economy housing | 5A(viii) / 5B(ix) | ≥ 10 % of residential plot area in plots ≤ 130 sq yd | same |

The gazette notes the percentages "will be subject to minor adjustments" for site conditions; the check states it.

**RDA — Punjab Private Housing Schemes and Land Sub-Division Rules 2010** (13 Mar 2010)
(https://lgcd.punjab.gov.pk/system/files/THE_PUNJAB_PRIVATE_HOUSING_SCHEMES_AND_LAND_SUB_DIVISION_RULES_2010.pdf).
RDA now applies the Punjab Development Authorities Private Housing Schemes Rules 2021 (amended 08-07-2026,
rda.gop.pk/downloads); that text was not available.

| Rule | Clause | Limit |
|---|---|---|
| Scheme area | 6(b)(iii) | ≥ 100 kanal (marla = 272 sq ft outside Lahore → 50 586 m²) |
| Access road | 6(b)(i), 10(2)(f) | ≥ 60 ft (18.29 m) in City Districts |
| Open space / park | 10(2)(a) | ≥ 7 % |
| Graveyard | 10(2)(b) | ≥ 2 % |
| Commercial | 10(2)(c) | fixed 5 % (checked as 4.5–5.5 %) |
| Public buildings | 10(2)(d) | 5–10 % |
| Largest residential plot | 10(2)(e) | ≤ 1 000 sq yd (836.1 m²) |
| Internal roads | 10(2)(g) | ≥ 40 ft (12.19 m) right of way |
| Low-income plots | 10(2)(j) | ≥ 20 % of plots ≤ 5 marla (126.4 m²) |

Units: 1 acre = 4 046.86 m², 1 sq yd = 0.836127 m², 1 ft = 0.3048 m.

## Auto-selection (`src/authority.ts` + `src/data/authority-areas.json`)

- Bundled outlines: Islamabad Capital Territory and Rawalpindi District, from OpenStreetMap (fetched once during
  implementation through Nominatim's polygon output, simplified to ≈ 100 m), stored with an "© OpenStreetMap
  contributors, ODbL" note.
- `detectAuthority(point)`: site centroid in ICT → `cda-2-5`; in Rawalpindi District → `rda`; else `none`.
  `ponytail:` outlines simplified ≈ 100 m and ICT zones not included: sites near a border or in Zone 4 use the
  override.
- Wizard Site step: `Rules: <name> (auto: site is in <area>)` with a dropdown Auto / None / CDA Zones 2 & 5 /
  CDA Zone 4 / RDA (Punjab 2010). Default Auto. The choice is wizard state only (not saved in the project).

## Comparison (`authorityChecks(proposal, site, authority, existing, brief)` in `src/authority.ts`)

Pure function returning `Proposal['checks']` rows, labelled `<CDA|RDA>: <rule>`; `detail` gives the measured value
and limit, plus the clause in parentheses (the table shows the part before " (" and the full detail on hover).
Measured from the proposal, as a share of the site area:

- Residential / commercial / public buildings: area of `plot` drafts with `attrs.zoning` residential / commercial /
  institutional (facility plots are institutional).
- Open space: area of `zone` drafts with `zoning: 'green'`.
- Roads: Σ length × width of new road drafts, plus existing roads (`existing.roads`) clipped to the site.
- Graveyard: 0 — no generator reserves one; detail `none reserved: add a graveyard by hand (≥ 2 %)`.
- Street width: `brief.localStreetWidth` (CDA's 30 ft case applies when every residential plot ≤ 108.7 m²).
- Access road (RDA): widest of the new arterial/link drafts and the existing roads the plan joins (`linkedTo`).
- Plot sizes / economy / low-income: from the residential plot drafts without an `issue`.
- Scheme area: site area.

The wizard appends these rows to every proposal after generation (both generators), so all columns have the same
rows. Under the table: `Rules: <source> — superseded by <newer>; verify against the current text.`

## Limits (marked `ponytail:` in code)

- Graveyard is never generated, so that check always fails for now (follow-up: a graveyard land use).
- Older rule texts only; percentages "subject to minor adjustments" per CDA.
- Simplified outlines; no ICT zone outlines.
- Not added to the planning report (report.ts) in this step.

## Testing

- `src/authority.test.ts`:
  - `detectAuthority`: F-7 Islamabad (73.05, 33.72) → `cda-2-5`; Rawalpindi Saddar (73.06, 33.59) → `rda`;
    Karachi (67.03, 24.94) → `none`.
  - `authorityChecks` on a hand-built proposal with known areas (e.g. 25 ha site, 50 % residential, 12 % green,
    25 % roads, 5 % commercial, 6 % institutional, plots 100–300 m², 12 m streets): every CDA Zone 2&5 row has the
    expected ok/fail (graveyard fails); a 4 ha site fails the scheme-area row; Zone 4 fails open space at 12 %;
    the RDA set flags a 1 200 m² plot and a 16 m access road.
- Existing tests stay green (generators untouched: `git diff src/masterplan.ts src/existingplan.ts` shows nothing
  from this feature).
- Browser: a site in Islamabad and one in Rawalpindi show the right authority and rows; Karachi shows none.
