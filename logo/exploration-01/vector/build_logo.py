"""Reconstruct the selected PNG as sparse, continuous cubic Bezier paths."""

from pathlib import Path
import json
import subprocess

import cv2
import numpy as np
import potrace
from PIL import Image
from scipy.interpolate import BSpline
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree
from scipy.optimize import lsq_linear
from shapely.geometry import Polygon, LineString


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / '04-compact-updraft.png'
gray = np.array(Image.open(SOURCE).convert('L'))
mask = gray < 128
mark_mask = mask.copy()
mark_mask[900:] = False
contours, _ = cv2.findContours(mark_mask.astype('uint8'), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
contours = sorted(contours, key=cv2.contourArea, reverse=True)[:2]
lower, upper = [c[:, 0].astype(float) + 0.5 for c in contours]


def split_contour(points, a, b):
    ia = np.argmin(np.linalg.norm(points - a, axis=1))
    ib = np.argmin(np.linalg.norm(points - b, axis=1))
    rolled = np.roll(points, -ia, axis=0)
    ib = (ib - ia) % len(points)
    return rolled[:ib + 1], np.vstack([rolled[ib:], rolled[0]])


def fit_chain(points, label):
    # Smooth pixel stair steps, without altering the two deliberate sharp ends.
    q = gaussian_filter1d(points, 1.6, axis=0, mode='nearest')
    q[0], q[-1] = points[0], points[-1]
    arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(q, axis=0), axis=1))]
    u = arc/arc[-1]
    # Estimate each sharp tip's two one-sided tangents from a 25-unit
    # neighborhood. A raster's last stair-step must not create a tiny hook.
    first = arc <= 25
    last = arc >= arc[-1]-25
    tangent_start = np.polyfit(arc[first], q[first], 2)[1]
    tangent_end = np.polyfit(arc[last]-arc[-1], q[last], 2)[1]
    tangent_start /= np.linalg.norm(tangent_start)
    tangent_end /= np.linalg.norm(tangent_end)
    knots = [0.5]
    for iteration in range(12):
        t = np.r_[[0.] * 4, sorted(knots), [1.] * 4]
        # Reparameterize each sample onto the fitted curve. This avoids extra
        # knots that compensate for pixel-dependent contour traversal speed.
        for refine in range(60):
            A = BSpline.design_matrix(u, t, 3).toarray()
            rhs = q - (A[:, :1]+A[:, 1:2])*q[0] - (A[:, -2:-1]+A[:, -1:])*q[-1]
            middle_count = A.shape[1]-4
            M = np.zeros((2*len(q), 2+2*middle_count))
            M[:,0] = (A[:,1:2]*tangent_start).ravel()
            M[:,1] = (-A[:,-2:-1]*tangent_end).ravel()
            for j in range(middle_count):
                M[::2,2+2*j] = A[:,j+2]
                M[1::2,3+2*j] = A[:,j+2]
            solution = np.linalg.lstsq(M, rhs.ravel(), rcond=None)[0]
            if min(solution[:2]) < 1:
                low = np.r_[[1.,1.], [-np.inf]*(2*middle_count)]
                solution = lsq_linear(M, rhs.ravel(), bounds=(low,np.inf)).x
            c = np.vstack([q[0], q[0]+solution[0]*tangent_start,
                           solution[2:].reshape(-1,2), q[-1]-solution[1]*tangent_end, q[-1]])
            spline = BSpline(t, c, 3)
            residual = spline(u)-q
            first, second = spline(u, 1), spline(u, 2)
            numerator = np.sum(residual*first, axis=1)
            denominator = np.sum(first*first + residual*second, axis=1)
            step = np.clip(numerator/np.maximum(denominator, 1e-10), -0.01, 0.01)
            u = np.clip(u-step, 0, 1)
            u[0], u[-1] = 0, 1
            u = np.maximum.accumulate(u)
        error = np.linalg.norm(spline(u) - q, axis=1)
        if np.percentile(error, 95) < 0.65 and error.max() < 1.2:
            break
        ranked = np.argsort(gaussian_filter1d(error, 5))[::-1]
        for index in ranked:
            candidate = u[index]
            if min(abs(candidate - np.array([0., *knots, 1.]))) > 0.04:
                knots.append(float(candidate))
                break
        else:
            break
    breaks = np.unique(t)
    pieces = []
    for a, b in zip(breaks[:-1], breaks[1:]):
        step = b - a
        p0, p3 = spline(a), spline(b)
        p1 = p0 + step * spline(a, 1) / 3
        p2 = p3 - step * spline(b, 1) / 3
        pieces.append(np.array([p0, p1, p2, p3]))
    return {'name': label, 'spline': spline, 'pieces': pieces, 'points': points,
            'breaks': breaks, 'fit_p95': float(np.percentile(error, 95)), 'fit_max': float(error.max())}


