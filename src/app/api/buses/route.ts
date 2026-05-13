import { NextResponse } from 'next/server';

const FEED_URL = 'REDACTED';
const CACHE_TTL_MS = 5_000;

type GtfsRtResponse = {
  header?: { timestamp?: string };
  entity?: Array<{
    id?: string;
    vehicle?: {
      trip?: { tripId?: string; routeId?: string; directionId?: number };
      position?: {
        latitude?: number;
        longitude?: number;
        bearing?: number;
        speed?: number;
      };
      currentStatus?: string;
      stopId?: string;
      timestamp?: string;
      vehicle?: { id?: string; label?: string };
    };
  }>;
};

export type Bus = {
  id: string;
  routeId: string;
  directionId: number | null;
  lat: number;
  lng: number;
  bearing: number | null;
  speed: number | null;
  status: string | null;
  stopId: string | null;
  label: string | null;
  timestamp: number | null;
};

export type BusesResponse = {
  feedTimestamp: number | null;
  buses: Bus[];
};

let cache: { at: number; payload: BusesResponse } | null = null;
let inflight: Promise<BusesResponse> | null = null;

async function fetchFresh(): Promise<BusesResponse> {
  const res = await fetch(FEED_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`upstream ${res.status}`);
  }
  const json = (await res.json()) as GtfsRtResponse;

  const buses: Bus[] = [];
  for (const ent of json.entity ?? []) {
    const v = ent.vehicle;
    const pos = v?.position;
    if (!v || !pos) continue;
    const lat = pos.latitude;
    const lng = pos.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    buses.push({
      id: ent.id ?? v.vehicle?.id ?? `${lat},${lng}`,
      routeId: v.trip?.routeId ?? 'unknown',
      directionId: v.trip?.directionId ?? null,
      lat,
      lng,
      bearing: typeof pos.bearing === 'number' ? pos.bearing : null,
      speed: typeof pos.speed === 'number' ? pos.speed : null,
      status: v.currentStatus ?? null,
      stopId: v.stopId ?? null,
      label: v.vehicle?.label ?? null,
      timestamp: v.timestamp ? Number(v.timestamp) : null,
    });
  }

  return {
    feedTimestamp: json.header?.timestamp ? Number(json.header.timestamp) : null,
    buses,
  };
}

async function getCached(): Promise<BusesResponse> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (inflight) return inflight;
  inflight = fetchFresh()
    .then((payload) => {
      cache = { at: Date.now(), payload };
      return payload;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function GET() {
  try {
    const payload = await getCached();
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
