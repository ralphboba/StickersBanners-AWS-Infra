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


def final_tif_name(order_name, item_no, finishing_obj):
    """Legacy final name: "{orderId}-{itemNo} {descSuf}[ qty N].tif".

    The separating space is NOT trimmed when there is no suffix. Linh's files on
    the facility FTP are named "S59902-1-1 .tif" — space, then the extension —
    and production has been receiving them that way for years, so matching it is
    the requirement. An earlier rstrip() here produced "S59902-1-1.tif".
    """
    desc = finishing_obj.get("descSuf", "")
    qty = int(finishing_obj.get("quantity", 1))
    if qty > 1:
        desc = f"{desc} qty {qty}".strip()
    return f"{order_name}-{item_no} {desc}.tif"
