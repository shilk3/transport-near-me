import { test } from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { Network } from '../lib/network.js';
import { indexFeed } from '../lib/realtime.js';
import { nearby } from '../lib/nearby.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const NOW = 1_800_000_000;
const HERE = [-33.8700, 151.2000];

// A station with two platforms inside the circle, a bus stop inside, and
// stops further out along the lines.
const network = new Network({
  builtAt: 'test',
  feeds: {
    sydneytrains: {
      mode: 'train',
      stops: [
        ['STN', 'Town Hall Station', -33.8730, 151.2065, '', 1],
        ['P1', 'Town Hall Station Platform 1', -33.8731, 151.2066, 'STN', 0],
        ['P2', 'Town Hall Station Platform 2', -33.8729, 151.2064, 'STN', 0],
        ['FAR1', 'Wynyard Station', -33.8660, 151.2060, '', 0],
        ['FAR2', 'Hornsby Station', -33.7040, 151.0990, '', 0],
      ],
      routes: { 'T1_a': ['T1', 'North Shore & Western Line', 'F99D1C'] },
    },
    buses: {
      mode: 'bus',
      stops: [
        ['B1', 'George St near Park St', -33.8705, 151.2010, '', 0],
        ['B0', 'Pyrmont Bridge Rd', -33.8700, 151.1850, '', 0],
        ['B9', 'Bondi Junction', -33.8910, 151.2470, '', 0],
      ],
      routes: { '2441_333': ['333', 'Circular Quay to North Bondi', ''] },
    },
  },
});

// Round-trip through protobuf so decoding of real feeds is exercised too.
function encodeDecode(obj) {
  const buf = FeedMessage.encode(FeedMessage.fromObject(obj)).finish();
  return FeedMessage.toObject(FeedMessage.decode(buf), { longs: Number, enums: Number });
}
const header = { gtfsRealtimeVersion: '2.0', timestamp: NOW };

const busTrips = encodeDecode({
  header,
  entity: [
    { id: 'a', tripUpdate: { trip: { tripId: 'bus-1', routeId: '2441_333' }, vehicle: { id: 'v1' }, stopTimeUpdate: [
      { stopId: 'B0', arrival: { time: NOW - 120, delay: 60 } },
      { stopId: 'B1', arrival: { time: NOW + 300, delay: 120 } },
      { stopId: 'B9', arrival: { time: NOW + 1500, delay: 120 } },
    ] } },
    // Arrives after the window closes
    { id: 'b', tripUpdate: { trip: { tripId: 'bus-2', routeId: '2441_333' }, stopTimeUpdate: [
      { stopId: 'B1', arrival: { time: NOW + 7200 } },
      { stopId: 'B9', arrival: { time: NOW + 8000 } },
    ] } },
    // Cancelled
    { id: 'c', tripUpdate: { trip: { tripId: 'bus-3', routeId: '2441_333', scheduleRelationship: 3 }, stopTimeUpdate: [
      { stopId: 'B1', arrival: { time: NOW + 200 } },
    ] } },
    // Skips the stop near us
    { id: 'd', tripUpdate: { trip: { tripId: 'bus-4', routeId: '2441_333' }, stopTimeUpdate: [
      { stopId: 'B1', scheduleRelationship: 1, arrival: { time: NOW + 200 } },
      { stopId: 'B9', arrival: { time: NOW + 900 } },
    ] } },
  ],
});
// Vehicle position keyed only by vehicle id, as some feeds do
const busVehicles = encodeDecode({
  header,
  entity: [{ id: 'v', vehicle: { vehicle: { id: 'v1', label: '333 bus' }, position: { latitude: -33.8702, longitude: 151.1900, bearing: 90 }, timestamp: NOW - 10 } }],
});

const trainTrips = encodeDecode({
  header,
  entity: [{ id: 't', tripUpdate: { trip: { tripId: 'train-1', routeId: 'T1_a' }, stopTimeUpdate: [
    { stopId: 'P1', arrival: { time: NOW + 600, delay: 0 } },
    { stopId: 'FAR1', departure: { time: NOW + 780 } },
    { stopId: 'FAR2', arrival: { time: NOW + 2400 } },
  ] } }],
});
const trainVehicles = encodeDecode({
  header,
  entity: [{ id: 'tv', vehicle: { trip: { tripId: 'train-1' }, position: { latitude: -33.88, longitude: 151.20 }, timestamp: NOW - 5 } }],
});

const trips = [
  ...indexFeed({ id: 'buses', mode: 'bus' }, busTrips, busVehicles),
  ...indexFeed({ id: 'sydneytrains', mode: 'train' }, trainTrips, trainVehicles),
];

const result = nearby({ network, trips, lat: HERE[0], lon: HERE[1], radius: 1000, windowS: 3600, now: NOW });

test('stops in radius roll platforms up to their station', () => {
  const ids = result.stops.map((s) => s.id).sort();
  assert.deepEqual(ids, ['B1', 'FAR1', 'STN']);
});

test('only trips reaching a nearby stop within the window are kept', () => {
  assert.deepEqual(result.trips.map((t) => t.key), ['buses:bus-1', 'sydneytrains:train-1']);
});

test('trip carries route, destination and live vehicle', () => {
  const bus = result.trips[0];
  assert.equal(bus.route.short, '333');
  assert.equal(bus.destination, 'Bondi Junction');
  assert.equal(bus.vehicle.label, '333 bus');
  assert.deepEqual(bus.calls.map((c) => [c.stopId, c.t, c.delay]), [['B1', NOW + 300, 120]]);
});

test('path starts inside the radius and runs to the end of the line', () => {
  const bus = result.trips[0];
  assert.deepEqual(bus.path, [[-33.8705, 151.2010], [-33.8910, 151.2470]]);
  // The stop it already passed is not part of the approach
  assert.deepEqual(bus.approach, [[-33.8702, 151.19], [-33.8705, 151.201]]);
});

test('train calls at two nearby stations and is matched by trip id', () => {
  const train = result.trips[1];
  assert.equal(train.destination, 'Hornsby Station');
  assert.deepEqual(train.calls.map((c) => c.stopId), ['STN', 'FAR1']);
  assert.equal(train.path.length, 3);
  assert.ok(train.vehicle);
  const stn = result.stops.find((s) => s.id === 'STN');
  assert.deepEqual(stn.arrivals, [{ key: 'sydneytrains:train-1', t: NOW + 600 }]);
});

test('approach runs from the vehicle through stops still ahead of it', () => {
  const extra = indexFeed({ id: 'buses', mode: 'bus' }, encodeDecode({ header, entity: [
    { id: 'e', tripUpdate: { trip: { tripId: 'bus-5', routeId: '2441_333' }, vehicle: { id: 'v1' }, stopTimeUpdate: [
      { stopId: 'B0', arrival: { time: NOW + 60 } },
      { stopId: 'B1', arrival: { time: NOW + 400 } },
    ] } },
  ] }), busVehicles);
  const r = nearby({ network, trips: extra, lat: HERE[0], lon: HERE[1], radius: 1000, windowS: 3600, now: NOW });
  assert.deepEqual(r.trips[0].approach, [[-33.8702, 151.19], [-33.87, 151.185], [-33.8705, 151.201]]);
});
