"""Hourly check (Kai, 2026-10-12): did our pipeline make what Linh's program made?

Linh's program is still the one production prints from. Every order it sends
lands on the facility FTP as /{facility}/{order}/ — one print file per item
plus the invoice jpgs. Our pipeline makes the same files for the same orders
and keeps them in the finished bucket (PRODUCTION_TRANSFER holds them back).
So the question "does our program work" has a direct answer sitting on the
FTP: compare, order by order, and email Kai what differs.

What is compared, per order Linh sent in the last LOOKBACK_HOURS:

  facility      the folder Linh's file is in vs our routing
  print files   names (exact), then content: same size + the same first and
                last 1 MB. Sizes that differ get the pixel size of both sides
                read from the TIFF header, so the email can say why.
  invoice jpgs  Linh's numeric names vs ours renamed by renameDict, by size
  our status    an order we never took in, failed, or held for a person

The FTP is only READ: the host is passed through ftp_inspect.make_read_only
before any path is touched, and only the first and last megabyte of a file is
fetched, so the QTS server barely notices. Nothing here writes to OrderDesk,
a customer or a facility; the only output is the state file in our own
bucket and an email to Kai's SNS topic.
"""

import hashlib
import json
import os
import posixpath
import re
import struct
import sys
import time
from datetime import datetime, timedelta, timezone

FACILITIES = ('GA', 'NJ', 'TX', 'NV')
ORDER_RE = re.compile(r'^S\d+$')
# Linh's invoice thumbnails are OrderDesk item ids ("575779784.jpg"); ours are
# named by item ("1-1.jpg") until renameDict renames them at transfer.
INVOICE_RE = re.compile(r'^[\d-]+\.jpg$', re.I)
SKIP_DIRS = {'trash'}
SAMPLE_BYTES = 1 << 20
# The newest order folders per facility to look at. ~150 orders a day across
# all facilities, so this is days of headroom inside the lookback.
RECENT_FOLDERS = 600
# Linh's program may still be uploading a folder this young; look next hour.
SETTLE_SECONDS = 10 * 60
# Our run should be done well inside this; after it, "no files yet" is a finding.
PENDING_GRACE_SECONDS = 3 * 3600
KEEP_STATE_DAYS = 14
STATE_KEY = os.environ.get('COMPARE_STATE_KEY', '_linh-compare/auto/state.json')

ALERT_VERDICTS = ('diff', 'failed', 'missing')
VERDICT_KO = {
    'match': '같음',
    'diff': '다름',
    'failed': '우리 처리 실패',
    'missing': '우리 시스템에 없음',
    'held': '보류 (사람이 처리)',
    'manual': '사무실이 만든 파일',
    'pending': '처리 중',
}
# Kinds of difference, in the order the email lists them (worst first).
KIND_KO = {
    'failed': '우리 처리 실패',
    'missing': '우리 시스템에 주문이 없음',
    'late': '린은 보냈는데 우리 파일이 아직 없음',
    'facility': '공장이 다름',
    'file': '파일 구성이 다름 (마감 표시/아이템)',
    'name': '파일 이름만 다름',
    'content': '파일 내용이 다름',
    'invoice': '인보이스 썸네일만 다름',
}


# --- pure helpers (unit-tested) ------------------------------------------------

def norm_name(name):
    """Same file name apart from spacing and case."""
    return re.sub(r'\s+', ' ', str(name)).strip().lower()


def is_invoice(name):
    return bool(INVOICE_RE.match(str(name)))


def order_number(name):
    return int(name[1:]) if ORDER_RE.match(name) else -1


