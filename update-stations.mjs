import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Overpass instances rate-limit and go down for maintenance regularly, which
// would fail an unattended scheduled run. Try each in turn before giving up.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
const OUTPUT_FILE = fileURLToPath(
  new URL('./stations.snapshot.json', import.meta.url),
);

const query = `
[out:json][timeout:180];
area["ISO3166-1"="LU"][admin_level=2]->.luxembourg;
nwr["amenity"="fuel"](area.luxembourg)->.stations;
(
  .stations;
  nwr(around.stations:100)["amenity"~"^(car_wash|charging_station|atm|toilets|compressed_air|vacuum_cleaner|restaurant|fast_food)$"];
  nwr(around.stations:100)["shop"="convenience"];
);
out center tags meta;
`;

const fuelTags = [
  ['fuel:octane_95', 'Super 95'],
  ['fuel:e10', 'Super 95 E10'],
  ['fuel:octane_98', 'Super 98'],
  ['fuel:octane_100', 'Super 100'],
  ['fuel:diesel', 'Diesel'],
  ['fuel:diesel:b7', 'Diesel B7'],
  ['fuel:diesel:b10', 'Diesel B10'],
  ['fuel:lpg', 'LPG'],
  ['fuel:cng', 'CNG'],
  ['fuel:lng', 'LNG'],
  ['fuel:h35', 'Hydrogen H35'],
  ['fuel:h70', 'Hydrogen H70'],
  ['fuel:electricity', 'EV charging'],
];

const nearbyServiceTags = [
  ['amenity', 'car_wash', 'carWash', 'Car wash'],
  ['amenity', 'charging_station', 'evCharging', 'EV charging'],
  ['amenity', 'atm', 'atm', 'ATM'],
  ['amenity', 'toilets', 'toilets', 'Toilets'],
  ['amenity', 'compressed_air', 'air', 'Air pump'],
  ['amenity', 'vacuum_cleaner', 'vacuum', 'Vacuum'],
  ['amenity', 'restaurant', 'food', 'Food'],
  ['amenity', 'fast_food', 'food', 'Food'],
  ['shop', 'convenience', 'shop', 'Shop'],
];

function coordinates(element) {
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;

  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? {latitude, longitude}
    : null;
}

