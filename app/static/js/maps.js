/* ==========================================================================
   maps.js — the three maps the system shows, on OpenStreetMap through the
   vendored Leaflet library (no API key, no account):

     SapsMap.picker    the complainant drops a pin where the incident happened
     SapsMap.view      staff see that pin
     SapsMap.stations  the public find a police station

   If the map tiles cannot be reached (offline, blocked), the page still works:
   the address typed in the form is what routes a report, and the pin is extra.
   ========================================================================== */

const SapsMap = (() => {
  const DURBAN = [-29.8587, 31.0218];
  const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  function base(elId, centre, zoom) {
    if (typeof L === 'undefined') return null;
    const el = document.getElementById(elId);
    if (!el) return null;
    const map = L.map(el, { scrollWheelZoom: false }).setView(centre, zoom);
    /* OpenStreetMap's tile policy requires each request to say which site it
       is for; without a Referer it answers with an "Access blocked" picture. */
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION,
                         referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
    /* A map created inside a hidden step has no size until it is shown. */
    setTimeout(() => map.invalidateSize(), 50);
    return map;
  }

  /* Address lookups, on OpenStreetMap's Nominatim service (no key). Its
     usage policy allows one request a second and no search-as-you-type, so
     callers look up a finished address, not each keystroke. Both answer null
     when nothing is found or the service cannot be reached. */
  const GEOCODER = 'https://nominatim.openstreetmap.org';
  const NEAR = '30.55,-29.55,31.25,-30.15';   // eThekwini: preferred, not required

  async function lookup(path, params) {
    try {
      const r = await fetch(`${GEOCODER}/${path}?${new URLSearchParams({ format: 'jsonv2', addressdetails: 1, ...params })}`,
        { headers: { Accept: 'application/json' }, referrerPolicy: 'strict-origin-when-cross-origin' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  /* "108 Maud Mfusi Street, Durban Central, Durban" from the parts Nominatim gives. */
  function addressLine(a) {
    if (!a) return '';
    const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(' ');
    const place = a.amenity || a.building || a.shop || a.tourism || '';
    /* a council ward ("eThekwini Ward 32") is not a suburb anyone would write */
    const suburb = [a.suburb, a.neighbourhood, a.quarter, a.village, a.township].find(v => v && !/\bward \d+/i.test(v)) || '';
    const town = a.city || a.town || a.municipality || '';
    return [street || place, suburb, town].filter((v, i, all) => v && all.indexOf(v) === i).join(', ');
  }

  function pin(latlng, colour) {
    return L.circleMarker(latlng, { radius: 9, weight: 3, color: colour || '#B4382C', fillColor: colour || '#B4382C', fillOpacity: .35 });
  }

  return {
    /* onPick(lat, lng) is called each time the pin moves; (null, null) when it is removed. */
    picker(elId, onPick) {
      const map = base(elId, DURBAN, 11);
      if (!map) return null;
      let marker = null;
      const place = (latlng, byHand) => {
        if (marker) marker.setLatLng(latlng); else marker = pin(latlng).addTo(map);
        onPick(Number(latlng.lat.toFixed(6)), Number(latlng.lng.toFixed(6)), byHand);
      };
      map.on('click', e => place(e.latlng, true));
      return {
        refresh() { map.invalidateSize(); },
        /* Puts the pin somewhere without a click, e.g. on an address just typed. */
        /* byHand: the person chose this exact spot (their own location), as a click would. */
        set(lat, lng, byHand) { place(L.latLng(lat, lng), !!byHand); map.setView([lat, lng], Math.max(map.getZoom(), 16)); },
        clear() { if (marker) { marker.remove(); marker = null; } onPick(null, null); }
      };
    },

    view(elId, lat, lng, label) {
      const map = base(elId, [lat, lng], 15);
      if (!map) return null;
      const m = pin([lat, lng]).addTo(map);
      if (label) m.bindPopup(label);
      return map;
    },

    stations(elId, stations, onSelect) {
      const withPlace = stations.filter(s => s.latitude != null && s.longitude != null);
      const map = base(elId, withPlace.length ? [withPlace[0].latitude, withPlace[0].longitude] : DURBAN, 10);
      if (!map) return null;
      const markers = {};
      withPlace.forEach(s => {
        markers[s.id] = pin([s.latitude, s.longitude], '#2451C4').addTo(map)
          .bindPopup(`<strong>${s.name.replace(/</g, '&lt;')}</strong><br>${(s.address || '').replace(/</g, '&lt;')}`);
        markers[s.id].on('click', () => onSelect && onSelect(s.id));
      });
      if (withPlace.length > 1) map.fitBounds(withPlace.map(s => [s.latitude, s.longitude]), { padding: [30, 30] });
      return {
        focus(id) {
          const s = withPlace.find(x => x.id === id);
          if (s) { map.setView([s.latitude, s.longitude], 17); markers[id].openPopup(); }
        }
      };
    },

    /* Where an address is: { lat, lng } or null. */
    async find(address) {
      const hits = await lookup('search', { q: address, countrycodes: 'za', viewbox: NEAR, limit: 1 });
      return hits && hits.length ? { lat: Number(hits[0].lat), lng: Number(hits[0].lon) } : null;
    },

    /* The address of a point, as one line, or '' if there is none. */
    async addressAt(lat, lng) {
      const hit = await lookup('reverse', { lat, lon: lng, zoom: 18 });
      return hit && !hit.error ? addressLine(hit.address) : '';
    },

    /* A directions link that opens the phone's maps app; needs no key. */
    directionsUrl(lat, lng) {
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    },
    /* Directions to a named place (a police station): the maps app finds its
       own listing for it, which is better than a point we placed by hand. */
    directionsTo(name, address) {
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([name, address].filter(Boolean).join(', '))}`;
    },
    placeUrl(lat, lng) {
      return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
    }
  };
})();