def tiff_info(read, size):
    """Width and height from a TIFF's first IFD.

    read(offset, length) -> bytes. The IFD can sit anywhere -- Linh's files
    keep it at the END, after the pixels -- so it is read where the header
    points rather than hoped for in the first few hundred KB.
    """
    head = read(0, 8)
    if len(head) < 8 or head[:2] not in (b'II', b'MM'):
        return None
    bo = '<' if head[:2] == b'II' else '>'
    if struct.unpack(bo + 'H', head[2:4])[0] != 42:
        return None
    off = struct.unpack(bo + 'I', head[4:8])[0]
    if off + 2 > size:
        return None
    count = struct.unpack(bo + 'H', read(off, 2))[0]
    raw = read(off + 2, min(count, 200) * 12)
    info = {}
    for i in range(len(raw) // 12):
        tag, typ, _n = struct.unpack(bo + 'HHI', raw[i * 12:i * 12 + 8])
        if typ == 3:  # SHORT
            val = struct.unpack(bo + 'H', raw[i * 12 + 8:i * 12 + 10])[0]
        elif typ == 4:  # LONG
            val = struct.unpack(bo + 'I', raw[i * 12 + 8:i * 12 + 12])[0]
        else:
            continue
        if tag == 256:
            info['w'] = val
        elif tag == 257:
            info['h'] = val
    return info if 'w' in info and 'h' in info else None


def mb(n):
    return f'{n / 1_000_000:.1f} MB'


def dims(info):
    return f"{info['w']}×{info['h']}px" if info else '크기 모름'


def folder_signature(files):
    """Changes when Linh's folder changes (a file added, replaced, re-sent)."""
    raw = '|'.join(f"{f['name']}:{f['size']}" for f in sorted(files, key=lambda f: f['name']))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def compare_order(order, facility, linh_files, meta, ours_files, sample, now, folder_mtime):
    """Verdict for one order.

    linh_files / ours_files: [{'name', 'size'}]. sample(side, name, size, kind)
    returns facts read from one file: kind 'hash' -> a digest of its first and
    last SAMPLE_BYTES, kind 'header' -> tiff_info(...) or None.

    problems: [{'k': kind (KIND_KO), 't': Korean text}].
    """
    res = {'order': order, 'facility': facility, 'problems': [], 'notes': []}

    def problem(kind, text):
        res['problems'].append({'k': kind, 't': text})

    if not meta or meta.get('mirror'):
        res['verdict'] = 'missing'
        problem('missing', '우리 시스템에 이 주문이 없어요 (인테이크에서 못 가져옴)')
        return res

    status = meta.get('status') or ''
    hold = (meta.get('hold') or {}).get('reason')
    ours_print = [f for f in ours_files if not is_invoice(f['name'])]
    exts = sorted({str(i.get('artworkExt') or '?').lower() for i in meta.get('items') or []})
    res['source'] = ','.join(exts)

    if status == 'failed':
        res['verdict'] = 'failed'
        err = meta.get('error') or meta.get('failure') or ''
        problem('failed', f'우리 처리 실패{": " + str(err)[:160] if err else ""}')
        return res
    if status == 'needs_review' or hold:
        res['verdict'] = 'held'
        res['notes'].append(f'보류 사유: {hold or status}')
        return res
    if not ours_print:
        if now - folder_mtime < PENDING_GRACE_SECONDS:
            res['verdict'] = 'pending'
            return res
        res['verdict'] = 'diff'
        problem('late', f'우리 파일이 아직 없어요 (상태: {status or "?"})')
        return res

    our_fac = (meta.get('routing') or {}).get('facility')
    if our_fac and our_fac != facility:
        problem('facility', f'린 {facility} / 우리 {our_fac}')

    # Print files: exact names first, then names equal apart from spacing.
    linh_print = {f['name']: f for f in linh_files if not is_invoice(f['name'])}
    ours_by = {f['name']: f for f in ours_print}
    pairs = []
    for name in sorted(set(linh_print) & set(ours_by)):
        pairs.append((linh_print.pop(name), ours_by.pop(name)))
    ours_norm = {norm_name(n): f for n, f in ours_by.items()}
    for name in sorted(linh_print):
        o = ours_norm.pop(norm_name(name), None)
        if o:
            ours_by.pop(o['name'], None)
            problem('name', f'린 "{name}" / 우리 "{o["name"]}"')
            pairs.append((linh_print[name], o))
        else:
            problem('file', f'린에만 있음 "{name}"')
    for name in sorted(ours_by):
        problem('file', f'우리만 있음 "{name}"')

    content = False
    for lf, of in pairs:
        if lf['size'] != of['size']:
            li = sample('linh', lf['name'], lf['size'], 'header')
            oi = sample('ours', of['name'], of['size'], 'header')
            why = f'린 {dims(li)} {mb(lf["size"])} / 우리 {dims(oi)} {mb(of["size"])}'
            if isinstance(li, dict) and isinstance(oi, dict):
                if (li['w'], li['h']) == (oi['h'], oi['w']) and li['w'] != li['h']:
                    why += ', 가로세로가 뒤집힘'
                elif (li['w'], li['h']) == (oi['w'], oi['h']):
                    why += ', 픽셀 크기는 같음'
            problem('content', f'"{lf["name"]}" ({why})')
            content = True
        elif sample('linh', lf['name'], lf['size'], 'hash') != sample('ours', of['name'], of['size'], 'hash'):
            problem('content', f'"{lf["name"]}" (크기는 같은데 내용이 다름, {mb(lf["size"])})')
            content = True

    # Invoice jpgs, renamed the way the transfer step would. A thumbnail of a
    # print file that already differs is bound to differ too -- not news.
    if not content:
        rename = meta.get('renameDict') or {}
        ours_inv = {}
        for f in ours_files:
            if is_invoice(f['name']):
                base = f['name'][:-4]
                ours_inv[f'{rename.get(base, base)}.jpg'] = f
        linh_inv = {f['name']: f for f in linh_files if is_invoice(f['name'])}
        for name in sorted(set(linh_inv) - set(ours_inv)):
            problem('invoice', f'린에만 있음 {name}')
        for name in sorted(set(ours_inv) - set(linh_inv)):
            problem('invoice', f'우리만 있음 {name}')
        for name in sorted(set(linh_inv) & set(ours_inv)):
            if linh_inv[name]['size'] != ours_inv[name]['size']:
                problem('invoice', f'{name} 린 {linh_inv[name]["size"]:,} / 우리 {ours_inv[name]["size"]:,} bytes')

    manual = meta.get('manualFiles') is True or meta.get('staffRelease') is True
    res['files'] = len(pairs)
    if res['problems']:
        res['verdict'] = 'diff'
    else:
        res['verdict'] = 'manual' if manual else 'match'
    if manual:
        res['notes'].append('사무실에서 첨부한 파일로 처리한 주문')
    return res


def needs_alert(prev, res):
    """Email about this result unless the same finding was already sent."""
    if res['verdict'] not in ALERT_VERDICTS:
        return False
    return not (prev and prev.get('alerted') and prev.get('verdict') == res['verdict']
                and prev.get('problems') == res['problems'])


def _kinds(r):
    return [k for k in KIND_KO if any(p['k'] == k for p in r.get('problems') or [])]


def format_alert(results):
    """(subject, body) for the findings of one run, grouped by kind of difference."""
    orders = [r['order'] for r in results]
    shown = ', '.join(orders[:4]) + (f' 외 {len(orders) - 4}건' if len(orders) > 4 else '')
    subject = f'[린 비교] {len(results)}건 다름 — {shown}'
    lines = ['린 프로그램이 FTP에 올린 파일과 우리 프로그램이 만든 파일을 비교했어요.', '']
    for kind, title in KIND_KO.items():
        group = [r for r in results if kind in _kinds(r)]
        if not group:
            continue
        lines.append(f'■ {title} ({len(group)}건)')
        if kind == 'content':
            pdf = [r['order'] for r in group if 'pdf' in (r.get('source') or '')]
            if pdf:
                lines.append(f'   원본이 PDF인 주문: {len(pdf)}건')
        for r in group:
            texts = [p['t'] for p in r['problems'] if p['k'] == kind]
            src = f", 원본 {r['source']}" if kind == 'content' and r.get('source') else ''
            lines.append(f"• {r['order']} ({r['facility']}{src}): {texts[0]}")
            lines.extend(f'     {t}' for t in texts[1:4])
            if len(texts) > 4:
                lines.append(f'     … 외 {len(texts) - 4}개')
        lines.append('')
    lines.append('FTP는 읽기만 했어요. 아무 데도 쓰거나 보내지 않았어요.')
    return subject[:99], '\n'.join(lines)


def format_summary(entries, day):
    """(subject, body) for the daily count."""
    counts = {}
    for e in entries:
        counts[e['verdict']] = counts.get(e['verdict'], 0) + 1
    total = sum(counts.values())
    same = counts.get('match', 0)
    bad = sum(counts.get(v, 0) for v in ALERT_VERDICTS)
    subject = f'[린 비교] {day} 하루 요약 — {total}건 중 같음 {same}, 다름 {bad}'
    lines = [f'지난 24시간 동안 린 프로그램이 FTP에 보낸 주문 {total}건을 비교했어요.', '']
    for v in ('match', 'diff', 'failed', 'missing', 'held', 'manual', 'pending'):
        if counts.get(v):
            lines.append(f'• {VERDICT_KO[v]}: {counts[v]}건')
    flagged = [e for e in entries if e['verdict'] in ALERT_VERDICTS]
    if flagged:
        lines += ['', '다른 주문 (유형별):']
        for kind, title in KIND_KO.items():
            group = [e['order'] for e in flagged if kind in _kinds(e)]
            if group:
                lines.append(f'• {title} {len(group)}건: {", ".join(group[:20])}' + (' …' if len(group) > 20 else ''))
    return subject[:99], '\n'.join(lines)


def new_york_now(now):
    try:
        from zoneinfo import ZoneInfo
        return datetime.fromtimestamp(now, ZoneInfo('America/New_York'))
    except Exception:  # no tz database in the image: EDT is close enough
        return datetime.fromtimestamp(now, timezone(timedelta(hours=-4)))


# --- I/O ---------------------------------------------------------------------

def _read_ftp(host, path, offset, length):
    """Up to `length` bytes of a remote file from `offset`.

    Stopping a download early makes IIS answer the close with a 550; the bytes
    already read are fine, so that error is swallowed.
    """
    f = host.open(path, 'rb', rest=offset)
    try:
        return f.read(length)
    finally:
        try:
            f.close()
        except Exception:
            pass


def _read_s3(s3, bucket, key, offset, length):
    rng = f'bytes={offset}-{offset + length - 1}'
    return s3.get_object(Bucket=bucket, Key=key, Range=rng)['Body'].read()


def _sample_hash(read, size):
    h = hashlib.sha256()
    if size <= 2 * SAMPLE_BYTES:
        h.update(read(0, size))
    else:
        h.update(read(0, SAMPLE_BYTES))
        h.update(read(size - SAMPLE_BYTES, SAMPLE_BYTES))
    return h.hexdigest()


def _unmarshal(v):
    (k, x), = v.items()
    if k == 'M':
        return {a: _unmarshal(b) for a, b in x.items()}
    if k == 'L':
        return [_unmarshal(i) for i in x]
    if k == 'N':
        return float(x)
    if k == 'NULL':
        return None
    return x


def list_linh_orders(host, now, lookback):
    """[(facility, folder path, order, mtime)] for recently changed order folders."""
    found = {}

    def consider(fac, parent, names):
        for name in sorted((n for n in names if ORDER_RE.match(n)), key=order_number)[-RECENT_FOLDERS:]:
            path = posixpath.join(parent, name)
            try:
                st = host.stat(path)
            except Exception:
                continue
            if now - st.st_mtime <= lookback:
                prev = found.get(name)
                if not prev or st.st_mtime > prev[3]:
                    found[name] = (fac, path, name, st.st_mtime)

    for fac in FACILITIES:
        root = f'/{fac}'
        try:
            names = host.listdir(root)
        except Exception as err:
            print(f'compare: cannot list {root}: {err}', file=sys.stderr)
            continue
        consider(fac, root, names)
        # Production sweeps orders into dated batch folders ("10.12",
        # "9.22 Tuesday", "PROCESSED"); look one level into recent ones.
        for name in names:
            if ORDER_RE.match(name) or name.lower() in SKIP_DIRS:
                continue
            path = posixpath.join(root, name)
            try:
                if not host.path.isdir(path) or now - host.stat(path).st_mtime > lookback:
                    continue
                consider(fac, path, host.listdir(path))
            except Exception:
                continue
    return list(found.values())


def main():
    import boto3
    import ftputil
    from ftp_inspect import make_read_only

    sb_env = os.environ.get('SB_ENV', 'dev')
    table = os.environ['JOBS_TABLE']
    finished = os.environ['FINISHED_BUCKET']
    state_bucket = os.environ['PROCESSED_BUCKET']
    topic = os.environ.get('COMPARE_TOPIC_ARN', '')
    lookback = float(os.environ.get('LOOKBACK_HOURS', '48')) * 3600
    now = time.time()

    ssm = boto3.client('ssm')
    s3 = boto3.client('s3')
    ddb = boto3.client('dynamodb')
    sns = boto3.client('sns')

    def secret(key):
        return ssm.get_parameter(Name=f'/sb/{sb_env}/ftp/{key}', WithDecryption=True)['Parameter']['Value']

    try:
        state = json.loads(s3.get_object(Bucket=state_bucket, Key=STATE_KEY)['Body'].read())
    except Exception:
        state = {}
    orders_state = state.setdefault('orders', {})

    # Nothing counts as sent until Kai has confirmed the email subscription:
    # SNS drops messages to a pending one, and the findings should wait for it.
    deliverable = False
    if topic:
        try:
            subs = sns.list_subscriptions_by_topic(TopicArn=topic).get('Subscriptions', [])
            deliverable = any(x.get('SubscriptionArn', '').startswith('arn:') for x in subs)
        except Exception as err:
            print(f'compare: cannot read subscriptions: {err}', file=sys.stderr)

    checked = 0
    with ftputil.FTPHost(secret('host'), secret('user'), secret('password')) as host:
        make_read_only(host)
        for fac, folder, order, mtime in list_linh_orders(host, now, lookback):
            if now - mtime < SETTLE_SECONDS:
                continue
            try:
                linh_files = []
                for name in host.listdir(folder):
                    path = posixpath.join(folder, name)
                    if host.path.isfile(path):
                        linh_files.append({'name': name, 'size': host.stat(path).st_size})
            except Exception as err:
                print(f'compare: cannot read {folder}: {err}', file=sys.stderr)
                continue
            sig = folder_signature(linh_files)
            prev = orders_state.get(order)
            if prev and prev.get('sig') == sig and prev.get('verdict') not in ('pending',) \
                    and prev.get('ourAt') is not None:
                continue

            item = ddb.get_item(TableName=table, Key={'PK': {'S': f'ORDER#{order}'}, 'SK': {'S': 'META'}}).get('Item')
            meta = _unmarshal({'M': item}) if item else None
            ours_files = []
            for page in s3.get_paginator('list_objects_v2').paginate(Bucket=finished, Prefix=f'{order}/'):
                for obj in page.get('Contents', []):
                    name = obj['Key'].split('/', 1)[1]
                    if name and '/' not in name:
                        ours_files.append({'name': name, 'size': obj['Size']})

            def sample(side, name, size, kind):
                if side == 'linh':
                    read = lambda o, n: _read_ftp(host, posixpath.join(folder, name), o, n)  # noqa: E731
                else:
                    read = lambda o, n: _read_s3(s3, finished, f'{order}/{name}', o, n)  # noqa: E731
                try:
                    if kind == 'header':
                        return tiff_info(read, size)
                    return _sample_hash(read, size)
                except Exception as err:
                    print(f'compare: sample {side} {order}/{name}: {err}', file=sys.stderr)
                    return f'error:{side}'

            res = compare_order(order, fac, linh_files, meta, ours_files, sample, now, mtime)
            checked += 1
            orders_state[order] = {
                'verdict': res['verdict'], 'facility': fac, 'problems': res['problems'],
                'notes': res['notes'], 'source': res.get('source'), 'sig': sig,
                'at': int(now), 'linhAt': int(mtime), 'ourAt': int(now) if ours_files else None,
                'alerted': not needs_alert(prev, res) and bool(prev and prev.get('alerted'))}
            print(json.dumps({'order': order, 'facility': fac, 'verdict': res['verdict'],
                              'problems': res['problems']}, ensure_ascii=False))

    # Every finding not yet sent -- this run's, and any found while the email
    # subscription was still unconfirmed.
    alerts = [dict(v, order=k) for k, v in orders_state.items()
              if v['verdict'] in ALERT_VERDICTS and not v.get('alerted')]
    if alerts and deliverable:
        subject, body = format_alert(alerts)
        sns.publish(TopicArn=topic, Subject=subject, Message=body)
        for a in alerts:
            orders_state[a['order']]['alerted'] = True

    # Daily count, on the first run after 9am New York time.
    ny = new_york_now(now)
    today = ny.strftime('%Y-%m-%d')
    if ny.hour >= 9 and state.get('lastSummary') != today:
        day = [dict(v, order=k) for k, v in orders_state.items() if now - v.get('linhAt', 0) <= 24 * 3600]
        if deliverable and day:
            subject, body = format_summary(day, ny.strftime('%m/%d'))
            sns.publish(TopicArn=topic, Subject=subject, Message=body)
            state['lastSummary'] = today

    cutoff = now - KEEP_STATE_DAYS * 86400
    state['orders'] = {k: v for k, v in orders_state.items() if v.get('at', 0) >= cutoff}
    state['lastRun'] = int(now)
    s3.put_object(Bucket=state_bucket, Key=STATE_KEY, ContentType='application/json',
                  Body=json.dumps(state, ensure_ascii=False).encode())
    print(json.dumps({'checked': checked, 'alerts': len(alerts), 'tracked': len(state['orders'])}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'compare failed: {exc}', file=sys.stderr)
        sys.exit(1)