ua, ub = split_contour(upper, (987.5, 236.5), (326.5, 672.5))
la, lb = split_contour(lower, (950.5, 344.5), (746.5, 729.5))
chains = [fit_chain(p, label) for p, label in zip(
    [ua, ub, la, lb], ['upper-outer', 'upper-channel', 'lower-channel-and-base', 'lower-inner-curl'])]


def f(n):
    return f'{float(n):.6f}'.rstrip('0').rstrip('.')


def pair(p):
    if hasattr(p, 'x'):
        return f'{f(p.x)},{f(p.y)}'
    return f'{f(p[0])},{f(p[1])}'


def path_data(parts):
    pieces = [piece for chain in parts for piece in chain['pieces']]
    d = 'M ' + pair(pieces[0][0])
    for p in pieces:
        d += ' C ' + ' '.join(pair(v) for v in p[1:])
    return d + ' Z'


def extrema(p):
    """Evaluate a cubic at its endpoints and exact axis extrema."""
    p = np.asarray(p, dtype=float)
    ts = [0., 1.]
    a = 3*(-p[0]+3*p[1]-3*p[2]+p[3])
    b = 6*(p[0]-2*p[1]+p[2])
    c = 3*(p[1]-p[0])
    for axis in [0, 1]:
        for root in np.roots([a[axis], b[axis], c[axis]]):
            if abs(root.imag) < 1e-10 and 0 < root.real < 1:
                ts.append(float(root.real))
    return np.array([(1-t)**3*p[0]+3*(1-t)**2*t*p[1]+3*(1-t)*t*t*p[2]+t**3*p[3] for t in ts])


upper_d, lower_d = path_data(chains[:2]), path_data(chains[2:])
mark_paths = f'<path id="upper-airfoil" d="{upper_d}"/>\n<path id="lower-bank" d="{lower_d}"/>'

