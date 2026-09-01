"""G. Finishing text -> config mapping — ported from legacy constants.mjs.

Maps the OrderDesk finishing option text to the finishing object the finisher
applies. NOFINISHSKU items skip finishing entirely.
"""

FINISHINGCONFIG = {
    "Pole Pocket Top Only": {"specialFinishing": "PPTO"},
    "PPTO": {"specialFinishing": "PPTO"},
    "Pole Pocket Bottom Only": {"specialFinishing": "PPBO"},
    "PPBO": {"specialFinishing": "PPBO"},
    "Hem Grommets": {"grommets": {"sides": ["top", "left", "right", "bottom"]}},
    "Grommets only": {"grommets": {"isOnly": True, "sides": ["top", "left", "right", "bottom"]}},
    "No Hem, Grommets Only": {"grommets": {"isOnly": True, "sides": ["top", "left", "right", "bottom"]}},
    "Hem Only": "HO",
    "Cut Only": "CO",
}

NOFINISHSKU = ["SKUAB", "SKUST", "SKU10ET", "SKU10TFW"]  # SKU10ET = 10ft Event Tent, SKU10TFW = 10ft Tent Full Walls


def build_finishing_obj(item):
    """Build the legacy finishingObj for a cleaned-job item.

    Uses item['finishingObj'] verbatim when the webhook provided one; otherwise
    derives it from the item's finishing strings via FINISHINGCONFIG.
    Always carries quantity (legacy appended "qty N" for quantity > 1).
    """
    if item.get("sku") in NOFINISHSKU:
        return {"quantity": item.get("quantity", 1)}

    if isinstance(item.get("finishingObj"), dict):
        obj = dict(item["finishingObj"])
        obj.setdefault("quantity", item.get("quantity", 1))
        return obj

    obj = {"quantity": item.get("quantity", 1)}
    # webhook cleanOrder splits "Hem & Grommets" -> ["Hem", "Grommets"]; try the
    # joined original first, then each token, mirroring FINISHINGCONFIG keys.
    tokens = item.get("finishing") or []
    candidates = [" ".join(tokens)] + tokens
    for cand in candidates:
        mapped = FINISHINGCONFIG.get(cand)
        if isinstance(mapped, dict):
            for k, v in mapped.items():
                obj.setdefault(k, v)
        elif mapped in ("HO", "CO"):
            obj.setdefault("descSuf", mapped)
    # "Hem & Grommets" (webhook-split) => grommets on all four sides
    if "grommets" not in obj and any(t.lower().startswith("grommet") for t in tokens):
        obj["grommets"] = {"sides": ["top", "left", "right", "bottom"]}
    return obj
