#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CVSS v3.1 base-score verification for /tools/cvss-calculator/.

    python3 tests/test_cvss.py
    python3 tests/test_cvss.py --browser browser-results.json

The vectors in tests/cvss_vectors.json are scored by FIRST.org (v3.1 Examples
document) and by NVD (cvssMetricV31). This script re-implements the equations
from the specification independently of the JavaScript that ships to the
browser, then checks:

  1. every published vector reproduces its published score and severity band,
  2. all 2,592 metric combinations stay in range, land on one decimal, and
     get a consistent severity band,
  3. CIA and attack-vector monotonicity holds, and every vector round-trips
     through the parser,
  4. optionally, the same vectors scored by the shipped page (--browser) match.

Exit code 0 only when every check passes.
"""

import argparse
import itertools
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, 'cvss_vectors.json')

ORDER = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']
VALUES = {'AV': 'NALP', 'AC': 'LH', 'PR': 'NLH', 'UI': 'NR', 'S': 'UC',
          'C': 'HLN', 'I': 'HLN', 'A': 'HLN'}

W_AV = {'N': 0.85, 'A': 0.62, 'L': 0.55, 'P': 0.20}
W_AC = {'L': 0.77, 'H': 0.44}
W_UI = {'N': 0.85, 'R': 0.62}
W_CIA = {'H': 0.56, 'L': 0.22, 'N': 0.00}
W_PR = {'U': {'N': 0.85, 'L': 0.62, 'H': 0.27}, 'C': {'N': 0.85, 'L': 0.68, 'H': 0.50}}


def round_up(value):
    """Spec appendix A: scale to an integer, round up with integer math only."""
    scaled = int(round(value * 100000))
    if scaled % 10000 == 0:
        return scaled / 100000.0
    return (scaled // 10000 + 1) / 10.0


def severity(score):
    if score == 0:
        return 'NONE'
    if score < 4.0:
        return 'LOW'
    if score < 7.0:
        return 'MEDIUM'
    if score < 9.0:
        return 'HIGH'
    return 'CRITICAL'


def score(metrics):
    c, i, a = W_CIA[metrics['C']], W_CIA[metrics['I']], W_CIA[metrics['A']]
    iss = 1 - (1 - c) * (1 - i) * (1 - a)
    if metrics['S'] == 'U':
        impact = 6.42 * iss
    else:
        impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    exploitability = (8.22 * W_AV[metrics['AV']] * W_AC[metrics['AC']]
                      * W_PR[metrics['S']][metrics['PR']] * W_UI[metrics['UI']])
    if impact <= 0:
        return 0.0
    if metrics['S'] == 'U':
        return round_up(min(impact + exploitability, 10))
    return round_up(min(1.08 * (impact + exploitability), 10))


def parse(vector):
    body = vector.strip()
    for prefix in ('CVSS:3.1/', 'CVSS:3.0/'):
        if body.upper().startswith(prefix):
            body = body[len(prefix):]
            break
    metrics = {}
    for piece in body.split('/'):
        key, _, val = piece.partition(':')
        key, val = key.upper(), val.upper()
        if key not in VALUES or val not in VALUES[key]:
            raise ValueError('bad metric %r in %r' % (piece, vector))
        metrics[key] = val
    if sorted(metrics) != sorted(ORDER):
        raise ValueError('missing metric in %r' % vector)
    return metrics


def build(metrics):
    return 'CVSS:3.1/' + '/'.join('%s:%s' % (k, metrics[k]) for k in ORDER)


def check(cond, label, failures):
    if not cond:
        failures.append(label)
    return cond


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--browser', help='JSON list of {vector, score, severity} produced by the shipped page')
    args = ap.parse_args()

    with open(VECTORS, encoding='utf-8') as f:
        doc = json.load(f)
    rows = doc['vectors']
    failures = []

    print('== published vectors (%d) ==' % len(rows))
    for row in rows:
        metrics = parse(row['vector'])
        got = score(metrics)
        ok = abs(got - row['score']) < 1e-9 and severity(got) == row['severity']
        print('  %s  %4.1f / %-8s  %s' % ('PASS' if ok else 'FAIL', got, row['severity'], row['vector']))
        if not ok:
            failures.append('%s expected %.1f got %.1f' % (row['vector'], row['score'], got))

    print('== exhaustive combinations ==')
    combos = list(itertools.product(*[VALUES[k] for k in ORDER]))
    bad = 0
    for values in combos:
        metrics = dict(zip(ORDER, values))
        s = score(metrics)
        if not (0.0 <= s <= 10.0) or abs(round(s * 10) - s * 10) > 1e-9:
            bad += 1
        if parse(build(metrics)) != metrics:
            bad += 1
        if severity(s) != severity(round(s, 1)):
            bad += 1
    print('  %d combinations checked, %d structural failures' % (len(combos), bad))
    if bad:
        failures.append('%d structural failures across combinations' % bad)

    print('== monotonicity ==')
    order_cia = ['N', 'L', 'H']
    mono_bad = 0
    base = {'AV': 'N', 'AC': 'L', 'PR': 'N', 'UI': 'N', 'S': 'U', 'C': 'N', 'I': 'N', 'A': 'N'}
    for slot in ('C', 'I', 'A'):
        prev = -1
        for val in order_cia:
            m = dict(base)
            m[slot] = val
            s = score(m)
            if s < prev - 1e-9:
                mono_bad += 1
            prev = s
    prev = -1
    for av in ('P', 'L', 'A', 'N'):
        m = dict(base)
        m['AV'] = av
        m['C'] = 'H'
        s = score(m)
        if s < prev - 1e-9:
            mono_bad += 1
        prev = s
    print('  %s' % ('PASS' if mono_bad == 0 else 'FAIL (%d)' % mono_bad))
    if mono_bad:
        failures.append('monotonicity violated %d times' % mono_bad)

    if args.browser:
        print('== shipped page results ==')
        with open(args.browser, encoding='utf-8') as f:
            browser = json.load(f)
        mismatches = 0
        for item in browser:
            expected = float(item['score'])
            got = score(parse(item['vector']))
            same = abs(expected - got) < 1e-9 and item.get('severity') == severity(got)
            if not same:
                mismatches += 1
                print('  FAIL %s page=%s reference=%.1f' % (item['vector'], item['score'], got))
        print('  %d/%d matched' % (len(browser) - mismatches, len(browser)))
        if mismatches:
            failures.append('%d browser mismatches' % mismatches)

    print()
    if failures:
        print('FAILED: %d problem(s)' % len(failures))
        for f in failures[:10]:
            print('  - %s' % f)
        return 1
    print('ALL CHECKS PASSED')
    return 0


if __name__ == '__main__':
    sys.exit(main())
