#!/usr/bin/env python3
"""Build Customer.io-ready HTML email templates from docs/crm-content.md.

Usage: python3 docs/build-email-templates.py [docs/crm-content.md]
Writes docs/email-templates/<ID>.html (one per template) + index.html (gallery).
Liquid tags ({{customer.x}}, {{event.x}}, {% if %}) pass through untouched -
Customer.io renders them. Inline CSS only, 600px, dark-first, table layout:
the same visual world as the Reward Hub (violet #C4B5FD on #0B0B10, lime for
money, the Megapot wordmark as text)."""
import re, sys, html, pathlib

SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/crm-content.md')
OUT = pathlib.Path('docs/email-templates'); OUT.mkdir(parents=True, exist_ok=True)
HUB = 'https://app.hence.markets/#/rewards'
CTA_LINKS = {  # where each button goes; everything else lands on the hub
    'trade': 'https://app.hence.markets/#/terminal/HYPE',
}

def parse(md):
    tpls = []
    for block in re.split(r'^## ', md, flags=re.M)[1:]:
        head, _, rest = block.partition('\n')
        m = re.match(r'([A-D]\d)\s*·\s*(.*)', head.strip())
        if not m: continue
        tid, trig = m.group(1), m.group(2).strip()
        subj = re.search(r'\*\*Subject:\*\*\s*(.*)', rest); pre = re.search(r'\*\*Preheader:\*\*\s*(.*)', rest)
        cta = re.search(r'\*\*Button:\*\*\s*(.*)', rest)
        body = re.sub(r'\*\*(Subject|Preheader|Button):\*\*.*\n?', '', rest).strip()
        tpls.append(dict(id=tid, trig=trig, subj=subj.group(1).strip() if subj else '', pre=pre.group(1).strip() if pre else '',
                         body=body, cta=cta.group(1).strip() if cta else 'Open the Reward Hub'))
    return tpls

def liquid_safe(s):
    """escape HTML but leave Liquid tags intact"""
    parts = re.split(r'(\{\{.*?\}\}|\{%.*?%\})', s)
    return ''.join(p if p.startswith('{') else html.escape(p) for p in parts)

def paragraphs(body):
    out = []
    for para in [p for p in body.split('\n\n') if p.strip()]:
        out.append(f'<p style="margin:0 0 16px;font:400 16px/1.6 Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#C9C7D6;">{liquid_safe(para.strip()).replace(chr(10), "<br>")}</p>')
    return '\n'.join(out)

FLOW_LABEL = {'A': 'Your first pack', 'B': 'Streak', 'C': 'Your tickets', 'D': 'Season 1'}
FLOW_COLOR = {'A': '#C4B5FD', 'B': '#F0C674', 'C': '#7CD486', 'D': '#C4B5FD'}

def render(t):
    href = CTA_LINKS['trade'] if re.search(r'trade|open (my )?(pack|box)|get in|keep the streak|ride', t['cta'], re.I) else HUB
    accent = FLOW_COLOR[t['id'][0]]
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>{liquid_safe(t['subj'])}</title></head>
<body style="margin:0;padding:0;background:#0B0B10;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0B0B10;">{liquid_safe(t['pre'])}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0B10;">
<tr><td align="center" style="padding:28px 12px 40px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 6px 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:800 15px/1 Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#F4F3F8;letter-spacing:.02em;">&#9679;&#8202;Hence</td>
      <td align="right" style="font:700 11px/1 Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#8A879A;letter-spacing:.16em;text-transform:uppercase;">Powered by <span style="color:#F4F3F8;font-style:italic;font-weight:900;">MEGAPOT</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#15151C;border:2px solid #26262F;border-radius:20px;padding:34px 34px 30px;">
    <div style="font:800 11px/1 Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:{accent};letter-spacing:.18em;text-transform:uppercase;margin:0 0 14px;">{FLOW_LABEL[t['id'][0]]}</div>
    <h1 style="margin:0 0 18px;font:900 28px/1.15 'Archivo Black',Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#F4F3F8;letter-spacing:-.01em;">{liquid_safe(t['subj'])}</h1>
    {paragraphs(t['body'])}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px;"><tr>
      <td style="border-radius:999px;background:#FFFFFF;box-shadow:0 4px 0 #2C2547;">
        <a href="{href}" style="display:inline-block;padding:15px 30px;font:800 15px/1 Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0B0B10;text-decoration:none;border-radius:999px;">{liquid_safe(t['cta'])} &rarr;</a>
      </td></tr></table>
  </td></tr>
  <tr><td style="padding:18px 8px 0;font:400 11.5px/1.6 Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6F6F80;">
    Tickets mint non-custodially to your own wallet on Base; draws, odds and payouts are run by Megapot under <a href="https://megapot.io/terms" style="color:#8A879A;">Megapot's terms</a>. Hence does not guarantee rewards. Not available where prohibited.<br>
    You get this because you linked your email in the Reward Hub. <a href="{{{{ unsubscribe_url }}}}" style="color:#8A879A;">Unsubscribe</a> &middot; <a href="{HUB}" style="color:#8A879A;">Reward Hub</a>
  </td></tr>
</table></td></tr></table>
</body></html>
'''

tpls = parse(SRC.read_text())
cards = []
for t in tpls:
    (OUT / f"{t['id']}.html").write_text(render(t))
    cards.append(f'<a href="{t["id"]}.html" style="display:block;padding:14px 16px;border:1px solid #26262F;border-radius:12px;color:#F4F3F8;text-decoration:none;margin:0 0 10px;background:#15151C;"><b style="color:#C4B5FD;font-family:monospace;">{t["id"]}</b> &middot; <span style="color:#8A879A;">{html.escape(t["trig"])}</span><br><span style="font-size:15px;">{liquid_safe(t["subj"])}</span></a>')
(OUT / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Megapot email templates</title><body style="margin:0;padding:32px;background:#0B0B10;font-family:Inter,-apple-system,sans-serif;"><div style="max-width:720px;margin:0 auto;"><h1 style="color:#F4F3F8;">Megapot Season 1 - email templates</h1><p style="color:#8A879A;">Built from docs/crm-content.md. Liquid tags render in Customer.io.</p>' + ''.join(cards) + '</div></body>')
print(f'{len(tpls)} templates -> {OUT}/')
