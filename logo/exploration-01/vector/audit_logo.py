"""Measure exported geometry and draw evidence for the selected logo."""

from pathlib import Path
import json
import subprocess
import xml.etree.ElementTree as ET

import cv2
import numpy as np
from PIL import Image
from scipy.interpolate import CubicHermiteSpline
from scipy.optimize import brentq
from scipy.signal import find_peaks
from shapely.geometry import Polygon, LineString
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
geometry = json.loads((HERE/'geometry.json').read_text())
metrics = json.loads((HERE/'measurements.json').read_text())


def curve(chain):
    p = np.array(chain['segments'])
    t = np.array(chain['knots'])
    y = np.vstack([p[:, 0], p[-1, 3]])
    dy = np.vstack([3*(p[:, 1]-p[:, 0])/np.diff(t)[:, None], 3*(p[-1, 3]-p[-1, 2])/(t[-1]-t[-2])])
    return CubicHermiteSpline(t, y, dy)


curves = [curve(c) for c in geometry['chains']]
sample_u = np.linspace(0, 1, 4001)
outlines = [c(sample_u) for c in curves]
polygons = [Polygon(np.vstack(outlines[:2])), Polygon(np.vstack(outlines[2:]))]
upper, lower = curves[1], curves[2]
v_end = sample_u[np.argmin(outlines[2][:, 0])]
vs = np.linspace(0, v_end, 600)
ls = lower(vs)
lt = -lower(vs, 1)
lt /= np.linalg.norm(lt, axis=1)[:, None]
cross_sections = []
for u in np.linspace(0, 1, 1001):
    a = upper(u)
    ta = upper(u, 1)
    ta /= np.linalg.norm(ta)
    values = np.sum((ls-a)*(lt+ta), axis=1)
    candidate_indices = np.where(values[:-1]*values[1:] < 0)[0]
    candidates = []
    for i in candidate_indices:
        def equation(v):
            tb = -lower(v, 1)
            tb /= np.linalg.norm(tb)
            return np.dot(lower(v)-a, ta+tb)
        v = brentq(equation, vs[i], vs[i+1])
        b = lower(v)
        delta = b-a
        width = np.linalg.norm(delta)
        # Exclude intersections through either filled component.
        connector = LineString([a+0.001*delta, b-0.001*delta])
        if width < 150 and all(connector.intersection(p).length < 0.05 for p in polygons):
            candidates.append((width, b, v))
    if candidates:
        width, b, v = min(candidates, key=lambda x:x[0])
        cross_sections.append({'u':float(u), 'v':float(v), 'a':a.tolist(), 'b':b.tolist(), 'width':float(width)})

widths = np.array([x['width'] for x in cross_sections])
centers = np.array([(np.array(x['a'])+x['b'])/2 for x in cross_sections])
lengths = np.r_[0, np.cumsum(np.linalg.norm(np.diff(centers, axis=0), axis=1))]
fraction = lengths/lengths[-1]
stations = []
for percent in [0, 10, 25, 50, 75, 90, 100]:
    i = int(np.argmin(abs(fraction-percent/100)))
    stations.append({'station_percent': percent, **cross_sections[i]})
maxima, _ = find_peaks(widths, prominence=0.3)
minima, _ = find_peaks(-widths, prominence=0.3)

metrics['airflow_gap'] = {
    'method': 'Cross sections perpendicular to the bisector of the two local unit tangents, sampled along the shared channel.',
    'sample_count': len(widths),
    'minimum_width':float(widths.min()), 'maximum_width':float(widths.max()),
    'maximum_at_percent':float(fraction[np.argmax(widths)]*100),
    'interior_maxima_over_0_3_units':len(maxima),
    'interior_minima_over_0_3_units':len(minima),
    'stations':stations,
}

# Measure actual vector bounds without substituting a font.
source = np.array(Image.open(HERE.parent/'04-compact-updraft.png').convert('L')) < 128
y, x = np.where(source & (np.arange(source.shape[0])[:, None] >= 900))
text_bounds = metrics['vector_wordmark_bounds']
b = metrics['mark_bounds']
mark_center = b['x']+b['width']/2
text_center = (text_bounds[0]+text_bounds[2])/2
metrics['layout'] = {
    'wordmark_bounds':text_bounds,
    'symbol_to_wordmark_gap':text_bounds[1]-(b['y']+b['height']),
    'mark_bbox_center_right_of_wordmark_center':mark_center-text_center,
    'alignment_policy':'Preserve the selected composition. Do not treat its optical offset as a geometry error.',
    'standalone_mark_clear_space_each_side':48,
}

