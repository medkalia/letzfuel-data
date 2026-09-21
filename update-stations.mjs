import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Overpass instances rate-limit and go down for maintenance regularly, which
// would fail an unattended scheduled run. Try each in turn, then come back
// round after a pause: a mirror that answers 502/504 under load is usually
// serving again a minute later, and the whole run is otherwise lost until the
// next weekly schedule.
//
// Every mirror listed here has to carry the whole planet. A regional extract
// answers 200 with an empty result for Luxembourg, which reads as a successful
// query rather than as the wrong server.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_ROUNDS = 4;
const OVERPASS_RETRY_DELAY_MS = 30_000;
// The query asks Overpass for at most 600s of server time; allow for a queued
// slot on top of that, but never let a hung connection stall the whole job.
// Belgium alone is ~3,000 stations and takes over a minute of server time, so
// the old 180s budget was not enough once it joined Luxembourg.
const OVERPASS_TIMEOUT_MS = 900_000;
// Two files from one run. LetzFuel 1.0 reads stations.snapshot.json and takes
// every station in it that is not French for a Luxembourg one, so Belgian
// stations there would each wear Luxembourg's regulated maximum. That file
// stays Luxembourg-only and unstamped, exactly as 1.0 knows it; releases from
// 1.1 on read the versioned file, which carries every country with its stamp.
const OUTPUT_FILE = fileURLToPath(
  new URL('./stations.v2.snapshot.json', import.meta.url),
);
const LEGACY_OUTPUT_FILE = fileURLToPath(
  new URL('./stations.snapshot.json', import.meta.url),
);

/**
 * The countries whose station locations ship with the app.
 *
 * These are the two where LetzFuel shows a nationally regulated maximum price
 * rather than a per-station one, so the map needs to know where the stations
 * are before it can put a price on them. France and Germany are absent on
 * purpose: their own feeds carry stations and prices together, so mirroring
 * their locations here would only duplicate — and eventually contradict — what
 * those feeds already say.
 */
const COUNTRIES = [
  {code: 'LU', name: 'Luxembourg'},
  {code: 'BE', name: 'Belgium'},
];

// One country at a time rather than one query for both: each is small enough
// to finish inside an Overpass slot, and a mirror that gives up on Belgium no
// longer takes Luxembourg down with it.
function queryFor(countryCode) {
  return `
[out:json][timeout:600];
area["ISO3166-1"="${countryCode}"][admin_level=2]->.country;
nwr["amenity"="fuel"](area.country)->.stations;
(
  .stations;
  nwr(around.stations:100)["amenity"~"^(car_wash|charging_station|atm|toilets|compressed_air|vacuum_cleaner|restaurant|fast_food)$"];
  nwr(around.stations:100)["shop"="convenience"];
);
out center tags meta;
`;
}

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

async function askOverpass(url, query) {
  const response = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams({data: query}),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'LetzFuel station snapshot generator',
    },
    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.elements) || payload.elements.length === 0) {
    throw new Error('returned no elements');
  }

  return payload;
}

async function queryOverpass(countryCode) {
  const query = queryFor(countryCode);
  const failures = new Map();

  for (let round = 1; round <= OVERPASS_ROUNDS; round += 1) {
    for (const url of OVERPASS_URLS) {
      try {
        const payload = await askOverpass(url, query);
        console.log(`Queried ${url} for ${countryCode} on attempt ${round}.`);
        return payload;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(
          `Overpass mirror ${url} failed for ${countryCode} on attempt ${round}: ${reason}`,
        );
        failures.set(url, reason);
      }
    }

    if (round < OVERPASS_ROUNDS) {
      // Back off further each round. The busiest mirror publishes a free slot
      // within about half a minute, so waiting costs far less than failing.
      const delay = OVERPASS_RETRY_DELAY_MS * round;
      console.warn(
        `Every Overpass mirror failed for ${countryCode} on attempt ${round}; retrying in ${
          delay / 1000
        }s.`,
      );
      await sleep(delay);
    }
  }

  const detail = [...failures]
    .map(([url, reason]) => `${url}: ${reason}`)
    .join('\n');

  throw new Error(
    `Every Overpass mirror failed ${OVERPASS_ROUNDS} times for ${countryCode}.\n${detail}`,
  );
}

