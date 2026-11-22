# Tree Plumb (phase one)
Single-phone lean meter. Draws a true plumb line from the phone's motion sensors, finds the tree by colour on the live camera, fits its centre line from row midpoints, shows lean in degrees (median over 2 s).

- `npm test` unit tests; `npm run build` then `npm run e2e` real-Chrome test with fake camera and sensors.
- `npm run serve` serves dist/ on 127.0.0.1:5180. Phones need https: `tailscale serve --bg --https=8443 http://127.0.0.1:5180` (tailnet only).
- Lean is the apparent lean seen from the phone's side; lean toward/away from the camera needs a second phone (phase two).
- Assumed camera field of view: 65 degrees on the long side (src/geometry.ts). Not measured per phone.