# Curvature signs diagnose unintended reverse bends away from sharp endpoints.
curvature_stats=[]
fig_curv, axes=plt.subplots(4,1,figsize=(10,10),constrained_layout=True)
for ax, c, desc in zip(axes, curves, geometry['chains']):
    t=np.linspace(0.001,0.999,3000)
    p=c(t)
    d1,d2=c(t,1),c(t,2)
    k=(d1[:,0]*d2[:,1]-d1[:,1]*d2[:,0])/np.linalg.norm(d1,axis=1)**3
    arc=np.r_[0,np.cumsum(np.linalg.norm(np.diff(p,axis=0),axis=1))]
    significant=np.sign(k[abs(k)>1e-5])
    reversals=int(np.count_nonzero(np.diff(significant)))
    curvature_stats.append({'chain':desc['name'],'curvature_sign_changes':reversals,'minimum_radius':float(1/np.max(abs(k)))})
    ax.plot(arc,k,color='#1d4ed8',lw=1.6)
    ax.axhline(0,color='#a0a8b5',lw=.6)
    ax.set_title(desc['name'],loc='left',fontsize=10)
    ax.set_xlabel('Arc length in source units',fontsize=9)
    ax.set_ylabel('Curvature',fontsize=9)
    ax.grid(alpha=.15)
fig_curv.savefig(HERE/'curvature.png',dpi=180)
plt.close(fig_curv)
metrics['curvature']=curvature_stats

# Export checks concern the actual files, including their outlined wordmark.
exports={}
for name in ['flight-deck-04-mark.svg','flight-deck-04-lockup.svg']:
    root=ET.parse(HERE/name).getroot()
    elements=list(root.iter())
    paths=[e for e in elements if e.tag.endswith('}path')]
    exports[name]={'path_count':sum(e.tag.endswith('}path') for e in elements),
                   'all_paths_explicitly_closed':all(e.attrib['d'].rstrip().upper().endswith('Z') for e in paths),
                   'embedded_raster_images':sum(e.tag.endswith('}image') for e in elements),
                   'live_text_elements':sum(e.tag.endswith('}text') for e in elements),
                   'bytes':(HERE/name).stat().st_size}
metrics['svg_exports']=exports
(HERE/'measurements.json').write_text(json.dumps(metrics,indent=2)+'\n')

# A diagram shows actual station positions rather than horizontal gap guesses.
fig, (ax, ax_gap)=plt.subplots(1,2,figsize=(15,8),gridspec_kw={'width_ratios':[1.35,1]},constrained_layout=True)
for p in polygons:
    xx,yy=p.exterior.xy
    ax.fill(xx,yy,color='#111111')
for i, s in enumerate(stations):
    a,bp=np.array(s['a']),np.array(s['b'])
    mid=(a+bp)/2
    ax.plot([a[0],bp[0]],[a[1],bp[1]],color='#15b8a6',lw=2)
    ax.scatter([a[0],bp[0]],[a[1],bp[1]],s=12,color='#15b8a6',zorder=3)
    ax.annotate(str(s['station_percent'])+'%',mid,xytext=(0,-13),textcoords='offset points',ha='center',fontsize=9,color='#0f766e',bbox={'facecolor':'white','alpha':.92,'edgecolor':'none','pad':1.5})
ax.set_xlim(270,1040)
ax.set_ylim(910,180)
ax.set_aspect('equal')
ax.axis('off')
ax.set_title('04 Compact / measured airflow channel',loc='left',fontsize=16,pad=20)
ax_gap.plot(fraction*100,widths,color='#0f766e',lw=2.5)
for s in stations:
    i=int(np.argmin(abs(fraction-s['station_percent']/100)))
    ax_gap.scatter(fraction[i]*100,s['width'],color='#0f766e',s=25)
    ax_gap.annotate(f"{s['width']:.1f}",(fraction[i]*100,s['width']),xytext=(0,10),textcoords='offset points',ha='center',fontsize=10)
ax_gap.set_xlabel('Distance along the shared channel, %')
ax_gap.set_ylabel('Gap width, source units')
ax_gap.set_ylim(0,max(widths)+18)
ax_gap.set_xlim(-4,104)
ax_gap.spines[['top','right']].set_visible(False)
ax_gap.grid(alpha=.15)
ax_gap.set_title('Width measured across the flow',loc='left',fontsize=14,pad=20)
fig.savefig(HERE/'spacing-audit.png',dpi=160)
plt.close(fig)

# Control points and tangents make path construction reviewable.
fig, ax=plt.subplots(figsize=(10,9))
for pts in outlines:
    ax.plot(pts[:,0],pts[:,1],color='#111111',lw=1.8)
for chain in geometry['chains']:
    for segment in chain['segments']:
        p=np.array(segment)
        ax.plot(p[:2,0],p[:2,1],color='#a5b4fc',lw=.8)
        ax.plot(p[2:,0],p[2:,1],color='#a5b4fc',lw=.8)
        ax.scatter(p[[1,2],0],p[[1,2],1],s=13,facecolors='white',edgecolors='#6366f1',linewidths=.8,zorder=3)
        ax.scatter(p[[0,3],0],p[[0,3],1],s=17,color='#4338ca',zorder=4)
