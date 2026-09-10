# Linh's requirements & answers (source of truth)

Linh is the author of the legacy program (SBBotExpress + SBImageProcessor) and
the domain authority. These are his own answers, quoted, plus what still needs
confirming. Treat this as the spec the new system must match.

## Routing (facility assignment)

> **"Zip code check only applies to nv/ca cause nv ships to some zip codes in
> ca. The rest of the production ships by state."**

- **NV / CA** → decided by **ZIP** (NV ships to certain CA-destination ZIPs; those
  take precedence, else CA). Implemented from legacy `zip.xlsx`
  (`src/shared/zipRouting.mjs`).
- **GA / NJ / TX / NV** → decided **by shipping state**. Linh gave the exact
  lists (now implemented in `src/shared/routing.mjs`):
  - **GA**: AL FL GA IN KY MI MS NC SC TN WI OH WV VA
  - **NJ**: CT DC DE MA ME NH NJ NY RI VT MD PA
  - **TX**: AR CO IL IA KS LA MO ND NE NM OK SD TX WY MN
  - **NV**: WA OR NV AZ UT ID MT
  Decision order: NV_ZIPS → CA_ZIPS → state lists → UNROUTED.

## Credentials (Linh confirmed)

- **FTP** (GA/NJ/TX/NV): "still the same, should all be in the python code" —
  host `64.57.252.252`, user `branch`.
- **CA Google Drive folder ID**: "still the same" — `0AAv6uDYl6AfsUk9PVA`
  (a **Shared Drive**, needs `supportsAllDrives=True`).
- **Zendesk** (main customer channel — sends the proof-ready email):
  subdomain `stickersbanners`, email `linh@stickersbanners.com`, API token provided.
- **Google service account**: JSON file provided directly (gitignored, seeded to SSM).
- **OrderDesk**: store id `784`, API key provided.
- NOTE: all pasted keys were exposed in chat → **rotate before real go-live.**

## Behaviour Linh specified

- **Artwork files**: "read only permission for proof files only, **there's no
  downloading any files for the artwork** … everyone has direct access to the
  folder." → We do NOT have a sanctioned artwork-download path from Linh; revisit
  how AWS pulls customer artwork. (We had been fetching from a public S3 upload
  bucket — confirm this is acceptable.)
- **Completed**: "after a tracking number is assigned or cx pick up, **handled by
  production**. The bot only sends orders to production's folder." → Our pipeline
  correctly ends at delivery to the facility (`pickup_*`); production owns the
  rest. Do NOT build a "completed" transition ourselves.
- **Proofs / approve-reject**: "I don't understand the approve/reject mechanism.
  **Cx just reaches out via email if they want to revise. I don't want them to
  have the option to upload files** (they abuse it by uploading 5-6 files for
  reproofing)." → Do NOT add customer-facing approve/reject or file upload. Proof
  revisions happen over email. The staff dashboard's "Send to production" is a
  staff action, which is fine.
- **Workflow**: "the program pings orderdesk for a job pool → filter and clean it
  → send processed job data to python → python process → done."
- **OrderDesk push**: no outbound webhook available → intake is by **polling**
  the QTS folder (matches legacy).
- **Google Chat alerts**: turned OFF per Kai — staff track everything in the
  dashboard; Zendesk proof email is the only external notification.

## Linh's answers, round 2 (2026-09)

Asked after diffing this port against his source. Quoted, then what we did.

- **Dead constants.** "there are some variables i added for temporary use but
  then went with a different method and i never removed it." → `NOFINISHSKU` in
  `constants.mjs` is a leftover, not a wiring bug.
- **Adhesive banners.** "adhesive banners are sent without applying finishing
  options." → `SKUAB` stays in `NO_FINISH_SKUS`. They ARE auto-processed (the
  product name has no "sticker", so `checkSpecialProduct` never catches them).
