"""Derive the workbench view from raw `haven graph --full --all` output.

    python3 derive-view.py retrostack-2026-09-07.raw.json out.json 2026-09-07T20:00:00Z

Reference implementation of the derivation the app performs on every read
(spec docs/specs/haven-integration.md, §7 primary epic, §15 fixtures):

  * `parents`  — every decomposition/grouping edge pointing at the item, as {ref, kind}
  * `deps`     — every dependency edge, as {src, dst} (src depends on dst)
  * `root`/`rt`— the primary epic per §7: decomposition beats grouping, lowest ref
                 number breaks ties, visited set stops cycles; null for a top-level item
  * `owner`/`wait`/`upd`/`dll` — owner_kind / wait_state / updated_at / done_looks_like
  * `why` and `dll` are cut at 220 / 230 chars and are "" when the node omits the field

Verified 2026-09-08: applied to the raw capture it reproduces
retrostack-2026-09-07.json (the r13 mockup's dataset) byte-for-byte in content.
An implementation in the app is correct when its output for the .raw.json
fixture equals the .json fixture.
"""
import json, sys, re

def refnum(r): return int(r.rsplit('-',1)[1])

def derive(raw, pulled=None):
    nodes = {n['ref']: n for n in raw['nodes']}
    parents = {}   # child -> [{ref, kind}]
    deps = []      # {src, dst}: src depends on dst
    for e in raw['edges']:
        if e['kind'] in ('decomposition', 'grouping'):
            parents.setdefault(e['to'], []).append({'ref': e['from'], 'kind': e['kind']})
        elif e['kind'] == 'dependency':
            deps.append({'src': e['from'], 'dst': e['to']})
    def pick(ref):
        ps = parents.get(ref) or []
        ps = sorted(ps, key=lambda p: (0 if p['kind']=='decomposition' else 1, refnum(p['ref'])))
        return ps[0]['ref'] if ps else None
    def root(ref):
        seen = {ref}; cur = ref
        while True:
            nxt = pick(cur)
            if nxt is None or nxt in seen: return cur
            seen.add(nxt); cur = nxt
    items = []
    for n in raw['nodes']:
        r = root(n['ref'])
        items.append({
            'ref': n['ref'], 'title': n.get('title'), 'status': n.get('status'), 'type': n.get('type'),
            'priority': n.get('priority'), 'owner': n.get('owner_kind'), 'wait': n.get('wait_state'),
            'upd': n.get('updated_at'), 'committed': n.get('committed'),
            'root': None if r == n['ref'] else r,
            'rt': None if r == n['ref'] else nodes[r].get('title'),
            'parents': parents.get(n['ref'], []),
            'why': (n.get('why') or '')[:220], 'dll': (n.get('done_looks_like') or '')[:230],
        })
    prefix = raw['nodes'][0]['ref'].rsplit('-', 1)[0] if raw['nodes'] else None
    return {'items': items, 'deps': deps, 'project': raw.get('project'), 'prefix': prefix, 'pulled': pulled}

if __name__ == '__main__':
    # usage: derive.py <raw.json> <out.json> <pulled-iso-timestamp>
    raw = json.load(open(sys.argv[1])); pulled = sys.argv[3]
    json.dump(derive(raw, pulled), open(sys.argv[2], 'w'), ensure_ascii=False, separators=(',', ':'))