for c in curves:
    p=c(0)
    ax.scatter(p[0],p[1],s=55,marker='D',facecolors='white',edgecolors='#e11d48',linewidths=1.5,zorder=5)
ax.set_aspect('equal')
ax.set_xlim(270,1040)
ax.set_ylim(910,180)
ax.axis('off')
ax.set_title(f"{metrics['cubic_segments']} cubic segments / 4 intentional sharp tips",loc='left',fontsize=15,pad=20)
fig.tight_layout()
fig.savefig(HERE/'control-points.png',dpi=160)
plt.close(fig)

# This audit fails if a future edit changes a checked invariant.
assert metrics['valid_simple_closed_components']
assert not metrics['components_overlap']
assert metrics['max_join_position_error'] < 1e-5
assert metrics['max_join_tangent_error_degrees'] < 0.001
assert metrics['max_join_curvature_jump'] < 1e-6
assert metrics['source_to_vector_p95'] < 1
assert metrics['source_to_vector_max'] < 2
assert len(widths)>500
assert all(e['embedded_raster_images']==0 and e['live_text_elements']==0 for e in exports.values())
assert all(e['all_paths_explicitly_closed'] for e in exports.values())

# Render the actual SVG at small output widths and inspect pixel topology.
small_dir=HERE/'size-checks'
small_dir.mkdir(exist_ok=True)
sizes=[16,24,32,48,64,96]
checks=[]
small_images=[]
for size in sizes:
    dest=small_dir/f'{size}.png'
    subprocess.run(['rsvg-convert','-w',str(size),'-o',str(dest),str(HERE/'flight-deck-04-mark.svg')],check=True)
    im=Image.open(dest).convert('RGBA')
    alpha=np.array(im)[:,:,3]
    n, labels, stats, _=cv2.connectedComponentsWithStats((alpha>=128).astype('uint8'),connectivity=8)
    checks.append({'width_px':size,'height_px':im.height,'components_at_half_coverage':int(n-1),
                   'component_areas_px':sorted([int(x) for x in stats[1:,cv2.CC_STAT_AREA]],reverse=True),
                   'minimum_gap_in_output_pixels':metrics['minimum_component_separation']*size/(metrics['mark_bounds']['width']+96)})
    small_images.append(im)
metrics['small_size_checks']=checks

fig, axes=plt.subplots(2,len(sizes),figsize=(14,5),constrained_layout=True)
for col,(size,im) in enumerate(zip(sizes,small_images)):
    rgba=np.array(im)/255
    for row in [0,1]:
        ax=axes[row,col]
        bg=1.0 if row==0 else 0.06
        ink=0.0 if row==0 else 1.0
        rgb=np.repeat((bg*(1-rgba[:,:,3])+ink*rgba[:,:,3])[:,:,None],3,axis=2)
        ax.imshow(rgb,interpolation='nearest')
        ax.axis('off')
        if row==0:
            ax.set_title(f'{size} px',fontsize=12,pad=12)
fig.suptitle('Actual raster output, enlarged to show pixel structure',fontsize=15)
fig.savefig(HERE/'small-size-audit.png',dpi=150)
plt.close(fig)

fig, axes=plt.subplots(1,2,figsize=(13,7),constrained_layout=True)
for ax,name,title in zip(axes,[HERE.parent/'04-compact-updraft.png',HERE/'flight-deck-04-preview.png'],['Selected original 04 / PNG','Reconstructed vector / SVG']):
    im=Image.open(name).crop((270,180,1040,910))
    ax.imshow(im)
    ax.axis('off')
    ax.set_title(title,loc='left',fontsize=14,pad=16)
fig.savefig(HERE/'original-vs-vector.png',dpi=160)
plt.close(fig)

# Show the fitted contour against the source edge at the same registration.
source_points=[]
source_mark=source.copy()
source_mark[900:]=False
contours,_=cv2.findContours(source_mark.astype('uint8'),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)
fig,ax=plt.subplots(figsize=(9,8))
for c in sorted(contours,key=cv2.contourArea,reverse=True)[:2]:
    p=c[:,0]+.5
    ax.plot(p[:,0],p[:,1],color='#94a3b8',lw=2,label='Source pixel boundary' if not source_points else None)
    source_points.append(p)
for i,p in enumerate(outlines):
    ax.plot(p[:,0],p[:,1],color='#0891b2',lw=.8,label='SVG contour' if i==0 else None)
ax.set_xlim(270,1040)
ax.set_ylim(910,180)
ax.set_aspect('equal')
ax.axis('off')
ax.legend(loc='upper left',frameon=False)
fig.tight_layout()
fig.savefig(HERE/'contour-overlay.png',dpi=200)
plt.close(fig)

(HERE/'measurements.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(json.dumps({'small_size_checks':checks,'checks':'passed','airflow_width_range':[float(widths.min()),float(widths.max())]},indent=2))