function distanceMeters(a, b) {
  const toRadians = value => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;

  return earthRadius * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function isYes(value) {
  return value === 'yes' || value === 'designated' || value === 'customers';
}

function service(id, label, source) {
  return {id, label, source};
}

function directServices(tags) {
  const services = [];
  const add = (condition, id, label) => {
    if (condition && !services.some(item => item.id === id)) {
      services.push(service(id, label, 'station'));
    }
  };

  add(isYes(tags.car_wash), 'carWash', 'Car wash');
  add(tags.shop === 'convenience' || isYes(tags.shop), 'shop', 'Shop');
  add(isYes(tags.atm), 'atm', 'ATM');
  add(isYes(tags.toilets), 'toilets', 'Toilets');
  add(isYes(tags.compressed_air), 'air', 'Air pump');
  add(isYes(tags.vacuum_cleaner), 'vacuum', 'Vacuum');
  add(isYes(tags['fuel:electricity']), 'evCharging', 'EV charging');
  add(
    tags.amenity === 'restaurant' || tags.amenity === 'fast_food' || isYes(tags.food),
    'food',
    'Food',
  );

  return services;
}

function nearbyService(element) {
  const tags = element.tags ?? {};
  const match = nearbyServiceTags.find(
    ([key, value]) => tags[key] === value,
  );

  return match ? service(match[2], match[3], 'nearby') : null;
}

function address(tags) {
  if (tags['addr:full']) {
    return tags['addr:full'];
  }

  const street = [tags['addr:housenumber'], tags['addr:street']]
    .filter(Boolean)
    .join(' ');
  const city = [tags['addr:postcode'], tags['addr:city']]
    .filter(Boolean)
    .join(' ');

  return [street, city].filter(Boolean).join(', ') || undefined;
}

function detailScore(station) {
  return (
    station.fuelTypes.length * 2 +
    station.services.length * 2 +
    (station.address ? 2 : 0) +
    (station.openingHours ? 2 : 0) +
    (station.brand ? 1 : 0) +
    (station.phone ? 1 : 0) +
    (station.website ? 1 : 0)
  );
}

function normalizeKey(value) {
  return value
    .toLocaleLowerCase('en')
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

function deduplicate(stations) {
  const sorted = [...stations].sort((a, b) => detailScore(b) - detailScore(a));
  const kept = [];

  for (const station of sorted) {
    const key = normalizeKey(station.brand || station.name);
    const duplicate = kept.some(
      candidate =>
        normalizeKey(candidate.brand || candidate.name) === key &&
        distanceMeters(candidate, station) < 20,
    );

    if (!duplicate) {
      kept.push(station);
    }
  }

  return kept.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function queryOverpass() {
  const failures = [];

  for (const url of OVERPASS_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({data: query}),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'LetzFuel station snapshot generator',
        },
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload.elements) || payload.elements.length === 0) {
        throw new Error('returned no elements');
      }

      console.log(`Queried ${url}`);
      return payload;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Overpass mirror ${url} failed: ${reason}`);
      failures.push(`${url}: ${reason}`);
    }
  }

  throw new Error(`Every Overpass mirror failed.\n${failures.join('\n')}`);
}

async function main() {
  const result = await queryOverpass();
  const elements = result.elements ?? [];
  const nearby = elements
    .filter(element => element.tags?.amenity !== 'fuel')
    .map(element => ({
      coordinates: coordinates(element),
      service: nearbyService(element),
    }))
    .filter(item => item.coordinates && item.service);

  const stations = elements
    .filter(element => element.tags?.amenity === 'fuel')
    .map(element => {
      const tags = element.tags ?? {};
      const position = coordinates(element);

      if (
        !position ||
        ['no', 'private'].includes(tags.access) ||
        ['no', 'private'].includes(tags.motor_vehicle)
      ) {
        return null;
      }

      const services = directServices(tags);
      for (const item of nearby) {
        if (
          distanceMeters(position, item.coordinates) <= 80 &&
          !services.some(existing => existing.id === item.service.id)
        ) {
          services.push(item.service);
        }
      }

      return {
        id: `${element.type}/${element.id}`,
        name:
          tags.name ||
          tags.brand ||
          tags.operator ||
          'Fuel station',
        brand: tags.brand || undefined,
        brandWikidata: tags['brand:wikidata'] || undefined,
        latitude: position.latitude,
        longitude: position.longitude,
        address: address(tags),
        openingHours: tags.opening_hours || undefined,
        fuelTypes: fuelTags
          .filter(([key]) => isYes(tags[key]))
          .map(([, label]) => label),
        services,
        phone: tags['contact:phone'] || tags.phone || undefined,
        website: tags['contact:website'] || tags.website || undefined,
        osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      };
    })
    .filter(Boolean);

  const uniqueStations = deduplicate(stations);

  // An Overpass mirror can answer 200 with a truncated result. Publishing that
  // unattended would silently delete stations from every installed app, so
  // refuse to shrink the list dramatically without a human looking at it.
  const previous = await readPreviousSnapshot();
  if (previous && uniqueStations.length < previous.stations.length * 0.9) {
    throw new Error(
      `Refusing to write ${uniqueStations.length} stations over the previous ` +
        `${previous.stations.length}. Re-run, or pass --force if the drop is real.`,
    );
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    osmTimestamp: result.osm3s?.timestamp_osm_base ?? null,
    attribution: '© OpenStreetMap contributors',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    stations: uniqueStations,
  };

  await mkdir(path.dirname(OUTPUT_FILE), {recursive: true});
  await writeFile(OUTPUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${uniqueStations.length} stations to ${OUTPUT_FILE}`);
  reportCoverage(uniqueStations);
}

async function readPreviousSnapshot() {
  if (process.argv.includes('--force')) {
    return null;
  }

  try {
    return JSON.parse(await readFile(OUTPUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * OpenStreetMap is the only free source that carries opening hours, services
 * and per-fuel availability for Luxembourg, and its coverage is uneven. Print
 * it on every run so a drop in quality is visible rather than silent.
 */
function reportCoverage(stations) {
  const share = predicate => {
    const count = stations.filter(predicate).length;
    return `${count}/${stations.length} (${Math.round(
      (count / stations.length) * 100,
    )}%)`;
  };

  console.log(`  opening hours: ${share(station => station.openingHours)}`);
  console.log(`  fuel types:    ${share(station => station.fuelTypes.length)}`);
  console.log(`  services:      ${share(station => station.services.length)}`);
  console.log(`  brand:         ${share(station => station.brand)}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