# Preserve the chosen wordmark as outlines. There is no known source font.
text_raster = cv2.resize(gray[920:1055, 295:960], None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
traced = potrace.Bitmap(text_raster).trace(turdsize=12, alphamax=1.0, opttolerance=0.4)
def text_pair(p):
    return pair((p.x/4+295, p.y/4+920))
text_parts = []
text_extrema = []
for curve in traced:
    d = 'M ' + text_pair(curve.start_point)
    current = np.array([curve.start_point.x/4+295, curve.start_point.y/4+920])
    text_extrema.append(current)
    for segment in curve:
        endpoint = np.array([segment.end_point.x/4+295, segment.end_point.y/4+920])
        if segment.is_corner:
            d += ' L ' + text_pair(segment.c) + ' L ' + text_pair(segment.end_point)
            text_extrema.extend([[segment.c.x/4+295, segment.c.y/4+920], endpoint])
        else:
            d += ' C ' + ' '.join(text_pair(p) for p in [segment.c1, segment.c2, segment.end_point])
            controls = [current, [segment.c1.x/4+295, segment.c1.y/4+920],
                        [segment.c2.x/4+295, segment.c2.y/4+920], endpoint]
            text_extrema.extend(extrema(controls))
        current = endpoint
    text_parts.append(d + ' Z')
wordmark = '<path id="wordmark" fill-rule="evenodd" d="' + ' '.join(text_parts) + '"/>'


def svg(contents, viewbox, title, background=False):
    vb = ' '.join(f(n) for n in viewbox)
    back = f'<rect x="{f(viewbox[0])}" y="{f(viewbox[1])}" width="{f(viewbox[2])}" height="{f(viewbox[3])}" fill="white"/>' if background else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-labelledby="title">
<title id="title">{title}</title>
{back}
<g fill="#000000">{contents}</g>
</svg>\n'''


samples = [c['spline'](np.linspace(0, 1, 4001)) for c in chains]
all_points = np.vstack(samples)
exact_points = np.vstack([extrema(p) for c in chains for p in c['pieces']])
mn, mx = exact_points.min(axis=0), exact_points.max(axis=0)
pad = 48.
mark_viewbox = [mn[0]-pad, mn[1]-pad, mx[0]-mn[0]+2*pad, mx[1]-mn[1]+2*pad]
(HERE / 'flight-deck-04-mark.svg').write_text(svg(mark_paths, mark_viewbox, 'Flight Deck compact updraft mark'))
(HERE / 'flight-deck-04-lockup.svg').write_text(svg(mark_paths + '\n' + wordmark, [0, 0, 1254, 1254], 'Flight Deck compact updraft logo'))
(HERE / 'preview.svg').write_text(svg(mark_paths + '\n' + wordmark, [0, 0, 1254, 1254], 'Flight Deck compact updraft logo', True))
subprocess.run(['rsvg-convert', '-w', '1254', '-h', '1254', '-o', str(HERE / 'flight-deck-04-preview.png'), str(HERE / 'preview.svg')], check=True)

# Compare both directions to avoid hiding a protrusion in either outline.
source_points = np.vstack([upper, lower])
vector_tree, raster_tree = cKDTree(all_points), cKDTree(source_points)
source_to_vector = vector_tree.query(source_points)[0]
vector_to_source = raster_tree.query(all_points)[0]

joins = []
for chain in chains:
    for i, (a, b) in enumerate(zip(chain['pieces'][:-1], chain['pieces'][1:])):
        # Audit the serialized precision, not only the full-precision fit.
        a, b = np.round(a, 6), np.round(b, 6)
        va, vb = a[3] - a[2], b[1] - b[0]
        cross = va[0]*vb[1] - va[1]*vb[0]
        angle = np.degrees(np.arctan2(abs(cross), np.dot(va, vb)))
        da, db = 3*va, 3*vb
        dda, ddb = 6*(a[3]-2*a[2]+a[1]), 6*(b[2]-2*b[1]+b[0])
        curvature_a = (da[0]*dda[1]-da[1]*dda[0]) / np.linalg.norm(da)**3
        curvature_b = (db[0]*ddb[1]-db[1]*ddb[0]) / np.linalg.norm(db)**3
        joins.append({'chain': chain['name'], 'join': i+1,
                      'position_error': float(np.linalg.norm(a[3]-b[0])),
                      'tangent_error_degrees': float(angle),
                      'curvature_jump': float(abs(curvature_a-curvature_b))})

polygons = [Polygon(np.vstack(samples[:2])), Polygon(np.vstack(samples[2:]))]
metrics = {
    'source': SOURCE.name,
    'units': 'source pixels on the 1254 by 1254 source canvas',
    'mark_bounds': {'x': float(mn[0]), 'y': float(mn[1]), 'width': float(mx[0]-mn[0]), 'height': float(mx[1]-mn[1])},
    'vector_wordmark_bounds': np.r_[np.min(text_extrema,axis=0), np.max(text_extrema,axis=0)].tolist(),
    'mark_components': 2,
    'cubic_segments': sum(len(c['pieces']) for c in chains),
    'intentional_sharp_tips': 4,
    'smooth_join_count': len(joins),
    'max_join_tangent_error_degrees': max(j['tangent_error_degrees'] for j in joins),
    'max_join_position_error': max(j['position_error'] for j in joins),
    'max_join_curvature_jump': max(j['curvature_jump'] for j in joins),
    'valid_simple_closed_components': all(p.is_valid for p in polygons),
    'components_overlap': polygons[0].intersects(polygons[1]),
    'minimum_component_separation': float(polygons[0].distance(polygons[1])),
    'source_to_vector_p95': float(np.percentile(source_to_vector, 95)),
    'source_to_vector_max': float(source_to_vector.max()),
    'vector_to_source_p95': float(np.percentile(vector_to_source, 95)),
    'vector_to_source_max': float(vector_to_source.max()),
    'chains': [{k: c[k] for k in ['name', 'fit_p95', 'fit_max']} | {'segments':len(c['pieces'])} for c in chains],
    'joins': joins,
}
(HERE / 'geometry.json').write_text(json.dumps({'chains': [
    {'name':c['name'], 'segments':[p.tolist() for p in c['pieces']], 'knots':c['breaks'].tolist()}
    for c in chains]}, indent=2)+'\n')
(HERE / 'measurements.json').write_text(json.dumps(metrics, indent=2)+'\n')
print(json.dumps({k:v for k,v in metrics.items() if k not in ['joins']}, indent=2))
