# Ember Laser Studio

Laser design and control software for GRBL lasers (built for the Creality Falcon2 12W). It runs two ways:

- **On a small box next to the laser** (Orange Pi Zero 4): the box holds the laser's USB connection and a webcam, and you design from any browser on your network. This is what the SD card image is.
- **As a desktop app** (Electron): `npm install`, then `npm run dev` or `npm run dist`.

## The box

1. Actions → **Release**: push a tag such as `v0.2.1` (it must match the `VERSION` file). This builds the program package and publishes it.
2. Actions → **Build SD card image** → Run workflow. It needs the stock Orange Pi Zero 4 image in a release called `base-image`. The result is the **Latest SD card image** release.
3. Write the image to an SD card, fill in `ember-config.txt` on the card's `EMBER` drive (Wi-Fi), and power the board on. `MY-ACCESS-LINK.txt` on that drive has the private link to open.

### Updates

The box checks the releases here every few hours. When a newer version exists, the app shows **Update available** and installs it when you press the button (or by itself when the laser is idle, if you turn that on). It never updates during a job, and goes back to the previous version if the new one cannot start.

## Development

```
npm ci
npm run typecheck
npm test
npm run build      # desktop app + server + screen
npm run serve      # run the box server on this computer (EMBER_CAMERA=test: for a test picture)
```

Settings for the server are environment variables: `PORT`, `EMBER_DATA`, `EMBER_CAMERA`, `EMBER_CAMERA_SIZE`, `EMBER_TOKEN`, `EMBER_REPO`, `EMBER_ROOT`, `EMBER_LINKFILE`.

Anyone who has the private link can run the laser. Keep it private and do not expose the box to the internet.
