# Model presets

The extension reads `modelPresets` from Pi settings during startup. It loads the global settings file (`~/.pi/agent/settings.json`) first, then the project file (`.pi/settings.json` in the current working directory). The project section shallowly overrides matching top-level catalog fields; for example, a project `cycle` replaces the global `cycle`, while omitted fields such as `presets` remain from global settings. This is not a deep merge of nested preset entries.

Missing optional settings files are ignored. Unreadable files, malformed JSON, and non-object JSON are reported as actionable settings warnings; an invalid file is skipped, so a valid global catalog remains available when project settings are malformed. Catalog entry validation is reported separately by the catalog validator.

Configure the `modelPresets` object in either settings file using a keyed `presets` object and explicit `cycle` array. The package does not provide active presets by default; see the example in `packages/pi-config/settings.json`.