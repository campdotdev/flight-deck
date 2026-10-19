"""Write a local, self-contained audit page from measured logo geometry."""

import base64
import json
import mimetypes
import re
from pathlib import Path

HERE=Path(__file__).resolve().parent
m=json.loads((HERE/'measurements.json').read_text())
gap=m['airflow_gap']
layout=m['layout']
station_rows=''.join(f"<tr><td>{s['station_percent']}%</td><td>{s['width']:.2f}</td></tr>" for s in gap['stations'])
size_rows=''.join(f"<tr><td>{s['width_px']} px</td><td>{s['minimum_gap_in_output_pixels']:.2f} px</td><td>{'Separate' if s['components_at_half_coverage']==2 else 'Merged'}</td></tr>" for s in m['small_size_checks'])
chain_rows=''.join(f"<tr><td>{s['name']}</td><td>{s['segments']}</td><td>{c['curvature_sign_changes']}</td></tr>" for s,c in zip(m['chains'],m['curvature']))

html=f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flight Deck · 04 Compact geometry audit</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;background:#f7f8fa;color:#18212c;font:16px/1.6 system-ui,-apple-system,sans-serif}}
main{{max-width:1080px;margin:auto;padding:56px 28px 80px}}h1{{font-size:36px;letter-spacing:-1px;line-height:1.15;margin:8px 0 18px}}h2{{font-size:24px;line-height:1.3;letter-spacing:-.4px;margin:0 0 16px}}p{{max-width:78ch;margin:12px 0}}a{{color:#075c68;text-underline-offset:3px}}.eyebrow{{font-size:12px;letter-spacing:1.6px;color:#596577;text-transform:uppercase}}.lede{{font-size:18px;max-width:72ch}}.downloads{{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}}.downloads a{{background:#111b25;color:white;padding:9px 16px;border-radius:7px;text-decoration:none;font-size:14px}}section{{padding:32px;margin:28px 0;background:white;border:1px solid #e1e5ea;border-radius:12px}}.facts{{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin:24px 0 0}}.facts dt{{font-size:12px;color:#667281}}.facts dd{{font-size:24px;letter-spacing:-.5px;margin:3px 0 0}}.compare{{max-width:700px;position:relative;aspect-ratio:1;margin:0 auto;background:white;--cut:50%}}.compare img{{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}}.compare .vector{{clip-path:inset(0 calc(100% - var(--cut)) 0 0)}}.divider{{position:absolute;left:var(--cut);top:7%;bottom:7%;width:1px;background:#0d9488;pointer-events:none}}.compare-labels{{display:flex;justify-content:space-between;max-width:700px;margin:auto;color:#647082;font-size:13px}}.slider{{max-width:700px;margin:12px auto}}input[type=range]{{width:100%;accent-color:#0f766e}}label{{display:block;font-size:13px;color:#5e6b78}}figure{{margin:24px 0 0}}figure img{{max-width:100%;height:auto;display:block}}figcaption{{font-size:13px;color:#65717d;margin-top:10px}}table{{border-collapse:collapse;font-size:14px;width:100%;margin:18px 0}}th,td{{padding:10px 12px;border-bottom:1px solid #e5e9ed;text-align:left}}th{{color:#536373;font-size:12px;font-weight:600;background:#f7f9fb}}.two{{display:grid;grid-template-columns:1fr 1fr;gap:30px}}.note{{padding:14px 18px;background:#eef7f7;border-left:3px solid #0f766e;border-radius:0 6px 6px 0}}code{{font-size:13px;background:#f1f3f6;padding:2px 5px;border-radius:3px}}pre{{overflow:auto;background:#f1f3f6;padding:16px;border-radius:8px;font-size:13px;line-height:1.7}}pre code{{padding:0}}details{{margin-top:20px}}summary{{cursor:pointer;color:#075c68}}footer{{font-size:13px;color:#647082}}@media(max-width:650px){{main{{padding:28px 16px}}h1{{font-size:30px}}section{{padding:20px}}.facts{{grid-template-columns:1fr 1fr}}.two{{grid-template-columns:1fr}}}}
</style>
</head>
<body><main>
<div class="eyebrow">Flight Deck / selected concept 04</div>
<h1>Compact updraft geometry audit</h1>
<p class="lede">The selected design is now an editable vector. Its four sharp tips, two separate shapes, and compact lower curl are preserved.</p>
<p>The source was a 1254 × 1254 PNG. No earlier SVG existed. The mark was reconstructed as cubic Bézier paths, then checked against the source.</p>
<div class="downloads"><a href="flight-deck-04-mark.svg" download>Download mark SVG</a><a href="flight-deck-04-lockup.svg" download>Download logo with wordmark</a><a href="measurements.json" download>Download measurements</a></div>
<section>
<h2>Original and vector comparison</h2>
<div class="compare" id="compare"><img src="../04-compact-updraft.png" alt="Selected original 04 Compact logo"><img class="vector" src="flight-deck-04-preview.png" alt="Reconstructed 04 Compact SVG rendered at the same size"><div class="divider"></div></div>
<div class="compare-labels"><span>Reconstructed vector</span><span>Original PNG</span></div>
<div class="slider"><label for="reveal">Drag to compare at the original registration</label><input id="reveal" type="range" min="0" max="100" value="50"></div>
<dl class="facts"><div><dt>Filled mark paths</dt><dd>2</dd></div><div><dt>Cubic segments</dt><dd>{m['cubic_segments']}</dd></div><div><dt>Smooth joins</dt><dd>{m['smooth_join_count']}</dd></div><div><dt>Preserved sharp tips</dt><dd>4</dd></div></dl>
<p>The source-to-vector contour distance is below {m['source_to_vector_p95']:.2f} source pixels for 95% of sampled points. The largest sampled difference is {m['source_to_vector_max']:.2f} pixels. These figures compare the mark only.</p>
<details><summary>Show the contour overlay</summary><figure><img src="contour-overlay.png" alt="Gray source boundary and cyan vector contour aligned"><figcaption>The overlay compares both contours without changing their position or scale.</figcaption></figure></details>
</section>
<section>
<h2>Curve continuity</h2>
<p>All {m['smooth_join_count']} smooth joins have matching endpoints, tangent directions, and curvature within the export precision. The four pointed terminals remain intentional corners.</p>
<table><thead><tr><th>Check</th><th>Measured result</th></tr></thead><tbody>
<tr><td>Largest endpoint gap at a smooth join</td><td>{m['max_join_position_error']:.6f} units</td></tr>
<tr><td>Largest tangent mismatch</td><td>{m['max_join_tangent_error_degrees']:.9f}°</td></tr>
<tr><td>Largest curvature mismatch</td><td>{m['max_join_curvature_jump']:.2e} per unit</td></tr>
<tr><td>Closed, simple component outlines</td><td>2 of 2</td></tr>
<tr><td>Overlapping components</td><td>None detected</td></tr>
<tr><td>Minimum distance between components</td><td>{m['minimum_component_separation']:.2f} units</td></tr>
</tbody></table>
<p>The endpoint tangents come from 25-unit neighborhoods of the source contour. This removes a tiny reversal in the first fit caused by a pixel step near a tip. The main curves retain the source shape.</p>
<figure><img src="control-points.png" alt="Bezier anchor points, tangent handles, and the four sharp tips"><figcaption>Filled blue points mark anchors. Open blue points mark handles. Red diamonds mark the four sharp tips.</figcaption></figure>
<details><summary>Show curvature measurements</summary><p>Each curve chain runs between two sharp tips. A sign change records an inflection. The source includes reverse curves, so the count is not a defect count. Curvature is continuous at the internal joins; its rate of change is not constrained.</p><table><thead><tr><th>Curve chain</th><th>Segments</th><th>Curvature sign changes</th></tr></thead><tbody>{chain_rows}</tbody></table><figure><img src="curvature.png" alt="Curvature plotted along each of the four boundary chains"></figure></details>
</section>
<section>
<h2>Airflow spacing</h2>
<p>The gap ranges from {gap['minimum_width']:.2f} to {gap['maximum_width']:.2f} units. It reaches its broadest point about {gap['maximum_at_percent']:.0f}% along the shared channel, then narrows toward the tips. It opens slightly at the exit.</p>
<p>The widths preserve the original design. They were measured across the flow, perpendicular to the bisector of the two local edge tangents, at {gap['sample_count']} cross sections. The profile has one interior peak and one interior trough with prominence above 0.3 units.</p>
<figure><img src="spacing-audit.png" alt="Measured cross sections on the logo and a graph of airflow gap width"></figure>
<details><summary>Show gap widths at seven stations</summary><table><thead><tr><th>Distance along shared channel</th><th>Width in source units</th></tr></thead><tbody>{station_rows}</tbody></table></details>
</section>
<section>
<h2>Composition and small sizes</h2>
<div class="two"><div><p>The mark measures {m['mark_bounds']['width']:.2f} × {m['mark_bounds']['height']:.2f} units. The full logo preserves a {layout['symbol_to_wordmark_gap']:.2f}-unit gap above the wordmark.</p><p>The mark's bounding-box center sits {layout['mark_bbox_center_right_of_wordmark_center']:.2f} units right of the wordmark center. That offset comes from the selected composition and remains unchanged in intent. The standalone mark has 48 units of clear space on each side.</p></div><div><p class="note">32 pixels wide is the smallest tested 1× raster size at which the two shapes remain separate. At 16 and 24 pixels, the thresholded shapes merge.</p><p>Sizes refer to the full standalone SVG, including its padding. Raster tests use librsvg, a 50% alpha threshold, and 8-connected pixels. Rendering can vary with pixel alignment and display density.</p></div></div>
<table><thead><tr><th>Rendered width</th><th>Geometric minimum gap</th><th>Two shapes at 50% coverage</th></tr></thead><tbody>{size_rows}</tbody></table>
<figure><img src="small-size-audit.png" alt="Small logo renders enlarged on light and dark backgrounds"><figcaption>These are enlarged raster samples. They expose pixel behavior rather than simulate viewing at native size.</figcaption></figure>
</section>
<section>
<h2>Files and measurement method</h2>
<p>Both SVGs contain vector paths with transparent backgrounds. They contain no embedded raster image, live text, or external font dependency. The wordmark is a traced outline of the generated source, not a verified font master. The detailed curve audit covers the symbol.</p>
<p>The symbol uses cubic splines with constrained endpoints and one-sided endpoint tangents. The interior curves have continuous tangents and curvature. Coordinates are exported to six decimal places. Join checks use those rounded coordinates.</p>
<p>Bounds use the exact extrema of the cubic paths. Contour distances, curvature profiles, and intersection checks use dense curve samples. Those checks report sampled results, not an analytic proof for every point on the curves.</p>
<p>Source coordinates use one unit per pixel of the 1254 × 1254 PNG. <a href="geometry.json">Control geometry</a>, <a href="measurements.json">measurement data</a>, and <a href="original-vs-vector.png">the side-by-side comparison</a> accompany the exports.</p>
<details><summary>Rebuild and rerun the checks</summary><p>From the project root, with the dependencies in <a href="requirements.txt">requirements.txt</a> installed and <code>rsvg-convert</code> available:</p><pre><code>.venv/bin/python output/flight-deck/vector/build_logo.py
.venv/bin/python output/flight-deck/vector/audit_logo.py
.venv/bin/python output/flight-deck/vector/write_report.py</code></pre><p>The audit rejects open geometry, component overlaps, mismatched joins, missing vector-only exports, and excessive deviation from the source.</p></details>
</section>
<footer>Selected source: 04-compact-updraft.png. This audit preserves the selected concept and records its geometry and raster limits.</footer>
</main><script>const slider=document.getElementById('reveal');slider.addEventListener('input',()=>document.getElementById('compare').style.setProperty('--cut',slider.value+'%'));</script></body></html>'''
# Embed local assets so file viewers and isolated copies need no sibling files.
def asset_uri(relative_path):
    path=(HERE/relative_path).resolve()
    mime=mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    encoded=base64.b64encode(path.read_bytes()).decode('ascii')
    return f'data:{mime};base64,{encoded}'

html=re.sub(r'src="([^"]+)"',lambda match:f'src="{asset_uri(match[1])}"',html)

def embed_download(match):
    before,target,after=match.groups()
    before=re.sub(r'\sdownload(?:="[^"]*")?', '', before)
    after=re.sub(r'\sdownload(?:="[^"]*")?', '', after)
    return f'<a{before}href="{asset_uri(target)}"{after} download="{Path(target).name}">'

html=re.sub(r'<a\b([^>]*?)href="([^"]+)"([^>]*)>',embed_download,html)
(HERE/'audit.html').write_text(html)
print(HERE/'audit.html')
