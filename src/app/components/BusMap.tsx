'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Bus, BusesResponse } from '@/app/api/buses/route';

const TILE_URL =
  'REDACTED';

const PHOENIX_CENTER: [number, number] = [-112.07, 33.45];
const POLL_INTERVAL_MS = 10_000;

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

function colorForRoute(routeId: string): string {
  let hash = 0;
  for (let i = 0; i < routeId.length; i += 1) {
    hash = (hash * 31 + routeId.charCodeAt(i)) | 0;
  }
  return ROUTE_PALETTE[Math.abs(hash) % ROUTE_PALETTE.length];
}

function busesToGeoJson(buses: Bus[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: buses.map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
      properties: {
        id: b.id,
        routeId: b.routeId,
        directionId: b.directionId,
        bearing: b.bearing ?? 0,
        speed: b.speed,
        status: b.status,
        label: b.label,
        color: colorForRoute(b.routeId),
      },
    })),
  };
}

export function BusMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sourceReadyRef = useRef(false);
  const latestDataRef = useRef<GeoJSON.FeatureCollection | null>(null);
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

    map.on('load', () => {
      map.addSource('buses', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'buses-halo',
        type: 'circle',
        source: 'buses',
        paint: {
          'circle-radius': 9,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.25,
        },
      });

      map.addLayer({
        id: 'buses-dot',
        type: 'circle',
        source: 'buses',
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
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
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#111',
          'text-halo-color': '#fff',
          'text-halo-width': 1.2,
        },
      });

      sourceReadyRef.current = true;

      if (latestDataRef.current) {
        const src = map.getSource('buses') as
          | maplibregl.GeoJSONSource
          | undefined;
        src?.setData(latestDataRef.current);
      }

      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      map.on('mouseenter', 'buses-dot', (e) => {
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
      map.on('mouseleave', 'buses-dot', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });
    });

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch('/api/buses', { cache: 'no-store' });
        if (!res.ok) throw new Error(`api ${res.status}`);
        const json = (await res.json()) as BusesResponse;
        if (cancelled) return;
        const data = busesToGeoJson(json.buses);
        latestDataRef.current = data;
        setBusCount(json.buses.length);
        setFeedTimestamp(json.feedTimestamp);
        setError(null);
        if (sourceReadyRef.current && mapRef.current) {
          const src = mapRef.current.getSource('buses') as
            | maplibregl.GeoJSONSource
            | undefined;
          src?.setData(data);
        }
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