- **Zendesk.** assignee id `1900327743467` (Linh's own queue), custom field id
  `22794009`. Seeded to SSM as `zendesk/assignee-id` and `zendesk/field-id`.
  ⚠️ The assignee is a personal box — needs reassigning at handover.
- **Proof approval.** "i said i didn't see the point in disapproving, not not
  letting them approve … right now they'd still need to approve via the portal."
  → Customers DO approve, on the portal. There is no disapprove. File upload
  stays off; revisions come back by email.
- **Bravo tabs.** "grommet with bravo tabs is treated the same as regular
  grommets. the position depends on the sales rep to change, customers can only
  request options for positions in the special instructions." → all four sides,
  same as the plain grommet key. Position is a human decision afterwards.
- **Cut Only.** "cut only is fine" → keep the `CO` suffix we added.
- **Corner grommets.** "yes productions doesn't need corner grommets" → keep
  legacy's `positions - cornerPositions`; no corner marks are drawn.
- **`/proof` uploads.** "the proof endpoint is to generate a thumbnail for the
  invoice on orderdesk. invoices will show them for production to use as
  reference." → the rename to the OrderDesk line-item id matters; the invoice
  looks the image up by it. Implemented as `renameDict`.
- **Extra routing rules.** "all the things you asked about being live is still
  live" → pickup keywords, the 3–6pm ET express cutoff, the 3-day→2-day upgrade
  and see-thru→NV are all implemented.

## Confirmed by Kai from the first live dry-run (2026-09)

Both found by running 12 real QTS orders through the current code with every
write switch off (`docs/go-live.md` stage 1).

- **Vegas prints some orders regardless of destination.** Kai: "가끔씩 어떤
  오더들은 그냥 베가스에서 프린팅 하는 경우가 있어." → the express rule is
  correct as ported: inside the 3-6pm ET window, 1-day/2-day/overnight go to NV
  whatever the shipping state. Live order S59129 ships to **Virginia** and was
  routed to **NV** for exactly this reason. Note the same order placed at 2pm
  routes to GA instead — the window, not the address, decides. Not a bug; do
  not "fix" it.
- **`SKU-608` is quoted in inches.** Kai: "SKU-608은 145x91ft 가 아니라 inch야."
  → added to `INCH_SKUS_EXTRA` in `sku-config.mjs`. Its product name contains
  "fabric", which opts out of `resolveDimensions`' remap, so the unit came only
  from the inch-SKU lists — and it was in none of them. Live order S59121 was
  resolving to 145x91 **feet**. The resizer scales to whatever number it gets,
  so this would have produced a print file 12x oversized.
- **`SKU-604`, `SKU-607`, `SKUXBS` are quoted in inches too.** Kai: "응 셋 다
  인치야." → added to `INCH_SKUS_EXTRA` alongside `SKU-608`. Found by the
  2026-09-10 full-day census of 350 real orders, which listed every line still
  resolving to an implausible number of feet, then confirmed by product name:

  | SKU | Product | Raw | Was |
  |---|---|---|---|
  | `SKU-604` | Fabric Pop Up Display Backdrop **with Stand** | 145x91 | 145 ft |
  | `SKU-607` | **8'x8'** Fabric Pop Up Display Backdrop (Banner Only) | 115x91 | 115 ft |
  | `SKUXBS` | X-Banner | 30x69 | 30 ft |

  `SKU-604` is the same print as `SKU-608` — the backdrop sold with its stand —
  which is why it carries the identical 145x91.

  Two cases in the same census are **still wrong** and cannot be fixed with a
  SKU list:
  - `SKUAB` (Adhesive Banners / Window Decals) arrived as `'48 in'` x `'80 in'`.
    The unit is inside the value and the parser discards it, so it reads as 48
    feet. Needs a parse fix, not a list entry.
  - `SKUVB` (Custom Vinyl Banners) carried `144 x 18` on one order. SKUVB is
    genuinely quoted in feet normally, so this needs a magnitude rule ("too
    large to be feet"), which no SKU list can express. Worth asking Linh how
    his program handles it before inventing one.

### Not answered yet

1. The hardware SKU list. Ours is derived from the store's SKU catalogue
   (`SB_SKU.xlsx`, confirmed current by Kai) — 23 codes in `sku-config.mjs`.
   Still unverified against his `dict:hardwareSku`.
2. Whether other SKU codes need the `SKU-DXB-B` name check. From the catalogue,
   `SKUFSR08X08`, `SKUFSR08X10` and `SKUFB` each cover two products — but both
   sides of each are printed, so none affects the hardware filter.
3. Where `proof.stickersbanners.com` is hosted and who can repoint it. It is not
   in the legacy repo; SBBotExpress only serves its API. If his program is
   switched off with the portal still calling it, every order stalls at proofing.
4. How customers authenticate on the portal (`requireGeneralAuth`).

## Still to confirm with Linh

1. Full GA/NJ/TX/NV state→facility lists (or approve deriving them from real orders).
2. How AWS should pull customer artwork (Linh says no artwork download exists).
3. Hardware SKU list (legacy filtered hardware-only line items via a Redis dict;
   Linh: "hardware sku just comes from the excel sheet for hardware").
4. "Grommet with Bravo Tab (TOP only)" — grommets on all 4 sides or top only?
