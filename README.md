# LetzFuel station data

Fuel stations in Luxembourg and Belgium, derived from OpenStreetMap: location,
brand, address, opening hours, available fuels and on-site services.

Both files are regenerated weekly by
[a scheduled workflow](.github/workflows/refresh.yml) and read at runtime by the
LetzFuel apps, so improvements made in OpenStreetMap reach people without
waiting for an app release.

| File | Contents | Read by |
| --- | --- | --- |
| `stations.v2.snapshot.json` | Luxembourg and Belgium, each station stamped with `country` | LetzFuel 1.2 onwards |
| `stations.snapshot.json` | Luxembourg only, unstamped | LetzFuel 1.0 and 1.1 |

The Luxembourg-only file is frozen in shape for as long as 1.0 is installed:
1.0 treats every station it is given as Luxembourg's, so adding Belgium to it
would label Belgian forecourts with Luxembourg's regulated price. (1.1 reads it
too, but ignores it: it is smaller than the Luxembourg and Belgium copy 1.1
ships with.)

This repository is public because the apps fetch from it directly. It holds only
this derived dataset and the script that builds it.

## Attribution and licence

Data © OpenStreetMap contributors, available under the
[Open Database Licence](https://www.openstreetmap.org/copyright). Anything
produced from this file must carry the same attribution.

## Regenerating by hand

```bash
node update-stations.mjs
```

Requires only Node 18+ — no dependencies. The script queries several Overpass
mirrors in turn, refuses to write a result that would shrink any one country's
station list by more than 10% (pass `--force` if a drop is genuine), and prints
tag coverage so a fall in data quality is visible rather than silent.

## Shape

```jsonc
{
  "generatedAt": "2026-08-07T14:42:14.042Z", // when this file was built
  "osmTimestamp": "2026-08-07T14:40:21Z",    // the OSM base timestamp behind it
  "attribution": "© OpenStreetMap contributors",
  "licenseUrl": "https://www.openstreetmap.org/copyright",
  "stations": [
    {
      "id": "node/5077905459",               // OSM element type and id
      "name": "Aral",
      "brand": "Aral",
      "country": "LU",                       // v2 only: "LU" or "BE"
      "latitude": 49.622,
      "longitude": 6.049,
      "address": "…",
      "openingHours": "Mo-Su 06:00-22:00",   // OSM opening_hours syntax, when tagged
      "fuelTypes": ["Super 95", "Diesel"],
      "services": [
        { "id": "carWash", "label": "Car wash", "source": "station" }
      ],
      "osmUrl": "https://www.openstreetmap.org/node/5077905459"
    }
  ]
}
```

`services[].source` is `station` when the tag sits on the fuel station itself and
`nearby` when it comes from a separate feature within 80 m — a car wash next door
is not the same claim as one on the forecourt, so consumers should say which.

Fields are omitted when OpenStreetMap has no value for them. Coverage is uneven —
opening hours are present for roughly a quarter of stations — so treat a missing
field as unknown rather than as absent.
