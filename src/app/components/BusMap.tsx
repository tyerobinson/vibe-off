'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Bus, BusesResponse } from '@/app/api/buses/route';

const TILE_URL = process.env.NEXT_PUBLIC_TILE_URL!;

const PHOENIX_CENTER: [number, number] = [-112.07, 33.45];
const POLL_INTERVAL_MS = 3_000;
const TRAIL_MAX_POINTS = 60;
// Stretch the move across roughly the full poll window so dots glide
// continuously between refreshes instead of teleporting.
const ANIMATE_DURATION_MS = 2_800;

const ROUTE_PALETTE = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#bab0ac',
];

const CHARACTERS = [
  'baby-daisy',
  'baby-luigi',
  'baby-mario',
  'baby-peach',
  'baby-rosalina',
  'bowser',
  'bowser-jr',
  'cat-peach',
  'daisy',
  'diddy-kong',
  'donkey-kong',
  'dry-bones',
  'dry-bowser',
  'funky-kong',
  'gold-mario',
  'iggy',
  'inkling-boy',
  'inkling-girl',
  'isabelle',
  'kamek',
  'king-boo',
  'koopa-troopa',
  'lakitu',
  'larry',
  'lemmy',
  'link',
  'ludwig',
  'luigi',
  'mario',
  'metal-mario',
  'morton',
  'pauline',
  'peach',
  'peachette',
  'petey-piranha',
  'pink-gold-peach',
  'rosalina',
  'roy',
  'shy-guy',
  'shy-guy-black',
  'shy-guy-blue',
  'shy-guy-green',
  'shy-guy-light-blue',
  'shy-guy-orange',
  'shy-guy-pink',
  'shy-guy-white',
  'shy-guy-yellow',
  'tanooki-mario',
  'toad',
  'toadette',
  'villager-female',
  'villager-male',
  'waluigi',
  'wario',
  'wendy',
  'wiggler',
  'yoshi',
  'yoshi-black',
  'yoshi-blue',
  'yoshi-light-blue',
  'yoshi-orange',
  'yoshi-pink',
  'yoshi-red',
  'yoshi-white',
  'yoshi-yellow',
] as const;

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function colorForRoute(routeId: string): string {
  return ROUTE_PALETTE[hashString(routeId) % ROUTE_PALETTE.length];
}

function characterForBus(busId: string): string {
  return CHARACTERS[hashString(busId) % CHARACTERS.length];
}

function trailsToGeoJson(
  history: Map<string, [number, number][]>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const points of history.values()) {
    if (points.length < 2) continue;
    const maxIdx = points.length - 1;
    for (let i = 0; i < maxIdx; i += 1) {
      // Newest segments get the warm end of the rainbow (hue 0 = red).
      // Older segments shift toward violet (hue ~280).
      const age = maxIdx - 1 - i;
      const t = maxIdx <= 1 ? 0 : age / (maxIdx - 1);
      const hue = t * 280;
      const opacity = 0.85 * (1 - t * 0.7);
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [points[i], points[i + 1]],
        },
        properties: {
          color: `hsl(${hue.toFixed(0)}, 95%, 55%)`,
          opacity,
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

type BusAnim = {
  from: [number, number];
  to: [number, number];
  start: number;
  duration: number;
  props: Record<string, unknown>;
};

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function animsToGeoJson(
  anims: Map<string, BusAnim>,
  now: number,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const a of anims.values()) {
    const raw = a.duration > 0 ? (now - a.start) / a.duration : 1;
    const t = easeInOut(Math.max(0, Math.min(1, raw)));
    const lng = a.from[0] + (a.to[0] - a.from[0]) * t;
    const lat = a.from[1] + (a.to[1] - a.from[1]) * t;
    const dx = a.to[0] - a.from[0];
    const dy = a.to[1] - a.from[1];
    let bearing = (a.props.bearing as number | undefined) ?? 0;
    let hasBearing = bearing !== 0;
    if (Math.abs(dx) + Math.abs(dy) > 1e-7) {
      bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      hasBearing = true;
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { ...a.props, bearing, hasBearing },
    });
  }
  return { type: 'FeatureCollection', features };
}