function stationsFrom(result, countryCode) {
  const elements = result.elements ?? [];
  const nearby = elements
    .filter(element => element.tags?.amenity !== 'fuel')
    .map(element => ({
      coordinates: coordinates(element),
      service: nearbyService(element),
    }))
    .filter(item => item.coordinates && item.service);

  return elements
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
        // Stamped from the query that found it rather than inferred from the
        // coordinates afterwards: Luxembourg and Belgium share a border and
        // overlapping bounding boxes, so only the query knows which is which.
        country: countryCode,
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
}

/**
 * Stations already published for a country.
 *
 * The first run that adds a country has nothing to compare against, and
 * Luxembourg's own history predates the country stamp, so an unstamped
 * snapshot counts as Luxembourg — which is what it was.
 */
function previousCountryCount(previous, countryCode) {
  if (!previous) {
    return 0;
  }

  return previous.stations.filter(
    station => (station.country ?? 'LU') === countryCode,
  ).length;
}

async function main() {
  const previous = await readPreviousSnapshot();
  const collected = [];
  let osmTimestamp = null;

  for (const country of COUNTRIES) {
    const result = await queryOverpass(country.code);
    const stations = deduplicate(stationsFrom(result, country.code));

    // An Overpass mirror can answer 200 with a truncated result. Publishing
    // that unattended would silently delete stations from every installed
    // app, so refuse to shrink a country dramatically without a human looking
    // at it. Checked per country, so a good Luxembourg run cannot mask a
    // half-empty Belgium.
    const before = previousCountryCount(previous, country.code);
    if (before && stations.length < before * 0.9) {
      throw new Error(
        `Refusing to write ${stations.length} ${country.name} stations over ` +
          `the previous ${before}. Re-run, or pass --force if the drop is real.`,
      );
    }

    // The oldest of the per-country runs: the snapshot is only as current as
    // its least current part, and claiming otherwise would let the app treat
    // a stale half as fresh.
    const timestamp = result.osm3s?.timestamp_osm_base ?? null;
    if (timestamp && (!osmTimestamp || timestamp < osmTimestamp)) {
      osmTimestamp = timestamp;
    }

    collected.push({country, stations});
  }

  const uniqueStations = collected.flatMap(entry => entry.stations);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    osmTimestamp,
    attribution: '© OpenStreetMap contributors',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    stations: uniqueStations,
  };

  await mkdir(path.dirname(OUTPUT_FILE), {recursive: true});
  await writeFile(OUTPUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${uniqueStations.length} stations to ${OUTPUT_FILE}`);

  const legacyStations = uniqueStations
    .filter(station => station.country === 'LU')
    .map(({country: _country, ...station}) => station);
  await writeFile(
    LEGACY_OUTPUT_FILE,
    `${JSON.stringify({...snapshot, stations: legacyStations}, null, 2)}\n`,
  );
  console.log(
    `Wrote ${legacyStations.length} Luxembourg stations to ${LEGACY_OUTPUT_FILE}`,
  );

  for (const entry of collected) {
    console.log(`${entry.country.name} (${entry.country.code}):`);
    reportCoverage(entry.stations);
  }
}

async function readPreviousSnapshot() {
  if (process.argv.includes('--force')) {
    return null;
  }

  // Before the versioned file exists, the Luxembourg-only one is the history:
  // it is unstamped, which previousCountryCount already reads as Luxembourg.
  for (const file of [OUTPUT_FILE, LEGACY_OUTPUT_FILE]) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // Try the next one.
    }
  }
  return null;
}

/**
 * OpenStreetMap is the only free source that carries opening hours, services
 * and per-fuel availability for Luxembourg and Belgium, and its coverage is
 * uneven — noticeably more so across Belgium than across Luxembourg. Print it
 * per country on every run so a drop in quality is visible rather than silent.
 */
function reportCoverage(stations) {
  const share = predicate => {
    const count = stations.filter(predicate).length;
    return `${count}/${stations.length} (${Math.round(
      (count / stations.length) * 100,
    )}%)`;
  };

  console.log(`  stations:      ${stations.length}`);
  console.log(`  opening hours: ${share(station => station.openingHours)}`);
  console.log(`  fuel types:    ${share(station => station.fuelTypes.length)}`);
  console.log(`  services:      ${share(station => station.services.length)}`);
  console.log(`  brand:         ${share(station => station.brand)}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
