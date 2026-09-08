# CMU motion data

The selected skeleton `09.asf` and run capture `09_01.amc` come from the
[Carnegie Mellon University Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu/).
The source was captured at 120 Hz. Kannon derives its lower-body locomotion from
source frames 15–103, retargeted to the original scout skeleton and retimed for
the game's movement speeds. The source data and these derived motions are not
original Kannon captures or CC0 assets.

The publisher's [usage FAQ](http://mocap.cs.cmu.edu/faqs.php) permits copying,
modification and redistribution. Its homepage permits use within commercial
products but prohibits selling the motion data directly, including after format
conversion. These files and derived motions must not be sold as a motion pack.
Code licensing does not replace these separate data terms.

Requested acknowledgement:

> The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.

Only the selected subject 09 skeleton and motion are retained. `provenance.json`
records their original URLs, retrieval times, byte counts and SHA-256 digests.
The original publisher endpoints use HTTP; the digests identify the retrieved
bytes and are not publisher-signed checksums.

The scout geometry, materials, armature, weapon poses, and Idle/Jump/Aim/Fire/
Reload/Heal actions are original Kannon work. The parser and retargeting scripts
were written for this project; no third-party implementation was downloaded.
