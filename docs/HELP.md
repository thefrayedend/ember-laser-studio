# Ember help

This file is generated from `src/core/help.ts`. Press the ? button in the app to read the same text there.

## Getting started

The quickest way to a first burn:

1. Plug the laser into the computer (or the laser box) and open the Device tab. Pick its port and press Connect.
2. In the Design tab, drop in an SVG or picture, or draw a shape from the left bar. Pictures turn into engravings; shapes get a layer: Engrave fills them, Cut follows the outline, Score draws a light line.
3. Pick a material in the layer settings, or run a material test first (see "Material tests") if the material is new to you.
4. Place a piece of material under the laser. Use the jog pad on the Device tab to move the head to where the design should start, then press "Set origin here".
5. Press Send. Check the preview, use "Frame design" on the Device tab if you want to see where it will burn, then slide the orange slider all the way across to start. It takes a deliberate swipe, so the laser can't be started by an accidental click.

Always stay with the laser while it runs. Keep a way to stop it in reach: the red STOP button, or the machine's own button.

## Making a design

Left bar tools: select, rectangle, ellipse, hexagon, star and text. The down-arrow button imports an SVG, picture or G-code file. You can also drag files onto the canvas.

- Move, resize and rotate objects with the handles, or type exact numbers in the panel on the right.
- Text uses real outline fonts, so it can be cut or engraved.
- Pictures can be traced into vector outlines so they can be cut or scored. Select the picture and use the trace option in its panel.
- Press Fit to see the whole bed. The grid shows millimetres.
- Save keeps everything in a project file (Ctrl+S). Open loads projects, SVGs, pictures and G-code.

## Layers and materials

Every object sits on a layer, and the layer decides what the laser does.

- Engrave fills closed shapes with lines and burns pictures. Cut follows outlines. Score follows outlines at light power.
- Layers burn from the top of the list to the bottom. Use the arrows to reorder them, the eye to hide one, and the flame to turn its output on or off.
- Speed, power and passes live in the layer's panel. Press "More settings" for line spacing, dither method (for pictures), overscan, air assist and cutting inner shapes first.
- The material menu fills in speed and power for common materials. These are starting points only: run a material test on a scrap to find the real values for your material.
- "Save as preset" stores the current layer settings under your own name, in "My presets".
- The speed unit switch changes between mm/min and mm/s everywhere.

## Connecting the laser

Device tab, Connection panel.

- USB: choose the port (Rescan if it is missing) and Connect. The Falcon2 uses 115200 baud.
- Telnet or WebSocket: connect to a network GRBL device by address.
- ESP32: connect to the board's address to run jobs from the board itself.
- Demo: a virtual laser that lets you try everything without hardware.

If the status chip at the top says "Not connected", click it to open the Device tab. If the port is missing on Linux, make sure your user is in the dialout group.

## Placing the job

In the Send dialog, "Where does the design go?" offers "Where the laser head is" (the default) and "Same spot as on the bed". With the first, you decide where the design lands by where you park the head.

1. Use the jog pad on the Device tab to move the head. Use the small steps for fine moves. Z up/down changes the focus height.
2. When the head is where the design should start, press "Set origin here" on the Device tab.
3. Use "Frame design" on the Device tab to trace the outline of the job with the laser off, so you can see where it will go.

In "Where the laser head is" mode the Send dialog also lets you choose which corner or the centre of the design sits on the head.

## Sending and running a job

Press Send, check the estimate and the notes, then slide the slider across to start. The checklist tells you if the design is outside the bed, the machine is not connected or idle, or laser mode is off. If your layer settings look risky (very slow and hot, lines too close together, lots of passes) Ember adds up to three short notes. They never block a job; they are there so you notice.

- The job bar at the bottom shows progress. Pause, resume and stop are there.
- Live adjust (Device tab) changes speed and power while a job runs, as a percentage.
- If a job is stopped or the connection drops, Ember remembers the line it reached. The Device tab offers "Resume" that moves back to that spot and carries on. Do not move the material in between.
- STOP resets the controller immediately. It is software, so also know where the machine's own stop is.

## Material tests

Press the ▦ button in the Design toolbar. Pick a test, check the numbers, and press Build test. The test appears in the Preview tab: place scrap of the real material, put the head where you want it, and send it like any job. Everything runs at the settings in the test, not your layers.

Run these on a scrap of the same material:

- Engraving: speed × power. Filled squares, speed changes across and power changes up the rows. The first test for any new material.
- Cutting: speed × power. Outlined squares. Find the slowest-needed, fastest-working combination that drops the square out cleanly.
- Focus. Prop the board on a ramp so the 15 lines sit at different heights. The thinnest, crispest line shows the best focus height. Measure the height there.
- Line spacing. One square at six spacings. Pick the widest spacing that still looks solid.
- Passes. The same cut once, twice, three and four times. Choose the fewest passes that cut through.
- Photo / dither. A gradient and a shaded ball in each dither method. Use the best looking method for pictures on that material.
- Fine detail. Tiny squares, holes and narrow gaps show the smallest detail your setup holds.
- Kerf and fit. Nine slots in tiny width steps. Enter the material thickness first, then push a scrap in each slot to find the snug one. Use that width in slots and tabs.
- Light marking. Single low-power lines for fold lines and marks.
- Air assist on/off. Left half without air, right half with. Compare edge cleanliness and smoke staining.

