# Zakho Private Records (desktop app)

Source of the patient-records program for Zakho Private Hospital (Electron).
Every push to the `records-app` branch with a new `version` in `package.json`
builds the Windows installer on GitHub Actions and publishes it as a release.
Installed copies check `releases/latest` and update themselves.
