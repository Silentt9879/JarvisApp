# vendor

`scrcpy-server-v3.3.3` - the device-side server of [scrcpy](https://github.com/Genymobile/scrcpy)
v3.3.3 (Apache License 2.0), from the official release:
https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3
SHA-256 `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0` (matches the
release's SHA256SUMS.txt).

The Devices view pushes it to a phone as `/data/local/tmp/jarvis-scrcpy-server-v3.3.3.jar` -
a different name from scrcpy's own, so the installed scrcpy (4.0) keeps working. It is 3.3.3
because that is the newest protocol the Tango client (`@yume-chan/adb-scrcpy`) speaks; update
both together.