Tip: good first order for a new material is Engraving, then Cutting, then Focus if edges look soft.

## Rating a test with a photo

When a test job finishes, the "Rate a material test" window opens by itself. You can also open it with the ◩ button.

1. Take a photo. With the camera overlay set up it takes the picture itself and flattens it to a top-down view. Otherwise choose a photo you took from straight above with the whole test in view.
2. For squares tests: click the top-left corner and then the bottom-right corner of the whole grid. Ember measures each square (0 = like the plain material, 100 = black) and outlines its guess in yellow.
3. Click the square you like best. Name the material (for example "3 mm birch ply") and save. Ember stores the photo and makes a preset from that square's settings. Find it under "My presets" in the material menu.
4. For the other tests (focus, detail, kerf, marking, photo), write down what you found instead. The photo and your note are saved.

Saved tests are in the "Saved tests" tab: photo, date and result. Click a photo to see it large. Lighting changes the scores, so use the numbers as a guide. The library is stored in the browser or app you used, so each device keeps its own list.

## Camera overlay and calibration

The camera button (bottom-left of the canvas) shows your material under the design, so you can place designs on real pieces.

Easy way, using the laser ("Calibrate with the laser"):
1. Fix the camera so the whole bed is in view and do not move it afterwards.
2. Open the camera dialog and choose the camera. On the laser box choose "Camera on the laser box".
3. Start the laser calibration. The laser makes tiny, harmless flashes at a few points on the bed and the camera finds each one. If it misses one, click the dot yourself.
4. Press "Use these corners" and "Save and show". If the check point says it is far off, the lens bends the picture: mount the camera higher and run it again.

Manual way: click the four corners of the work area in the picture in the order shown.

Use the opacity slider to fade the picture, and the camera button to turn the overlay on and off. Wear laser safety glasses if the camera sees the laser flash, and keep the lid or enclosure closed.

## Running on the laser box

The box (an Orange Pi or similar) holds the USB connection to the laser and the webcam. You design from any browser on your network.

- Flash the SD card image from the GitHub "Latest SD card image" release, put it in the box and power on.
- Before flashing, put your Wi-Fi name and password in ember-config.txt on the small EMBER partition (it shows up as a drive).
- Open http://ember.local (or the address in MY-ACCESS-LINK.txt). The first time, use the OWNER LINK in that file to create the owner account. After that everyone just goes to the address and signs in with a name and password.
- Device tab: connect to the laser's port. In the camera dialog choose "Camera on the laser box".
- A job keeps running if you close the browser. Do not expose the box to the internet: passwords are sent unencrypted on your own network.
- Add people, give them roles and set a power cap on the Admin page (see "Admin: people and settings").

More detail is in SERVER.md.

## Admin: people and settings

Only the owner and other admins see the 👤 Admin button (laser box only).

- People: add a person with a name and password. Pick a role: Admin can do everything, User can design and run jobs, Viewer can only watch the camera and progress (and press STOP). Switch someone off to lock them out without deleting them, or reset their password.
- There is always at least one admin. You can't delete or demote the last one.
- Power cap: the most laser power any job from this box can use, as a percentage. Jobs asking for more are quietly lowered to the cap. It also limits the test dot and live power adjust. 100 means no cap.
- Updates and writing machine settings ($ settings) are admin-only.
- Forgot the owner password? Open the OWNER LINK from the file on the EMBER settings drive, then go to /setup on the box (for example http://ember.local/setup). Enter the owner's name and a new password.

## Updating

On the laser box a bar at the top appears when a new version is on GitHub: "Install now" updates when you click it, "Install automatically" lets the box update itself when the laser is idle.

- Updates never start while a job is running.
- If the new version fails to start, the box goes back to the previous version by itself.
- On a Windows computer, replace the files with the newest download and run the launcher, which rebuilds before it starts.

## Safety

A laser can start fires and damage eyes. Ember cannot see your material, so you are the safety system.

- Never leave a running laser alone. Keep a fire extinguisher and a way to cut power in reach.
- Wear the correct laser safety glasses, and use an enclosure or a shield when you can.
- Check the Preview before burning, and Frame the job to confirm placement.
- Material tests are the safe way to learn what a new material needs. Start at low power and work upward.
- Never burn PVC, vinyl or anything containing chlorine, or unknown plastics.
- Ember will not limit power unless the owner sets a power cap on the Admin page. Anyone with an account who can run jobs can start the laser from anywhere on your network, so only give accounts to people you trust and make sure someone is at the machine.

## If something goes wrong

- The screen looks old after an update: reload the page (Ctrl+F5). On Windows, run the launcher again so it rebuilds.
- The port is missing: press Rescan, try another cable, and on Linux check the dialout group.
- The head does not stop where expected: set the position again with "Set origin here", and check that the machine profile matches your laser.
- The burn is faint: slow down or raise power, check focus with the focus test, and clean the lens.
- Edges are scorched: raise speed, lower power, use air assist or more passes at lower power.
- The camera overlay is crooked: run the laser calibration again, and check the camera did not move.
- Locked out: ask the owner to reset your password on the Admin page. The owner can reset their own with the OWNER LINK (see Admin).
- Camera on the box is blank: check it is plugged into the powered hub and choose "Camera on the laser box".