function busProps(b: Bus): Record<string, unknown> {
  return {
    id: b.id,
    routeId: b.routeId,
    directionId: b.directionId,
    bearing: b.bearing ?? 0,
    speed: b.speed,
    status: b.status,
    label: b.label,
    color: colorForRoute(b.routeId),
    character: characterForBus(b.id),
  };
}

export function BusMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sourceReadyRef = useRef(false);
  const latestTrailsRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const historyRef = useRef<Map<string, [number, number][]>>(new Map());
  const animsRef = useRef<Map<string, BusAnim>>(new Map());
  const rafRef = useRef<number | null>(null);
  const [busCount, setBusCount] = useState<number | null>(null);
  const [feedTimestamp, setFeedTimestamp] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs:
          'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
        sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
        sources: {
          protomaps: {
            type: 'vector',
            url: TILE_URL,
            attribution:
              '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
          },
        },
        layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }),
      },
      center: PHOENIX_CENTER,
      zoom: 10,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', async () => {
      await Promise.all(
        CHARACTERS.map(async (name) => {
          try {
            const img = await map.loadImage(`/characters/${name}.png`);
            if (!map.hasImage(name)) {
              map.addImage(name, img.data);
            }
          } catch {
            // ignore individual image failures; symbol layer will skip
          }
        }),
      );

      const arrowCanvas = document.createElement('canvas');
      arrowCanvas.width = 64;
      arrowCanvas.height = 64;
      const arrowCtx = arrowCanvas.getContext('2d');
      if (arrowCtx) {
        arrowCtx.fillStyle = 'rgba(15, 17, 22, 0.92)';
        arrowCtx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        arrowCtx.lineWidth = 3;
        arrowCtx.lineJoin = 'round';
        arrowCtx.beginPath();
        arrowCtx.moveTo(32, 3);
        arrowCtx.lineTo(58, 34);
        arrowCtx.lineTo(42, 34);
        arrowCtx.lineTo(42, 60);
        arrowCtx.lineTo(22, 60);
        arrowCtx.lineTo(22, 34);
        arrowCtx.lineTo(6, 34);
        arrowCtx.closePath();
        arrowCtx.fill();
        arrowCtx.stroke();
        if (!map.hasImage('bus-arrow')) {
          map.addImage(
            'bus-arrow',
            arrowCtx.getImageData(0, 0, 64, 64),
          );
        }
      }

      map.addSource('bus-trails', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'bus-trails-line',
        type: 'line',
        source: 'bus-trails',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': ['get', 'opacity'],
          'line-width': 3,
        },
      });

      map.addSource('buses', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'buses-halo',
        type: 'circle',
        source: 'buses',
        paint: {
          'circle-radius': 14,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.25,
          'circle-stroke-width': 2,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': 0.6,
        },
      });

      map.addLayer({
        id: 'buses-arrow',
        type: 'symbol',
        source: 'buses',
        filter: ['==', ['get', 'hasBearing'], true],
        layout: {
          'icon-image': 'bus-arrow',
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-anchor': 'bottom',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8, 0.22,
            12, 0.38,
            16, 0.6,
          ],
        },
      });

      map.addLayer({
        id: 'buses-icon',
        type: 'symbol',
        source: 'buses',
        layout: {
          'icon-image': ['get', 'character'],
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8, 0.15,
            12, 0.28,
            16, 0.45,
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-anchor': 'center',
        },
      });

      map.addLayer({
        id: 'buses-label',
        type: 'symbol',
        source: 'buses',
        minzoom: 12,
        layout: {
          'text-field': ['get', 'routeId'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#111',
          'text-halo-color': '#fff',
          'text-halo-width': 1.2,
        },
      });

      sourceReadyRef.current = true;

      if (animsRef.current.size > 0) {
        const src = map.getSource('buses') as
          | maplibregl.GeoJSONSource
          | undefined;
        src?.setData(animsToGeoJson(animsRef.current, performance.now()));
      }
      if (latestTrailsRef.current) {
        const src = map.getSource('bus-trails') as
          | maplibregl.GeoJSONSource
          | undefined;
        src?.setData(latestTrailsRef.current);
      }

      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      map.on('mouseenter', 'buses-icon', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, unknown>;
        const html = `
          <div style="font-size:12px;color:#111;line-height:1.4">
            <div><b>Route ${String(p.routeId ?? '?')}</b></div>
            ${p.label ? `<div>${String(p.label)}</div>` : ''}
            ${p.status ? `<div style="color:#555">${String(p.status)}</div>` : ''}
          </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on('mouseleave', 'buses-icon', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });
    });

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function frame() {
      rafRef.current = null;
      if (cancelled) return;
      const now = performance.now();
      const anims = animsRef.current;
      let stillAnimating = false;
      for (const a of anims.values()) {
        if (now - a.start < a.duration) {
          stillAnimating = true;
          break;
        }
      }
      if (sourceReadyRef.current && mapRef.current) {
        const src = mapRef.current.getSource('buses') as
          | maplibregl.GeoJSONSource
          | undefined;
        src?.setData(animsToGeoJson(anims, now));
      }
      if (stillAnimating) {
        rafRef.current = requestAnimationFrame(frame);
      }
    }

    function scheduleFrame() {
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(frame);
      }
    }

    async function tick() {
      try {
        const res = await fetch('/api/buses', { cache: 'no-store' });
        if (!res.ok) throw new Error(`api ${res.status}`);
        const json = (await res.json()) as BusesResponse;
        if (cancelled) return;

        const now = performance.now();
        const anims = animsRef.current;
        const seen = new Set<string>();
        for (const bus of json.buses) {
          seen.add(bus.id);
          const target: [number, number] = [bus.lng, bus.lat];
          const props = busProps(bus);
          const existing = anims.get(bus.id);
          if (!existing) {
            anims.set(bus.id, {
              from: target,
              to: target,
              start: now,
              duration: 0,
              props,
            });
            continue;
          }
          if (
            existing.to[0] === target[0] &&
            existing.to[1] === target[1]
          ) {
            existing.props = props;
            continue;
          }
          // Compute current interpolated position so the animation
          // restarts smoothly from wherever the dot is right now.
          const raw =
            existing.duration > 0
              ? (now - existing.start) / existing.duration
              : 1;
          const t = easeInOut(Math.max(0, Math.min(1, raw)));
          const curLng = existing.from[0] + (existing.to[0] - existing.from[0]) * t;
          const curLat = existing.from[1] + (existing.to[1] - existing.from[1]) * t;
          existing.from = [curLng, curLat];
          existing.to = target;
          existing.start = now;
          existing.duration = ANIMATE_DURATION_MS;
          existing.props = props;
        }
        for (const id of Array.from(anims.keys())) {
          if (!seen.has(id)) anims.delete(id);
        }

        const history = historyRef.current;
        for (const bus of json.buses) {
          const prev = history.get(bus.id);
          const point: [number, number] = [bus.lng, bus.lat];
          if (!prev) {
            history.set(bus.id, [point]);
            continue;
          }
          const last = prev[prev.length - 1];
          if (last[0] === point[0] && last[1] === point[1]) continue;
          prev.push(point);
          if (prev.length > TRAIL_MAX_POINTS) {
            prev.splice(0, prev.length - TRAIL_MAX_POINTS);
          }
        }
        for (const id of history.keys()) {
          if (!seen.has(id)) history.delete(id);
        }
        const trails = trailsToGeoJson(history);
        latestTrailsRef.current = trails;

        setBusCount(json.buses.length);
        setFeedTimestamp(json.feedTimestamp);
        setError(null);
        if (sourceReadyRef.current && mapRef.current) {
          const trailSrc = mapRef.current.getSource('bus-trails') as
            | maplibregl.GeoJSONSource
            | undefined;
          trailSrc?.setData(trails);
        }
        scheduleFrame();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'fetch failed');
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    }

    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      mapRef.current = null;
      sourceReadyRef.current = false;
      map.remove();
      maplibregl.removeProtocol('pmtiles');
    };
  }, []);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          background: 'rgba(14,17,22,0.85)',
          color: '#e6edf3',
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
          zIndex: 10,
        }}
      >
        <div style={{ fontWeight: 600 }}>Valley Metro live</div>
        <div>{busCount ?? '—'} vehicles</div>
        <div style={{ color: '#9aa4b2' }}>
          {feedTimestamp
            ? new Date(feedTimestamp * 1000).toLocaleTimeString()
            : 'loading…'}
        </div>
        {error ? <div style={{ color: '#f28e2b' }}>{error}</div> : null}
      </div>
    </div>
  );
}
